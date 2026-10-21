/**
 * Fastify adapter (v4/v5). No dependency on `fastify`: the plugin is typed
 * structurally. It is an *encapsulated* plugin — its catch-all content-type
 * parser leaves the body stream untouched for the ingress, and only affects the
 * routes it registers (sibling routes keep Fastify's JSON parser).
 *
 * @example
 * ```ts
 * import Fastify from 'fastify'
 * import { createIngress } from '@botmesh/server'
 * import { fastifyIngress } from '@botmesh/server/fastify'
 *
 * const app = Fastify()
 * app.register(fastifyIngress(createIngress({ routes: [{ path: '/webhook', provider }], bot })), { prefix: '/hooks' })
 * ```
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { serveNode } from '../node.js'
import type { Ingress } from '../types.js'

export interface FastifyRequestLike { raw: IncomingMessage }
export interface FastifyReplyLike { raw: ServerResponse; hijack(): unknown }

/** The parts of a Fastify instance the plugin uses. */
export interface FastifyInstanceLike {
  removeAllContentTypeParsers(): unknown
  addContentTypeParser(
    contentType: string,
    parser: (request: unknown, payload: unknown, done: (err: Error | null, body?: unknown) => void) => void,
  ): unknown
  route(options: {
    method: string[]
    url: string
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => void
  }): unknown
}

export type FastifyIngressPlugin = (instance: FastifyInstanceLike, opts: unknown, done: (err?: Error) => void) => void

/**
 * Fastify plugin registering one route per ingress path (webhooks + health).
 * Register it with `app.register(...)`; a `prefix` option is honoured.
 */
export function fastifyIngress(ingress: Ingress): FastifyIngressPlugin {
  return (instance, _opts, done) => {
    try {
      instance.removeAllContentTypeParsers()
      // Do not consume the stream: the ingress reads it with its own limits.
      instance.addContentTypeParser('*', (_request, _payload, parserDone) => parserDone(null))
      for (const path of ingress.paths) {
        instance.route({
          method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
          url: path,
          handler: (request, reply) => {
            reply.hijack()
            serveNode(ingress, request.raw, reply.raw, { path })
          },
        })
      }
      done()
    } catch (err) {
      done(err as Error)
    }
  }
}
