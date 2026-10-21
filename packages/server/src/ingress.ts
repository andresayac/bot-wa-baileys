import { BodyAbortedError, BodyTimeoutError, BodyTooLargeError, BodyUnavailableError } from './errors.js'
import type { Ingress, IngressLogger, IngressOptions, IngressRequest, IngressResponse, IngressRoute } from './types.js'

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
export const DEFAULT_BODY_TIMEOUT_MS = 10_000
export const DEFAULT_INGEST_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_CONCURRENT = 64

const noop = () => {}
const silentLogger: IngressLogger = { warn: noop, error: noop }

const TIMEOUT = Symbol('timeout')

/** Strip a trailing slash (except for `/`). */
export function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function text(status: number, body: string, extra?: Partial<IngressResponse>): IngressResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body, ...extra }
}

function json(status: number, value: unknown): IngressResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(value) }
}

function isStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function'
}

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`@botmesh/server: ${name} must be a positive number`)
  return value
}

// RFC 9110 token for header names; values may not contain CR, LF or NUL (nor other controls but HTAB).
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

function validHeader([name, value]: [string, unknown]): boolean {
  return typeof value === 'string' && HEADER_NAME.test(name) && HEADER_VALUE.test(value)
}

/** Map whatever `ingest` returned to a response. */
function fromIngestResult(result: unknown): IngressResponse {
  if (isStatus(result)) return text(result, '')
  if (result && typeof result === 'object') {
    const { status, body, headers } = result as { status?: unknown; body?: unknown; headers?: unknown }
    const code = isStatus(status) ? status : 200
    const extraHeaders = headers && typeof headers === 'object' ? Object.fromEntries(
      Object.entries(headers as Record<string, unknown>).filter(validHeader),
    ) as Record<string, string> : {}
    let res: IngressResponse
    if (body === undefined || body === null) res = text(code, '')
    else if (typeof body === 'string') res = text(code, body)
    else res = json(code, body)
    res.headers = { ...res.headers, ...extraHeaders }
    return res
  }
  return text(200, '')
}

function contentLength(headers: IngressRequest['headers']): number | undefined {
  const raw = headers['content-length']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined
  return Number(value)
}

/**
 * Build the framework-neutral ingress. Adapters (`createNodeHandler`,
 * `expressIngress`, `fastifyIngress`, `honoIngress`, `createFetchHandler`)
 * translate their request into an {@link IngressRequest} and write back the
 * {@link IngressResponse}.
 *
 * @example
 * ```ts
 * const ingress = createIngress({
 *   routes: [
 *     { path: '/webhook/whatsapp', provider: cloudApi },
 *     { path: '/webhook/telegram', provider: telegram, body: 'text' },
 *   ],
 *   bot,
 * })
 * createServer(createNodeHandler(ingress)).listen(3000)
 * ```
 */
export function createIngress(options: IngressOptions): Ingress {
  const maxBodyBytes = positive('maxBodyBytes', options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES)
  const bodyTimeoutMs = positive('bodyTimeoutMs', options.bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS)
  const ingestTimeoutMs = positive('ingestTimeoutMs', options.ingestTimeoutMs, DEFAULT_INGEST_TIMEOUT_MS)
  const maxConcurrent = positive('maxConcurrent', options.maxConcurrent, DEFAULT_MAX_CONCURRENT)
  const logger = options.logger ?? silentLogger
  const healthPath = options.healthPath === false ? undefined : normalizePath(options.healthPath ?? '/healthz')
  const readyPath = options.readyPath === false ? undefined : normalizePath(options.readyPath ?? '/readyz')

  const routes = new Map<string, IngressRoute>()
  const reserved = new Set([healthPath, readyPath].filter((p): p is string => !!p))
  for (const p of reserved) if (!p.startsWith('/')) throw new TypeError(`@botmesh/server: health path "${p}" must start with "/"`)
  for (const route of options.routes) {
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
      throw new TypeError(`@botmesh/server: route path "${String(route.path)}" must start with "/"`)
    }
    if (typeof route.provider?.ingest !== 'function') {
      throw new TypeError(`@botmesh/server: provider for "${route.path}" has no ingest() — socket providers (Baileys, Discord gateway) need no ingress`)
    }
    if (route.maxBodyBytes !== undefined) positive(`maxBodyBytes of "${route.path}"`, route.maxBodyBytes, 0)
    const path = normalizePath(route.path)
    if (routes.has(path) || reserved.has(path)) throw new TypeError(`@botmesh/server: duplicate path "${path}"`)
    routes.set(path, route)
  }
  const paths = Object.freeze([...routes.keys(), ...reserved])

  let inflight = 0
  let closing = false
  const idleWaiters = new Set<() => void>()
  const release = () => {
    inflight--
    if (inflight === 0) for (const w of [...idleWaiters]) w()
  }

  async function isReady(): Promise<boolean> {
    if (closing) return false
    if (options.bot && options.bot.getConnectionState() !== 'ready') return false
    if (options.readiness) {
      try { return (await options.readiness()) === true }
      catch (err) {
        logger.warn({ errName: errName(err) }, 'ingress readiness check failed')
        return false
      }
    }
    return true
  }

  async function readiness(): Promise<IngressResponse> {
    const ready = await isReady()
    const body: Record<string, unknown> = { status: ready ? 'ready' : 'not_ready' }
    if (options.bot) body.connection = options.bot.getConnectionState()
    if (closing) body.draining = true
    return json(ready ? 200 : 503, body)
  }

  async function webhook(req: IngressRequest, path: string, route: IngressRoute): Promise<IngressResponse> {
    const method = req.method.toUpperCase()
    const allow = route.provider.verifyChallenge ? 'GET, HEAD, POST' : 'POST'
    if ((method === 'GET' || method === 'HEAD') && route.provider.verifyChallenge) {
      const challenge = await route.provider.verifyChallenge(Object.fromEntries(req.query))
      if (typeof challenge !== 'string') {
        logger.warn({ method, path, status: 403 }, 'webhook verification rejected')
        return text(403, '')
      }
      logger.info?.({ method, path, status: 200 }, 'webhook verification accepted')
      return text(200, challenge)
    }
    if (method !== 'POST') return text(405, '', { headers: { allow, 'content-type': 'text/plain; charset=utf-8' } })

    if (closing) return text(503, 'shutting down', { headers: { 'retry-after': '1', 'content-type': 'text/plain; charset=utf-8' }, closeConnection: true })
    if (inflight >= maxConcurrent) {
      logger.warn({ method, path, status: 503, inflight }, 'webhook rejected: concurrency limit reached')
      return text(503, 'busy', { headers: { 'retry-after': '1', 'content-type': 'text/plain; charset=utf-8' } })
    }
    const limit = route.maxBodyBytes ?? maxBodyBytes
    const declared = contentLength(req.headers)
    if (declared !== undefined && declared > limit) {
      logger.warn({ method, path, status: 413, bytes: declared, limit }, 'webhook rejected: body too large')
      return text(413, 'payload too large', { closeConnection: true })
    }

    inflight++
    let released = false
    const done = () => { if (!released) { released = true; release() } }
    const started = Date.now()
    try {
      let raw: Buffer
      try {
        raw = await req.readBody(limit, bodyTimeoutMs)
      } catch (err) {
        done()
        return bodyFailure(err, method, path, limit)
      }
      let result: unknown
      try {
        result = route.provider.ingest!(route.body === 'text' ? raw.toString('utf8') : raw, req.headers)
      } catch (err) {
        done()
        return ingestFailure(err, method, path)
      }
      if (isPromiseLike(result)) {
        // The slot is held until the ingest really settles, even past the timeout.
        const settled = Promise.resolve(result)
        settled.then(done, done)
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ingestTimeoutMs) })
        try {
          result = await Promise.race([settled, timeout])
        } catch (err) {
          return ingestFailure(err, method, path)
        } finally {
          clearTimeout(timer)
        }
        if (result === TIMEOUT) {
          logger.error({ method, path, status: 503, timeoutMs: ingestTimeoutMs }, 'webhook ingest timed out')
          return text(503, 'timeout', { headers: { 'retry-after': '1', 'content-type': 'text/plain; charset=utf-8' } })
        }
      } else {
        done()
      }
      const res = fromIngestResult(result)
      logger.debug?.({ method, path, status: res.status, bytes: raw.length, durationMs: Date.now() - started }, 'webhook ingested')
      return res
    } catch (err) {
      done()
      throw err
    }
  }

  function bodyFailure(err: unknown, method: string, path: string, limit: number): IngressResponse {
    if (err instanceof BodyTooLargeError) {
      logger.warn({ method, path, status: 413, limit }, 'webhook rejected: body too large')
      return text(413, 'payload too large', { closeConnection: true })
    }
    if (err instanceof BodyTimeoutError) {
      logger.warn({ method, path, status: 408, timeoutMs: err.timeoutMs }, 'webhook rejected: body timeout')
      return text(408, 'request timeout', { closeConnection: true })
    }
    if (err instanceof BodyUnavailableError) {
      logger.error({ method, path, status: 500 }, 'raw body unavailable — mount the ingress before any body parser (express.json(), etc.)')
      return text(500, 'raw body unavailable')
    }
    if (err instanceof BodyAbortedError) {
      logger.debug?.({ method, path, status: 400 }, 'client aborted the webhook body')
      return text(400, '', { closeConnection: true })
    }
    logger.error({ method, path, status: 400, errName: errName(err) }, 'failed to read webhook body')
    return text(400, '', { closeConnection: true })
  }

  function ingestFailure(err: unknown, method: string, path: string): IngressResponse {
    // Only the error class is logged: messages (e.g. JSON.parse) can quote the body.
    if (err instanceof SyntaxError) {
      logger.warn({ method, path, status: 400, errName: errName(err) }, 'webhook body could not be parsed')
      return text(400, '')
    }
    logger.error({ method, path, status: 500, errName: errName(err) }, 'webhook ingest failed')
    return text(500, '')
  }

  return {
    paths,
    get inflight() { return inflight },
    get closing() { return closing },
    matches: (path) => {
      const p = normalizePath(path)
      return routes.has(p) || reserved.has(p)
    },
    isReady,
    async handle(req) {
      const path = normalizePath(req.path)
      const method = req.method.toUpperCase()
      if (path === healthPath || path === readyPath) {
        if (method !== 'GET' && method !== 'HEAD') return text(405, '', { headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } })
        return path === healthPath ? json(200, { status: 'ok' }) : readiness()
      }
      const route = routes.get(path)
      if (!route) return undefined
      try {
        return await webhook(req, path, route)
      } catch (err) {
        logger.error({ method, path, status: 500, errName: errName(err) }, 'webhook handling failed')
        return text(500, '')
      }
    },
    close(opts) {
      closing = true
      if (inflight === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined
        const finish = () => { clearTimeout(timer); idleWaiters.delete(finish); resolve() }
        idleWaiters.add(finish)
        if (opts?.timeoutMs !== undefined) timer = setTimeout(finish, opts.timeoutMs)
      })
    },
  }
}

function errName(err: unknown): string {
  if (err instanceof Error) return err.name
  return typeof err
}
