/**
 * Hono adapter. No dependency on `hono`: the middleware is typed structurally
 * over the web-standard `Request` exposed as `c.req.raw`, so it runs on every
 * Hono runtime with `Buffer` available (Node, Bun, Deno, Workers with nodejs_compat).
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { createIngress } from '@botmesh/server'
 * import { honoIngress } from '@botmesh/server/hono'
 *
 * const app = new Hono()
 * app.use('*', honoIngress(createIngress({ routes: [{ path: '/webhook', provider }], bot })))
 * ```
 */
import { serveFetch } from '../fetch.js'
import type { Ingress } from '../types.js'

export interface HonoContextLike { req: { raw: Request } }

export type HonoMiddleware = (c: HonoContextLike, next: () => Promise<void>) => Promise<Response | void>

/**
 * Hono middleware serving the ingress routes and health paths; other paths
 * fall through to `next()`. Mount it before anything that reads the body.
 */
export function honoIngress(ingress: Ingress): HonoMiddleware {
  return async (c, next) => {
    const response = await serveFetch(ingress, c.req.raw)
    if (response) return response
    await next()
  }
}
