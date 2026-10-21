import type { IncomingMessage, ServerResponse } from 'node:http'
import { readNodeBody, type NodeRequestLike } from './body.js'
import type { Ingress, IngressResponse } from './types.js'

/**
 * Bounds for discarding an unread request body before answering with
 * `Connection: close` (413, 503...). Closing a socket that still has unread
 * bytes makes the kernel send a TCP RST, and the client loses the response.
 */
export interface DrainOptions {
  /** Max body bytes discarded before giving up and resetting the socket. Default 8 MiB. */
  maxBytes?: number
  /** Max time spent discarding before giving up and resetting the socket. Default 5000 ms. */
  timeoutMs?: number
}

export interface ServeNodeOptions {
  /** Bounds for draining an unread body before a `Connection: close` response. */
  drain?: DrainOptions
  /**
   * Path to route on instead of the one parsed from `req.url` (used by the
   * Fastify adapter, where the prefix is already stripped by the router).
   */
  path?: string
  /** Called when no ingress route matches (Express `next`). Default: 404. */
  next?: () => void
}

export interface NodeHandlerOptions {
  /** Bounds for draining an unread body before a `Connection: close` response. */
  drain?: DrainOptions
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

const DEFAULT_DRAIN_BYTES = 8 * 1024 * 1024
const DEFAULT_DRAIN_MS = 5000

function write(req: IncomingMessage, res: ServerResponse, response: IngressResponse, drain: DrainOptions = {}): void {
  if (res.headersSent) { res.end(); return }
  // A stalled body (408) is not worth waiting for: answer right away.
  if (response.closeConnection && response.status !== 408 && !req.complete && !req.destroyed) {
    drainThenWrite(req, res, response, drain)
    return
  }
  writeNow(req, res, response)
}

/**
 * Discard the rest of the request body (bounded by bytes and time) so the
 * socket can close gracefully and the client actually reads the response.
 * Past the bounds the response is still written, then the socket is reset.
 */
function drainThenWrite(req: IncomingMessage, res: ServerResponse, response: IngressResponse, drain: DrainOptions): void {
  const maxBytes = drain.maxBytes ?? DEFAULT_DRAIN_BYTES
  const timeoutMs = drain.timeoutMs ?? DEFAULT_DRAIN_MS
  let drained = 0
  let done = false
  const finish = (complete: boolean) => {
    if (done) return
    done = true
    clearTimeout(timer)
    req.off('data', onData)
    req.off('end', onEnd)
    req.off('close', onClose)
    req.off('error', onClose)
    if (!complete) req.pause()
    try {
      writeNow(req, res, response, !complete)
    } catch {
      res.destroy()
    }
  }
  const onData = (chunk: Buffer | string) => {
    drained += chunk.length
    if (drained > maxBytes) finish(false)
  }
  const onEnd = () => finish(true)
  const onClose = () => finish(req.complete)
  const timer = setTimeout(() => finish(false), timeoutMs)
  req.on('data', onData)
  req.on('end', onEnd)
  req.on('close', onClose)
  req.on('error', onClose)
  req.resume()
}

function writeNow(req: IncomingMessage, res: ServerResponse, response: IngressResponse, reset = false): void {
  if (res.headersSent || res.destroyed) { res.end(); return }
  const headers: Record<string, string> = { ...response.headers }
  if (response.closeConnection) {
    headers.connection = 'close'
    // Unread body bytes must not be parsed as the next request on this socket.
    if (reset || !req.complete) res.once('finish', () => req.destroy())
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
    if (response) { write(req, res, response, opts.drain); return }
    if (opts.next) { opts.next(); return }
    write(req, res, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '' })
  }).catch(() => {
    // handle() never rejects by contract, but write() (e.g. an invalid header),
    // `next()` or a user `onNotFound` can throw: never let that become an
    // unhandled rejection that crashes the process or leaves the client hanging.
    try {
      write(req, res, { status: 500, headers: {}, body: '', closeConnection: true }, opts.drain)
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
 * import { createIngress, createNodeHandler } from '@botmesh/server'
 *
 * const ingress = createIngress({ routes: [{ path: '/webhook', provider }], bot })
 * createServer(createNodeHandler(ingress)).listen(3000)
 * ```
 */
export function createNodeHandler(ingress: Ingress, options: NodeHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    serveNode(ingress, req, res, {
      ...(options.drain ? { drain: options.drain } : {}),
      ...(options.onNotFound ? { next: () => options.onNotFound!(req, res) } : {}),
    })
  }
}
