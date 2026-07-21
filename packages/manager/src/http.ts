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

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BotManager } from './BotManager.js'

/** Options for {@link createManagerApi}. */
export interface ManagerApiOptions {
  /** URL prefix for every route, e.g. `'/api'` → `GET /api/bots`. */
  prefix?: string
}

/** The handler returned by {@link createManagerApi}. */
export type ManagerApiHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Build an HTTP handler exposing registry + lifecycle routes for `manager`.
 *
 * @example
 * ```ts
 * import { createServer } from 'node:http'
 * import { BotManager, createManagerApi } from '@bot-wa/manager'
 *
 * const manager = new BotManager()
 * createServer(createManagerApi(manager, { prefix: '/api' })).listen(3000)
 * ```
 */
export function createManagerApi(manager: BotManager, opts: ManagerApiOptions = {}): ManagerApiHandler {
  const prefix = normalizePrefix(opts.prefix ?? '')
  const esc = escapeRegExp(prefix)
  const reList = new RegExp(`^${esc}/bots/?$`)
  const reStart = new RegExp(`^${esc}/bots/([^/]+)/start/?$`)
  const reStop = new RegExp(`^${esc}/bots/([^/]+)/stop/?$`)
  const reOne = new RegExp(`^${esc}/bots/([^/]+)/?$`)

  return (req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const notFound = (message = 'not found'): void => send(404, { error: message })

    const method = (req.method ?? 'GET').toUpperCase()
    const path = pathnameOf(req.url)
    if (path === undefined) {
      send(400, { error: 'bad request: unparseable url' })
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
      return run(send, async () => {
        await manager.start(id)
        send(200, { id, running: manager.isRunning(id) })
      })
    }

    m = reStop.exec(path)
    if (m && method === 'POST') {
      const id = decodeId(m[1])
      if (!manager.has(id)) return notFound(`bot "${id}" not found`)
      return run(send, async () => {
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

/** Run an async route body; map rejections to `500 { error }`. */
function run(send: (status: number, body: unknown) => void, body: () => Promise<void>): void {
  body().catch((error: unknown) => {
    send(500, { error: error instanceof Error ? error.message : String(error) })
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
