import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

// Default to undici's fetch (not globalThis.fetch): the pinned Agent below comes
// from this same undici instance, and Node's built-in fetch uses a DIFFERENT
// bundled undici that rejects a foreign dispatcher (UND_ERR_INVALID_ARG).
const defaultFetch = undiciFetch as unknown as typeof globalThis.fetch

/** Error raised when an outbound request violates a safe-client policy. */
export class SecureHttpError extends Error {
  constructor(message: string, readonly code: SecureHttpErrorCode) {
    super(message)
    this.name = 'SecureHttpError'
  }
}

export type SecureHttpErrorCode =
  | 'INVALID_URL'
  | 'UNSAFE_URL'
  | 'UNSAFE_HOST'
  | 'TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'TOO_MANY_REDIRECTS'

export type HostResolver = (hostname: string) => Promise<readonly string[]>

export interface SecureFetchOptions extends RequestInit {
  /** Reject plain HTTP unless this is explicitly enabled. Defaults to false. */
  allowHttp?: boolean
  /** Permit loopback/private/link-local destinations. Intended only for tests or controlled networks. */
  allowPrivateHosts?: boolean
  /** Total time allowed for one request, including body consumption. Defaults to 15 seconds. */
  timeoutMs?: number
  /** Maximum accepted body size in bytes. Defaults to 16 MiB. */
  maxBytes?: number
  /** Number of redirect hops permitted. Defaults to 3. */
  maxRedirects?: number
  /** Override DNS resolution for tests or controlled egress gateways. */
  resolver?: HostResolver
  /** Override fetch for tests or custom dispatchers. */
  fetch?: typeof globalThis.fetch
}

export interface SecureFetchResponse {
  url: URL
  response: Response
  body: Buffer
}

/**
 * Fetch a URL only after validating its protocol, hostname and DNS results.
 * Redirects are followed manually, so every target gets the same validation.
 */
export async function secureFetch(input: string | URL, options: SecureFetchOptions = {}): Promise<SecureFetchResponse> {
  const {
    allowHttp = false,
    allowPrivateHosts = false,
    timeoutMs = 15_000,
    maxBytes = 16 * 1024 * 1024,
    maxRedirects = 3,
    resolver = resolvePublicHost,
    fetch: fetchImpl = defaultFetch,
    signal: parentSignal,
    ...init
  } = options

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SecureHttpError('timeoutMs must be positive', 'INVALID_URL')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new SecureHttpError('maxBytes must be a non-negative integer', 'INVALID_URL')
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new SecureHttpError('maxRedirects must be a non-negative integer', 'INVALID_URL')

  let url = parseUrl(input)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new SecureHttpError(`request timed out after ${timeoutMs}ms`, 'TIMEOUT')), timeoutMs)
  const abortParent = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', abortParent, { once: true })
  let headers = init.headers
  const dispatchers: Agent[] = []

  try {
    for (let redirects = 0; ; redirects += 1) {
      const addresses = await assertSafeTarget(url, { allowHttp, allowPrivateHosts, resolver })
      // Pin the socket to the exact address we just validated so undici cannot
      // re-resolve the hostname to a different (private) IP between check and
      // connect — the DNS-rebinding SSRF hole. Skipped only for the injected
      // custom fetch (tests), which ignores `dispatcher`.
      const dispatcher = pinnedDispatcher(addresses, allowPrivateHosts)
      if (dispatcher) dispatchers.push(dispatcher)
      let response: Response
      try {
        response = await fetchImpl(url.href, {
          ...init,
          headers,
          redirect: 'manual',
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit)
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof SecureHttpError) throw controller.signal.reason
        throw error
      }

      if (isRedirect(response.status)) {
        if (redirects >= maxRedirects) throw new SecureHttpError('too many redirects', 'TOO_MANY_REDIRECTS')
        const location = response.headers.get('location')
        if (!location) return { url, response, body: await readBody(response, maxBytes) }
        const previousOrigin = url.origin
        url = parseUrl(location, url)
        // Never forward credentials to a different origin on redirect (native
        // fetch strips these automatically; our manual loop must too).
        if (url.origin !== previousOrigin) headers = stripSensitiveHeaders(headers)
        continue
      }

      return { url, response, body: await readBody(response, maxBytes) }
    }
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', abortParent)
    for (const dispatcher of dispatchers) await dispatcher.close().catch(() => {})
  }
}

/**
 * Build an undici dispatcher whose DNS lookup returns ONLY the pre-validated
 * address — pinning the connection so it can't be rebound to a private IP.
 * Returns undefined when there is nothing safe to pin to.
 */
function pinnedDispatcher(addresses: readonly string[], allowPrivateHosts: boolean): Agent | undefined {
  const pin = addresses.find((address) => allowPrivateHosts || !isPrivateAddress(address))
  if (!pin) return undefined
  const family = isIP(pin) === 6 ? 6 : 4
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        if (!allowPrivateHosts && isPrivateAddress(pin)) {
          callback(new SecureHttpError(`blocked private host: ${pin}`, 'UNSAFE_HOST'), [])
          return
        }
        callback(null, [{ address: pin, family }])
      },
    },
  })
}

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

/** Drop credential headers (used when a redirect crosses to a different origin). */
function stripSensitiveHeaders(headers: RequestInit['headers']): Headers {
  const next = new Headers(headers)
  for (const name of SENSITIVE_HEADERS) next.delete(name)
  return next
}

export async function fetchBuffer(input: string | URL, options: SecureFetchOptions = {}): Promise<Buffer> {
  const result = await secureFetch(input, options)
  if (!result.response.ok) throw new SecureHttpError(`request failed: HTTP ${result.response.status}`, 'INVALID_URL')
  return result.body
}

export async function assertSafeTarget(
  url: URL,
  options: Pick<SecureFetchOptions, 'allowHttp' | 'allowPrivateHosts' | 'resolver'> = {},
): Promise<readonly string[]> {
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    throw new SecureHttpError('only HTTPS URLs are allowed', 'UNSAFE_URL')
  }
  if (url.username || url.password || !url.hostname) {
    throw new SecureHttpError('URL must not contain credentials and needs a hostname', 'UNSAFE_URL')
  }
  // Resolve once and return the addresses so the caller can PIN the connection
  // to a validated IP (defeating DNS rebinding). We resolve even when private
  // hosts are allowed, purely to have something to pin to.
  const addresses = await (options.resolver ?? resolvePublicHost)(url.hostname)
  if (options.allowPrivateHosts) return addresses

  if (isPrivateAddress(url.hostname)) throw new SecureHttpError(`blocked private host: ${url.hostname}`, 'UNSAFE_HOST')
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new SecureHttpError(`blocked unsafe DNS result for: ${url.hostname}`, 'UNSAFE_HOST')
  }
  return addresses
}

export async function resolvePublicHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  const family = isIP(normalized)
  if (family === 4) return isPrivateIpv4(normalized)
  if (family === 6) return isPrivateIpv6(normalized)
  return false
}

function parseUrl(input: string | URL, base?: URL): URL {
  try {
    return new URL(input, base)
  } catch {
    throw new SecureHttpError('invalid outbound URL', 'INVALID_URL')
  }
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
}

function isPrivateIpv6(address: string): boolean {
  if (address === '::' || address === '::1') return true
  if (address.startsWith('::ffff:')) return isPrivateIpv4(address.slice('::ffff:'.length))
  const first = Number.parseInt(address.split(':')[0] || '0', 16)
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new SecureHttpError(`response exceeds ${maxBytes} bytes`, 'RESPONSE_TOO_LARGE')
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) throw new SecureHttpError(`response exceeds ${maxBytes} bytes`, 'RESPONSE_TOO_LARGE')
    return buffer
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new SecureHttpError(`response exceeds ${maxBytes} bytes`, 'RESPONSE_TOO_LARGE')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}
