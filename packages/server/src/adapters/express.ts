/**
 * Express adapter (Express 4 and 5). No dependency on `express`: the
 * middleware is typed structurally over Node's request/response.
 *
 * Mount it BEFORE any body parser (`express.json()`), or behind
 * `express.raw()` — the ingress needs the exact bytes for signature checks.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { createIngress } from '@bot-wa/server'
 * import { expressIngress } from '@bot-wa/server/express'
 *
 * const app = express()
 * app.use(expressIngress(createIngress({ routes: [{ path: '/webhook', provider }], bot })))
 * app.use(express.json()) // your other routes
 * ```
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { serveNode } from '../node.js'
import type { Ingress } from '../types.js'

/** The parts of an Express request the adapter reads. */
export type ExpressRequestLike = IncomingMessage & { body?: unknown }

export type ExpressMiddleware = (req: ExpressRequestLike, res: ServerResponse, next: (err?: unknown) => void) => void

/**
 * Express middleware serving the ingress routes and health paths; every other
 * path falls through to `next()`. Paths are matched against `req.url`, i.e.
 * relative to where the middleware is mounted.
 */
export function expressIngress(ingress: Ingress): ExpressMiddleware {
  return (req, res, next) => {
    serveNode(ingress, req, res, { next: () => next() })
  }
}
