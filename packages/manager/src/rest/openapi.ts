/**
 * OpenAPI 3.1 document of the `/v1` REST API, generated from the route table
 * ({@link ROUTES}) so the docs cannot drift from the router.
 */

import { COMPONENT_SCHEMAS, ROUTES, API_SCOPES } from './spec.js'

/** Options of {@link buildOpenApiDocument}. */
export interface OpenApiOptions {
  /** URL prefix of the API. Default `'/v1'`. */
  prefix?: string
  /** `info.title`. Default `'bot-wa Manager API'`. */
  title?: string
  /** `info.version`. Default `'1.0.0'`. */
  version?: string
  /** `servers[].url` entries (e.g. `'https://bots.example.com'`). Default: a relative server. */
  servers?: string[]
}

/** An OpenAPI 3.1 document (plain JSON). */
export type OpenApiDocument = Record<string, unknown> & { openapi: '3.1.0'; paths: Record<string, Record<string, unknown>> }

const STATUS_TEXT: Record<number, string> = {
  400: 'Invalid request (validation errors in `error.details`).',
  401: 'Missing or invalid token.',
  403: 'The token lacks the required scope or tenant.',
  404: 'Not found (or not visible to this tenant).',
  409: 'Conflict.',
  413: 'Body too large.',
  415: 'Body must be application/json.',
  422: 'Idempotency-Key reused with a different request, or the provider refused the content.',
  429: 'Rate limited (see Retry-After).',
  500: 'Internal error.',
  501: 'The bot or manager does not support this operation.',
  503: 'Upstream provider rate limited.',
}

/** Build the OpenAPI 3.1 document. */
export function buildOpenApiDocument(opts: OpenApiOptions = {}): OpenApiDocument {
  const prefix = opts.prefix ?? '/v1'
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of ROUTES) {
    const params = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    }))
    const query = (route.query ?? []).map((q) => ({ name: q.name, in: 'query', required: q.required === true, schema: q.schema, description: q.description }))
    const mutating = route.method !== 'GET'
    const headers = mutating && route.scope
      ? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Replays the stored response of a previous identical request (24 h).' }]
      : []
    const errorStatuses = new Set<number>([...(route.scope ? [401, 403, 429] : [429]), ...(route.errors ?? []), ...(route.body ? [400, 413, 415] : []), ...(mutating && route.scope ? [422] : [])])
    const responses: Record<string, unknown> = {
      [String(route.success.status)]: route.success.schema
        ? { description: route.success.description, content: { 'application/json': { schema: route.success.schema } } }
        : { description: route.success.description },
    }
    for (const status of [...errorStatuses].sort()) {
      responses[String(status)] = { description: STATUS_TEXT[status] ?? 'Error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
    }
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: [route.tag],
      parameters: [...params, ...query, ...headers],
      responses,
      security: route.scope ? [{ bearerAuth: [route.scope] }, { apiKey: [route.scope] }] : [],
      ...(route.scope ? { 'x-required-scope': route.scope } : {}),
    }
    if (route.body) operation.requestBody = { required: true, content: { 'application/json': { schema: route.body } } }
    const fullPath = `${prefix}${route.path}`
    paths[fullPath] = { ...(paths[fullPath] ?? {}), [route.method.toLowerCase()]: operation }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: opts.title ?? 'bot-wa Manager API',
      version: opts.version ?? '1.0.0',
      description: 'Control plane of @bot-wa/manager: bots, lifecycle, messaging, conversations, JSON flows and metrics. '
        + 'Every response carries `X-Request-Id`; mutating routes accept `Idempotency-Key`; all routes are rate limited. '
        + `Token scopes: ${API_SCOPES.join(', ')} (or *).`,
    },
    jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    servers: (opts.servers?.length ? opts.servers : ['/']).map((url) => ({ url })),
    tags: ['system', 'bots', 'lifecycle', 'messaging', 'conversations', 'flows', 'metrics'].map((name) => ({ name })),
    paths,
    components: {
      schemas: COMPONENT_SCHEMAS,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: '`Authorization: Bearer <token>`' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
  }
}
