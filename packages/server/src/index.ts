/**
 * @bot-wa/server — webhook ingress for @bot-wa providers.
 *
 * Captures the raw body bytes (for signature checks), enforces body-size,
 * timeout and concurrency limits, routes GET handshakes / POST events to each
 * provider and serves `/healthz` + `/readyz`. Framework adapters live in the
 * `@bot-wa/server/express`, `/fastify` and `/hono` subpaths and import nothing
 * from those frameworks.
 */
export { createIngress, normalizePath, DEFAULT_MAX_BODY_BYTES, DEFAULT_BODY_TIMEOUT_MS, DEFAULT_INGEST_TIMEOUT_MS, DEFAULT_MAX_CONCURRENT } from './ingress.js'
export { createNodeHandler, serveNode, splitUrl } from './node.js'
export type { NodeHandlerOptions, ServeNodeOptions } from './node.js'
export { createFetchHandler, serveFetch } from './fetch.js'
export { readNodeBody, readWebBody } from './body.js'
export type { NodeRequestLike } from './body.js'
export { BodyTooLargeError, BodyTimeoutError, BodyUnavailableError, BodyAbortedError } from './errors.js'
export type {
  BotStateSource,
  Ingress,
  IngressHeaders,
  IngressLogger,
  IngressOptions,
  IngressRequest,
  IngressResponse,
  IngressRoute,
  WebhookProvider,
} from './types.js'
