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
  // An `abort` listener never fires for a signal that is already aborted.
  parentSignal?.throwIfAborted()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new SecureHttpError(`request timed out after ${timeoutMs}ms`, 'TIMEOUT')), timeoutMs)
  const abortParent = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', abortParent, { once: true })
  let headers = init.headers
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
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
          method,
          body,
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
        const location = response.headers.get('location')
        if (!location) return { url, response, body: await readBody(response, maxBytes) }
        // A followed redirect's body is never read: release it now, or its
        // connection stays busy (a server that never ends it would stall us).
        await response.body?.cancel().catch(() => {})
        if (redirects >= maxRedirects) throw new SecureHttpError('too many redirects', 'TOO_MANY_REDIRECTS')
        const previousOrigin = url.origin
        url = parseUrl(location, url)
        // Never forward credentials to a different origin on redirect (native
        // fetch strips these automatically; our manual loop must too).
        if (url.origin !== previousOrigin) headers = stripSensitiveHeaders(headers)
        if (rewritesToGet(response.status, method)) {
          method = 'GET'
          body = undefined
          const next = new Headers(headers)
          for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) next.delete(name)
          headers = next
        }
        continue
      }

      return { url, response, body: await readBody(response, maxBytes) }
    }
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', abortParent)
    // Every body was read or cancelled above, so nothing useful is left on these
    // connections: destroy (close() would wait on any stalled response).
    for (const dispatcher of dispatchers) await dispatcher.destroy().catch(() => {})
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
/** Credential-looking custom headers (`apikey`, `x-api-key`, `xi-api-key`, `x-auth-token`, ...). */
const SENSITIVE_HEADER_RE = /(?:api[-_]?key|token|secret|auth|signature|session|password)/i

/** Drop credential headers (used when a redirect crosses to a different origin). */
function stripSensitiveHeaders(headers: RequestInit['headers']): Headers {
  const next = new Headers(headers)
  for (const name of SENSITIVE_HEADERS) next.delete(name)
  for (const name of [...next.keys()]) if (SENSITIVE_HEADER_RE.test(name)) next.delete(name)
  return next
}

/** Fetch-spec method rewrite: 303 (and 301/302 after a POST) continue as a body-less GET. */
function rewritesToGet(status: number, method: string): boolean {
  if (status === 303) return method !== 'GET' && method !== 'HEAD'
  return (status === 301 || status === 302) && method === 'POST'
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

/** Expand an IPv6 literal (`::`, embedded dotted IPv4) into its 8 hextets, or undefined. */
function ipv6Hextets(address: string): number[] | undefined {
  let text = address.split('%')[0]!
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return undefined
    const [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number]
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((h) => Number.parseInt(h, 16)))
  const head = parse(halves[0]!)
  const tail = halves.length === 2 ? parse(halves[1]!) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined
  const words = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail]
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : undefined
}

const ipv4Of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`

function isPrivateIpv6(address: string): boolean {
  const w = ipv6Hextets(address)
  // Unparseable: fail closed.
  if (!w) return true
  const zeroUntil = (n: number) => w.slice(0, n).every((x) => x === 0)
  // ::/128 unspecified, ::1 loopback, ::/96 IPv4-compatible (deprecated, still routed by some stacks).
  if (zeroUntil(6)) return w[6] === 0 ? w[7]! <= 1 || isPrivateIpv4(ipv4Of(w[6]!, w[7]!)) : isPrivateIpv4(ipv4Of(w[6]!, w[7]!))
  // ::ffff:0:0/96 IPv4-mapped.
  if (zeroUntil(5) && w[5] === 0xffff) return isPrivateIpv4(ipv4Of(w[6]!, w[7]!))
  // 64:ff9b::/96 NAT64 well-known prefix and 64:ff9b:1::/48 local-use NAT64: judge the embedded IPv4.
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return isPrivateIpv4(ipv4Of(w[6]!, w[7]!))
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true
  // 2002::/16 6to4: the IPv4 lives in hextets 1-2.
  if (w[0] === 0x2002) return isPrivateIpv4(ipv4Of(w[1]!, w[2]!))
  // 2001::/32 Teredo (tunnels to an obfuscated IPv4), 2001:db8::/32 documentation.
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return true
  // 100::/64 discard-only.
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true
  const first = w[0]!
  // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local (deprecated), ff00::/8 multicast.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00
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
