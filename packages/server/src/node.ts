import type { IncomingMessage, ServerResponse } from 'node:http'
import { readNodeBody, type NodeRequestLike } from './body.js'
import type { Ingress, IngressResponse } from './types.js'

export interface ServeNodeOptions {
  /**
   * Path to route on instead of the one parsed from `req.url` (used by the
   * Fastify adapter, where the prefix is already stripped by the router).
   */
  path?: string
  /** Called when no ingress route matches (Express `next`). Default: 404. */
  next?: () => void
}

export interface NodeHandlerOptions {
  /** Called for unmatched paths instead of answering 404 (e.g. to chain another handler). */
  onNotFound?: (req: IncomingMessage, res: ServerResponse) => void
}

/** Split `req.url` into path + query without trusting it as an absolute URL. */
export function splitUrl(url: string | undefined): { path: string; query: URLSearchParams } {
  const raw = url ?? '/'
  const q = raw.indexOf('?')
  return {
    path: q >= 0 ? raw.slice(0, q) || '/' : raw || '/',
    query: new URLSearchParams(q >= 0 ? raw.slice(q + 1) : ''),
  }
}

function write(req: IncomingMessage, res: ServerResponse, response: IngressResponse): void {
  if (res.headersSent) { res.end(); return }
  const headers: Record<string, string> = { ...response.headers }
  if (response.closeConnection) {
    headers.connection = 'close'
    // Unread body bytes must not be parsed as the next request on this socket.
    res.once('finish', () => req.destroy())
  }
  const body = req.method === 'HEAD' ? '' : response.body
  headers['content-length'] = String(Buffer.byteLength(response.body))
  res.writeHead(response.status, headers)
  res.end(body)
}

/**
 * Serve one Node request through the ingress. Exposed for adapters; most apps
 * use {@link createNodeHandler} or a framework adapter instead.
 */
export function serveNode(ingress: Ingress, req: NodeRequestLike, res: ServerResponse, opts: ServeNodeOptions = {}): void {
  const { path, query } = splitUrl(req.url)
  ingress.handle({
    method: req.method ?? 'GET',
    path: opts.path ?? path,
    query,
    headers: req.headers,
    readBody: (limit, timeoutMs) => readNodeBody(req, limit, timeoutMs),
  }).then((response) => {
    if (response) { write(req, res, response); return }
    if (opts.next) { opts.next(); return }
    write(req, res, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '' })
  }).catch(() => {
    // handle() never rejects by contract, but write() (e.g. an invalid header),
    // `next()` or a user `onNotFound` can throw: never let that become an
    // unhandled rejection that crashes the process or leaves the client hanging.
    try {
      write(req, res, { status: 500, headers: {}, body: '', closeConnection: true })
    } catch {
      res.destroy()
    }
  })
}

/**
 * A `node:http` request listener serving the ingress routes and health paths.
 *
 * @example
 * ```ts
 * import { createServer } from 'node:http'
 * import { createIngress, createNodeHandler } from '@bot-wa/server'
 *
 * const ingress = createIngress({ routes: [{ path: '/webhook', provider }], bot })
 * createServer(createNodeHandler(ingress)).listen(3000)
 * ```
 */
export function createNodeHandler(ingress: Ingress, options: NodeHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    serveNode(ingress, req, res, options.onNotFound ? { next: () => options.onNotFound!(req, res) } : {})
  }
}
