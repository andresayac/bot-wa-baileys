/**
 * Zero-dependency HTTP API over a {@link BotManager}.
 *
 * `createManagerApi` returns a plain Node `http` request handler
 * (`(req, res) => void`) — mount it on `http.createServer`, or call it
 * directly from another framework. Uses `node:http` types only.
 *
 * Routes (with optional `prefix`, default `''`):
 * - `GET  {prefix}/bots`            → 200 `BotStatus[]`
 * - `GET  {prefix}/bots/:id`        → 200 `BotStatus` | 404
 * - `POST {prefix}/bots/:id/start`  → 200 `{ id, running }` | 404 | 500
 * - `POST {prefix}/bots/:id/stop`   → 200 `{ id, running }` | 404 | 500
 *
 * Every response is JSON.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BotManager } from './BotManager.js'

/** Options for {@link createManagerApi}. */
export interface ManagerApiOptions {
  /** URL prefix for every route, e.g. `'/api'` → `GET /api/bots`. */
  prefix?: string
  /**
   * Shared-secret authentication for the control plane. When set, EVERY request
   * must present the token or it is rejected with 401. Sent as
   * `Authorization: Bearer <token>` by default, or in the header named by
   * `auth.header` (compared case-insensitively, `Bearer ` prefix optional).
   *
   * When omitted the API is UNAUTHENTICATED: anyone who can reach the socket can
   * enumerate bots and start/stop them. A one-time warning is logged in that case.
   * Never expose an unauthenticated manager API to an untrusted network.
   */
  auth?: { token: string; header?: string }
  /**
   * Receives the error of a failed start/stop. The HTTP response only says
   * `"<action> failed"`: error messages can carry paths, hosts or tokens.
   */
  onError?: (error: unknown, info: { id: string; action: 'start' | 'stop' }) => void
}

/** Timing-safe string compare over fixed-length digests (the length is not a side channel). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** Extract the presented token from the configured header (`Bearer ` prefix optional). */
function presentedToken(req: IncomingMessage, headerName: string): string | undefined {
  const raw = req.headers[headerName.toLowerCase()]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return undefined
  // The auth scheme is case-insensitive (RFC 9110 §11.1): `bearer x` works too.
  const bearer = /^bearer\s+(.+)$/i.exec(value.trim())
  return bearer ? bearer[1]!.trim() : value.trim()
}

let warnedUnauthenticated = false

/** The handler returned by {@link createManagerApi}. */
export type ManagerApiHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Build an HTTP handler exposing registry + lifecycle routes for `manager`.
 *
 * @example
 * ```ts
 * import { createServer } from 'node:http'
 * import { BotManager, createManagerApi } from '@botmesh/manager'
 *
 * const manager = new BotManager()
 * const api = createManagerApi(manager, { prefix: '/api', auth: { token: process.env.MANAGER_TOKEN! } })
 * createServer(api).listen(3000)
 * // → callers must send `Authorization: Bearer <MANAGER_TOKEN>`
 * ```
 */
export function createManagerApi(manager: BotManager, opts: ManagerApiOptions = {}): ManagerApiHandler {
  const prefix = normalizePrefix(opts.prefix ?? '')
  const esc = escapeRegExp(prefix)
  const reList = new RegExp(`^${esc}/bots/?$`)
  const reHealth = new RegExp(`^${esc}/health/?$`)
  const reMetrics = new RegExp(`^${esc}/metrics/?$`)
  const reStart = new RegExp(`^${esc}/bots/([^/]+)/start/?$`)
  const reStop = new RegExp(`^${esc}/bots/([^/]+)/stop/?$`)
  const reOne = new RegExp(`^${esc}/bots/([^/]+)/?$`)

  const auth = opts.auth
  if (auth && (typeof auth.token !== 'string' || auth.token.trim() === '')) {
    // Usually `{ token: process.env.MANAGER_TOKEN! }` with the variable unset: fail at startup,
    // not with a TypeError on every request.
    throw new TypeError('createManagerApi: auth.token must be a non-empty string (is the token env var set?)')
  }
  const authHeader = auth?.header ?? 'authorization'
  if (!auth && !warnedUnauthenticated) {
    warnedUnauthenticated = true
    // eslint-disable-next-line no-console
    console.warn(
      '[botmesh/manager] createManagerApi() has no `auth` token — the control plane is UNAUTHENTICATED. ' +
        'Anyone who can reach this socket can start/stop your bots. Pass { auth: { token } } or keep it off untrusted networks.',
    )
  }

  return (req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const sendText = (status: number, body: string): void => {
      res.writeHead(status, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
      res.end(body)
    }
    const notFound = (message = 'not found'): void => send(404, { error: message })

    const method = (req.method ?? 'GET').toUpperCase()
    const path = pathnameOf(req.url)
    if (path === undefined) {
      send(400, { error: 'bad request: unparseable url' })
      return
    }

    // Auth gate — applies to every route when a token is configured.
    if (auth) {
      const token = presentedToken(req, authHeader)
      if (!token || !safeEqual(token, auth.token)) {
        send(401, { error: 'unauthorized' })
        return
      }
    }

    if (method === 'GET' && reHealth.test(path)) {
      const bots = manager.list()
      send(200, { status: 'ok', bots: bots.length, running: bots.filter((bot) => bot.running).length })
      return
    }

    if (method === 'GET' && reMetrics.test(path)) {
      const bots = manager.list()
      const running = bots.filter((bot) => bot.running).length
      sendText(200, [
        '# HELP botwa_manager_bots_registered Registered bots.',
        '# TYPE botwa_manager_bots_registered gauge',
        `botwa_manager_bots_registered ${bots.length}`,
        '# HELP botwa_manager_bots_running Running bots.',
        '# TYPE botwa_manager_bots_running gauge',
        `botwa_manager_bots_running ${running}`,
        '',
      ].join('\n'))
      return
    }

    if (method === 'GET' && reList.test(path)) {
      send(200, manager.list())
      return
    }

    let m = reStart.exec(path)
    if (m && method === 'POST') {
      const id = decodeId(m[1])
      if (!manager.has(id)) return notFound(`bot "${id}" not found`)
      return run(send, { id, action: 'start' }, opts.onError, async () => {
        await manager.start(id)
        send(200, { id, running: manager.isRunning(id) })
      })
    }

    m = reStop.exec(path)
    if (m && method === 'POST') {
      const id = decodeId(m[1])
      if (!manager.has(id)) return notFound(`bot "${id}" not found`)
      return run(send, { id, action: 'stop' }, opts.onError, async () => {
        await manager.stop(id)
        send(200, { id, running: manager.isRunning(id) })
      })
    }

    m = reOne.exec(path)
    if (m && method === 'GET') {
      const id = decodeId(m[1])
      const status = manager.status(id)
      if (!status) return notFound(`bot "${id}" not found`)
      send(200, status)
      return
    }

    notFound()
  }
}

/** Run an async route body; map rejections to a generic `500 { error }` (details go to `onError`). */
function run(
  send: (status: number, body: unknown) => void,
  info: { id: string; action: 'start' | 'stop' },
  onError: ManagerApiOptions['onError'],
  body: () => Promise<void>,
): void {
  body().catch((error: unknown) => {
    try { onError?.(error, info) } catch { /* a throwing hook must not hang the request */ }
    send(500, { error: `${info.action} failed` })
  })
}

function pathnameOf(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? '/', 'http://manager.local').pathname
  } catch {
    return undefined
  }
}

function normalizePrefix(raw: string): string {
  let p = raw.trim()
  if (!p) return ''
  if (!p.startsWith('/')) p = `/${p}`
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
