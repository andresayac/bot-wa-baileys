/**
 * `/v1` REST API of the manager (feature #25) — zero dependencies, `node:http` only.
 *
 * - Token auth with scopes and tenant isolation (`Authorization: Bearer` or `X-API-Key`).
 * - `X-Request-Id` on every response (a sane incoming one is echoed, otherwise generated).
 * - Token-bucket rate limiting per token (per client address for anonymous calls).
 * - `Idempotency-Key` replay for mutating routes.
 * - JSON body limit (`413`), content-type check (`415`), JSON error envelope.
 * - OpenAPI 3.1 document at `GET /v1/openapi.json`.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  OutsideSessionWindowError,
  PayloadTooLargeError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type OutboundContent,
  type StoredMessage,
} from '@bot-wa/core'
import { assertSafeTarget, type HostResolver } from '@bot-wa/http'
import type { BotManager, BotStatus } from '../BotManager.js'
import { CapabilityError, capability, requireCapability } from '../capabilities.js'
import { ManagerError } from '../errors.js'
import { redactSecrets } from '../redact.js'
import { FlowDocumentError } from '../flows/compile.js'
import { FLOW_DOCUMENT_SCHEMA } from '../flows/schema.js'
import { MemoryIdempotencyStore, TokenBucketRateLimiter, type IdempotencyStore, type RateLimiter, type StoredResponse, type TokenBucketOptions, type MemoryIdempotencyOptions } from './limits.js'
import { buildOpenApiDocument, type OpenApiOptions } from './openapi.js'
import { API_SCOPES, ROUTES, type ApiScope } from './spec.js'

/** An API token. Compare-safe: tokens are matched through SHA-256 digests in constant time. */
export interface RestApiToken {
  /** Stable id used for rate limiting, idempotency and logs (never the secret). */
  id: string
  /** The secret presented by clients. Use at least 32 random bytes. */
  token: string
  /** Tenant the token may see. `'*'` or omitted = every tenant (operator token). */
  tenantId?: string
  /** Granted scopes; `'*'` = all. */
  scopes: ReadonlyArray<ApiScope | '*'>
}

/** Options of {@link createRestApi}. */
export interface RestApiOptions {
  /** At least one token is required: the API has no unauthenticated mode (except health/docs). */
  tokens: readonly RestApiToken[]
  /** URL prefix. Default `'/v1'`. */
  prefix?: string
  /** Serve `openapi.json` and `flows/schema` without a token. Default `true`. */
  publicDocs?: boolean
  /** Max JSON body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number
  /** Token bucket options, a custom limiter, or `false` to disable. Default 60 burst, 1 req/s. */
  rateLimit?: TokenBucketOptions | RateLimiter | false
  /** Idempotency options, a custom store, or `false` to disable. Default in-memory, 24 h. */
  idempotency?: MemoryIdempotencyOptions | IdempotencyStore | false
  /** Tenant of bots registered without one (`manager.add()` without `tenantId`). Default `'default'`. */
  defaultTenantId?: string
  /** OpenAPI `info`/`servers` overrides. */
  openapi?: Omit<OpenApiOptions, 'prefix'>
  /** Media URLs accepted by `send`: only `https:` by default; set `true` to also accept `http:`. */
  allowInsecureMediaUrls?: boolean
  /**
   * Accept media URLs whose host is (or resolves to) a loopback, private,
   * link-local or otherwise internal address. Default `false`: some transports
   * (Baileys) download `{ url }` media themselves, so an internal URL would let
   * an API client make the bot fetch from your private network (SSRF). This
   * check only sees the first host: redirects are vetted by the transport
   * (`@bot-wa/baileys` downloads through `@bot-wa/http`).
   */
  allowPrivateMediaHosts?: boolean
  /** DNS resolver used to vet media hosts (tests, egress gateways). Default: the system resolver. */
  mediaHostResolver?: HostResolver
}

/** Node-style handler; calls `next()` (when given) for paths outside the prefix. */
export type RestApiHandler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void

interface Principal { id: string; tenantId: string | '*'; scopes: ReadonlySet<string> }

interface RouteContext {
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  principal?: Principal
  requestId: string
}

interface Result { status: number; body?: unknown; headers?: Record<string, string> }

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown, readonly headers?: Record<string, string>) {
    super(message)
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,200}$/
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker'])
const MESSAGE_PAGE_MAX = 200

/**
 * Build the `/v1` REST handler.
 *
 * @example
 * ```ts
 * import { createServer } from 'node:http'
 * import { BotManager, createRestApi } from '@bot-wa/manager'
 *
 * const manager = new BotManager({ factory, persistence: { dir: './data/bots' }, autoReconnect: true })
 * await manager.restore()
 * const api = createRestApi(manager, {
 *   tokens: [
 *     { id: 'ops', token: process.env.OPS_TOKEN!, scopes: ['*'] },
 *     { id: 'acme', token: process.env.ACME_TOKEN!, tenantId: 'acme', scopes: ['bots:read', 'messages:send'] },
 *   ],
 * })
 * createServer(api).listen(3000)
 * ```
 */
export function createRestApi(manager: BotManager, options: RestApiOptions): RestApiHandler {
  if (!options || !Array.isArray(options.tokens) || options.tokens.length === 0) {
    throw new Error('createRestApi() needs at least one token: the REST API has no unauthenticated mode')
  }
  const tokens = options.tokens.map((t) => {
    if (!t.id || typeof t.token !== 'string' || t.token.length < 16) throw new Error(`token "${t.id ?? '?'}" must have an id and a secret of at least 16 characters`)
    for (const s of t.scopes) if (s !== '*' && !API_SCOPES.includes(s)) throw new Error(`token "${t.id}" has an unknown scope "${s}"`)
    return { digest: sha256(t.token), principal: { id: t.id, tenantId: t.tenantId ?? '*', scopes: new Set<string>(t.scopes) } satisfies Principal }
  })
  const prefix = normalizePrefix(options.prefix ?? '/v1')
  const publicDocs = options.publicDocs !== false
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
  const defaultTenant = options.defaultTenantId ?? 'default'
  const limiter: RateLimiter | undefined = options.rateLimit === false ? undefined
    : isRateLimiter(options.rateLimit) ? options.rateLimit : new TokenBucketRateLimiter(options.rateLimit ?? {})
  const idempotency: IdempotencyStore | undefined = options.idempotency === false ? undefined
    : isIdempotencyStore(options.idempotency) ? options.idempotency : new MemoryIdempotencyStore(options.idempotency ?? {})
  const openapi = buildOpenApiDocument({ ...options.openapi, prefix })
  const startedAt = Date.now()
  const compiled = ROUTES.map((spec) => ({ spec, re: compilePath(prefix + spec.path), names: [...spec.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]) }))

  // ── tenancy helpers ──────────────────────────────────────────────────
  const tenantOf = (status: BotStatus) => status.tenantId ?? defaultTenant
  const visible = (p: Principal | undefined, status: BotStatus) => !p || p.tenantId === '*' || p.tenantId === tenantOf(status)
  const botFor = (ctx: RouteContext): BotStatus => {
    const status = manager.status(ctx.params.botId)
    if (!status || !visible(ctx.principal, status)) throw new HttpError(404, 'NOT_FOUND', `bot "${ctx.params.botId}" not found`)
    return status
  }
  const detail = (id: string) => {
    const status = publicStatus(manager.status(id)!)
    return { ...status, connection: manager.connection(id)?.state ?? 'unknown', config: redactConfig(manager.getConfig(id)) }
  }
  const lifecycle = (action: 'start' | 'stop' | 'restart') => async (ctx: RouteContext): Promise<Result> => {
    const { id } = botFor(ctx)
    try {
      if (action === 'restart') await manager.restart(id)
      else await manager[action](id)
    } catch (error) {
      if (error instanceof ManagerError || error instanceof CapabilityError) throw error
      throw new HttpError(500, 'LIFECYCLE_FAILED', `${action} failed`)
    }
    return ok(publicStatus(manager.status(id)!))
  }

  const vetMediaHost = async (media: { url: string }): Promise<void> => {
    try {
      await assertSafeTarget(new URL(media.url), {
        allowHttp: options.allowInsecureMediaUrls === true,
        allowPrivateHosts: options.allowPrivateMediaHosts === true,
        ...(options.mediaHostResolver ? { resolver: options.mediaHostResolver } : {}),
      })
    } catch {
      throw invalid('content.media url must point to a public host')
    }
  }

  // ── route handlers ───────────────────────────────────────────────────
  const handlers: Record<string, (ctx: RouteContext) => Promise<Result> | Result> = {
    getHealth: () => ok({ status: 'ok', uptimeMs: Date.now() - startedAt }),
    getOpenApi: () => ({ status: 200, body: openapi, headers: { 'cache-control': 'public, max-age=300' } }),
    getFlowSchema: () => ({ status: 200, body: FLOW_DOCUMENT_SCHEMA, headers: { 'cache-control': 'public, max-age=300' } }),
    getManagerMetrics: (ctx) => {
      const items = manager.list().filter((s) => visible(ctx.principal, s)).map((s) => manager.metrics(s.id)!)
      return ok({
        bots: items.length,
        running: items.filter((m) => m.running).length,
        messagesIn: items.reduce((n, m) => n + m.messagesIn, 0),
        items,
      })
    },
    listBots: (ctx) => {
      const tenant = ctx.query.get('tenantId')
      if (tenant && ctx.principal!.tenantId !== '*' && tenant !== ctx.principal!.tenantId) throw new HttpError(403, 'FORBIDDEN', 'cross-tenant access denied')
      return ok(manager.list().filter((s) => visible(ctx.principal, s) && (!tenant || tenantOf(s) === tenant)).map(publicStatus))
    },
    createBot: async (ctx) => {
      const body = objectBody(ctx.body)
      onlyKeys(body, ['id', 'tenantId', 'name', 'provider', 'flows', 'meta', 'autoStart'])
      const p = ctx.principal!
      let tenantId = optionalString(body, 'tenantId')
      if (p.tenantId !== '*') {
        if (tenantId !== undefined && tenantId !== p.tenantId) throw new HttpError(403, 'FORBIDDEN', 'cross-tenant access denied')
        tenantId = p.tenantId
      }
      const status = await manager.createBot({
        id: optionalString(body, 'id'),
        tenantId,
        name: optionalString(body, 'name', 200),
        provider: body.provider as never,
        flows: optionalArray(body, 'flows'),
        meta: optionalObject(body, 'meta'),
        autoStart: optionalBoolean(body, 'autoStart'),
      })
      return { status: 201, body: { data: detail(status.id) } }
    },
    getBot: (ctx) => ok(detail(botFor(ctx).id)),
    updateBot: async (ctx) => {
      const { id } = botFor(ctx)
      const body = objectBody(ctx.body)
      onlyKeys(body, ['name', 'provider', 'flows', 'meta', 'desiredState', 'expectedVersion'])
      const expectedVersion = body.expectedVersion
      if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) throw invalid('expectedVersion must be an integer')
      await manager.updateBot(id, {
        name: optionalString(body, 'name', 200),
        provider: body.provider as never,
        flows: optionalArray(body, 'flows'),
        meta: optionalObject(body, 'meta'),
        desiredState: body.desiredState as never,
      }, { expectedVersion: expectedVersion as number | undefined })
      return ok(detail(id))
    },
    deleteBot: async (ctx) => {
      await manager.deleteBot(botFor(ctx).id)
      return { status: 204 }
    },
    startBot: lifecycle('start'),
    stopBot: lifecycle('stop'),
    restartBot: lifecycle('restart'),
    getConnection: (ctx) => ok(manager.connection(botFor(ctx).id)),
    sendMessage: async (ctx) => {
      const { id } = botFor(ctx)
      const body = objectBody(ctx.body)
      onlyKeys(body, ['chatId', 'text', 'content'])
      const chatId = requiredString(body, 'chatId', 256)
      let content: string | OutboundContent
      if (body.text !== undefined && body.content !== undefined) throw invalid('send either text or content, not both')
      if (body.text !== undefined) content = requiredString(body, 'text', 4096)
      else if (body.content !== undefined) content = sanitizeContent(body.content, options.allowInsecureMediaUrls === true)
      else throw invalid('text or content is required')
      if (typeof content !== 'string' && 'media' in content) await vetMediaHost(content.media as { url: string })
      const sendTo = requireCapability(manager.get(id), 'sendTo')
      try {
        const sent = (await sendTo(chatId, content)) as { id?: unknown; chatId?: unknown; skipped?: unknown } | undefined
        return ok({
          ...(typeof sent?.id === 'string' ? { messageId: sent.id } : {}),
          chatId: typeof sent?.chatId === 'string' ? sent.chatId : chatId,
          ...(sent?.skipped === true ? { skipped: true } : {}),
        })
      } catch (error) {
        throw mapProviderError(error)
      }
    },
    triggerFlow: async (ctx) => {
      const { id } = botFor(ctx)
      const body = objectBody(ctx.body)
      onlyKeys(body, ['flowId', 'chatId', 'userId', 'isGroup', 'state'])
      const flowId = requiredString(body, 'flowId', 64)
      const chatId = requiredString(body, 'chatId', 256)
      const state = optionalObject(body, 'state')
      if (state && JSON.stringify(state).length > 16 * 1024) throw invalid('state must be at most 16 KiB of JSON')
      const trigger = requireCapability(manager.get(id), 'triggerFlow')
      let started: boolean
      try {
        started = await trigger(flowId, { chatId, userId: optionalString(body, 'userId', 256), isGroup: optionalBoolean(body, 'isGroup') }, state ? { state } : undefined)
      } catch {
        throw new HttpError(409, 'BOT_NOT_RUNNING', 'the bot must be running to trigger a flow')
      }
      if (!started) throw new HttpError(404, 'NOT_FOUND', `flow "${flowId}" not found (or the subject is blocked / the chat is handed off)`)
      return { status: 202, body: { data: { started: true } } }
    },
    listConversations: (ctx) => ok(requireCapability(manager.get(botFor(ctx).id), 'listConversations')()),
    cancelConversation: (ctx) => {
      const abort = requireCapability(manager.get(botFor(ctx).id), 'abortConversation')
      if (!abort(ctx.params.key)) throw new HttpError(404, 'NOT_FOUND', 'conversation not found')
      return ok({ cancelled: true })
    },
    listMessages: async (ctx) => {
      const { id } = botFor(ctx)
      const chatId = ctx.query.get('chatId')
      if (!chatId) throw invalid('chatId query parameter is required')
      const limitRaw = ctx.query.get('limit')
      const limit = limitRaw === null ? 50 : Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1 || limit > MESSAGE_PAGE_MAX) throw invalid(`limit must be an integer between 1 and ${MESSAGE_PAGE_MAX}`)
      const cursor = decodeCursor(ctx.query.get('cursor'))
      const store = requireCapability(manager.get(id), 'getStore')()
      const all = (await store.getMessagesByChat(chatId)).slice().sort(newestFirst)
      const start = cursor ? all.findIndex((m) => newestFirst(m, cursor) > 0) : 0
      const page = start === -1 ? [] : all.slice(start, start + limit)
      const more = start !== -1 && start + limit < all.length
      return {
        status: 200,
        body: { data: page.map(publicMessage), nextCursor: more && page.length ? encodeCursor(page[page.length - 1]) : null },
      }
    },
    getBotMetrics: (ctx) => ok(manager.metrics(botFor(ctx).id)),
    listFlows: (ctx) => {
      const { id } = botFor(ctx)
      const list = capability(manager.get(id), 'listFlows')
      return ok({ registered: list ? list() : [], documents: manager.listFlowDocuments(id) })
    },
    createFlow: async (ctx) => {
      const flowId = await manager.addFlow(botFor(ctx).id, ctx.body)
      return { status: 201, body: { data: { id: flowId } } }
    },
    getFlow: (ctx) => {
      const doc = manager.listFlowDocuments(botFor(ctx).id).find((f) => f.id === ctx.params.flowId)
      if (!doc) throw new HttpError(404, 'NOT_FOUND', `flow document "${ctx.params.flowId}" not found`)
      return ok(doc)
    },
    putFlow: async (ctx) => {
      const { created } = await manager.putFlow(botFor(ctx).id, ctx.params.flowId, ctx.body)
      return { status: created ? 201 : 200, body: { data: { id: ctx.params.flowId, created } } }
    },
    deleteFlow: async (ctx) => {
      if (!(await manager.removeFlow(botFor(ctx).id, ctx.params.flowId))) throw new HttpError(404, 'NOT_FOUND', `flow "${ctx.params.flowId}" not found`)
      return { status: 204 }
    },
  }
  for (const { spec } of compiled) if (!handlers[spec.operationId]) throw new Error(`missing handler for ${spec.operationId}`)

  // ── request pipeline ─────────────────────────────────────────────────
  return (req, res, next) => {
    const incoming = header(req, 'x-request-id')
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID()
    const baseHeaders: Record<string, string> = {
      'x-request-id': requestId,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    }
    const respond = (result: Result, extra: Record<string, string> = {}) => {
      if (res.headersSent) return
      const headers = { ...baseHeaders, ...extra, ...result.headers }
      if (result.status === 204 || result.body === undefined) {
        res.writeHead(result.status, headers)
        res.end()
        return
      }
      const body = isEnvelopeLess(result.body) ? result.body : { ...(result.body as object), requestId }
      res.writeHead(result.status, { ...headers, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const fail = (error: unknown, extra: Record<string, string> = {}) => {
      const e = toHttpError(error)
      respond({
        status: e.status,
        headers: e.headers,
        body: { error: { code: e.code, message: e.message, requestId, ...(e.details !== undefined ? { details: e.details } : {}) } },
      }, extra)
    }

    const url = parseUrl(req.url)
    if (!url) return fail(new HttpError(400, 'BAD_REQUEST', 'unparseable url'))
    const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
    if (path !== prefix && !path.startsWith(`${prefix}/`)) {
      if (next) return next()
      return fail(new HttpError(404, 'NOT_FOUND', 'not found'))
    }
    const method = (req.method ?? 'GET').toUpperCase()
    let route: (typeof compiled)[number] | undefined
    let params: Record<string, string> = {}
    const allowed: string[] = []
    for (const candidate of compiled) {
      const m = candidate.re.exec(path)
      if (!m) continue
      allowed.push(candidate.spec.method)
      if (candidate.spec.method !== method || route) continue
      route = candidate
      try {
        params = Object.fromEntries(candidate.names.map((name, i) => [name, decodeURIComponent(m[i + 1])]))
      } catch {
        return fail(new HttpError(400, 'BAD_REQUEST', 'malformed path parameter'))
      }
    }
    if (!route) {
      if (allowed.length) return fail(new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed'), { allow: [...new Set(allowed)].join(', ') })
      return fail(new HttpError(404, 'NOT_FOUND', 'not found'))
    }
    const spec = route.spec

    // Authentication (also attempted on public routes, for the rate-limit key).
    const presented = header(req, 'x-api-key') ?? bearer(header(req, 'authorization'))
    const principal = presented ? authenticate(presented, tokens) : undefined
    const needsAuth = spec.scope !== undefined || (spec.docs === true && !publicDocs)

    let rateHeaders: Record<string, string> = {}
    if (limiter) {
      const decision = limiter.take(principal ? `token:${principal.id}` : `ip:${req.socket?.remoteAddress ?? 'unknown'}`)
      rateHeaders = { 'ratelimit-limit': String(decision.limit), 'ratelimit-remaining': String(decision.remaining) }
      if (!decision.allowed) {
        return fail(new HttpError(429, 'RATE_LIMITED', 'too many requests', undefined, { 'retry-after': String(decision.retryAfterSeconds ?? 1) }), rateHeaders)
      }
    }
    if (needsAuth) {
      if (!principal) return fail(new HttpError(401, 'UNAUTHORIZED', 'missing or invalid token', undefined, { 'www-authenticate': 'Bearer' }), rateHeaders)
      const scope = spec.scope ?? 'bots:read'
      if (!principal.scopes.has('*') && !principal.scopes.has(scope)) return fail(new HttpError(403, 'FORBIDDEN', `missing scope: ${scope}`), rateHeaders)
    }

    void (async () => {
      let raw: Buffer | undefined
      let body: unknown
      if (spec.body) {
        raw = await readBody(req, maxBodyBytes)
        if (raw.length === 0) throw invalid('a JSON body is required')
        const type = header(req, 'content-type') ?? ''
        if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'body must be application/json')
        try { body = JSON.parse(raw.toString('utf8')) } catch { throw new HttpError(400, 'INVALID_JSON', 'body is not valid JSON') }
      }
      const ctx: RouteContext = { params, query: url.searchParams, body, principal: needsAuth ? principal : undefined, requestId }
      const execute = async (): Promise<StoredResponse> => {
        try {
          const result = await handlers[spec.operationId](ctx)
          return { status: result.status, body: result.body, ...(result.headers ? { headers: result.headers } : {}) }
        } catch (error) {
          const e = toHttpError(error)
          return { status: e.status, body: { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } }, ...(e.headers ? { headers: e.headers } : {}) }
        }
      }
      const key = header(req, 'idempotency-key')
      if (key !== undefined && idempotency && spec.method !== 'GET' && principal && needsAuth) {
        if (!IDEMPOTENCY_KEY_RE.test(key)) throw invalid('Idempotency-Key must be 1-200 visible ASCII characters')
        const fingerprint = `${spec.method} ${path} ${sha256(raw ?? Buffer.alloc(0)).toString('hex')}`
        const outcome = await idempotency.run(`${principal.id}\u0000${key}`, fingerprint, execute)
        if (outcome === 'mismatch') throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for a different request')
        return respondStored(outcome.response, { ...rateHeaders, ...(outcome.replayed ? { 'idempotent-replayed': 'true' } : {}) })
      }
      respondStored(await execute(), rateHeaders)
    })().catch((error) => fail(error, rateHeaders))

    function respondStored(stored: StoredResponse, extra: Record<string, string>): void {
      const body = stored.body
      if (isErrorBody(body)) {
        respond({ status: stored.status, headers: stored.headers, body: { error: { ...body.error, requestId } } }, extra)
        return
      }
      respond({ status: stored.status, body, headers: stored.headers }, extra)
    }
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function ok(data: unknown): Result {
  return { status: 200, body: { data } }
}

function invalid(message: string, details?: unknown): HttpError {
  return new HttpError(400, 'VALIDATION_FAILED', message, details)
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof FlowDocumentError) return invalid('invalid flow document', error.issues)
  if (error instanceof CapabilityError) return new HttpError(501, 'NOT_SUPPORTED', error.message)
  if (error instanceof ManagerError) {
    switch (error.code) {
      case 'NOT_FOUND': return new HttpError(404, 'NOT_FOUND', error.message)
      case 'CONFLICT': return new HttpError(409, 'CONFLICT', error.message)
      case 'INVALID': return invalid(error.message, error.details)
      case 'NOT_CONFIGURED': return new HttpError(501, 'NOT_CONFIGURED', error.message)
    }
  }
  return new HttpError(500, 'INTERNAL', 'internal error')
}

function mapProviderError(error: unknown): HttpError {
  if (error instanceof RateLimitedError) {
    return new HttpError(503, 'UPSTREAM_RATE_LIMITED', 'the provider rate limited this send', undefined, { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) })
  }
  if (error instanceof PayloadTooLargeError) return new HttpError(413, 'PAYLOAD_TOO_LARGE', 'content exceeds a provider limit')
  if (error instanceof UnsupportedContentError) return new HttpError(422, 'UNSUPPORTED_CONTENT', `the provider cannot send "${error.kind}" content`)
  if (error instanceof RecipientUnreachableError) return new HttpError(422, 'RECIPIENT_UNREACHABLE', 'recipient unreachable')
  if (error instanceof OutsideSessionWindowError) return new HttpError(422, 'OUTSIDE_SESSION_WINDOW', 'outside the session window; send a template')
  return new HttpError(502, 'SEND_FAILED', 'the provider failed to send the message')
}

/** Keep only an allowlisted OutboundContent shape; media must be an https URL (no paths, no buffers). */
function sanitizeContent(input: unknown, allowHttp: boolean): OutboundContent {
  if (!isObject(input) || typeof input.kind !== 'string') throw invalid('content must be an object with a kind')
  const kind = input.kind
  const str = (key: string, max: number, required = false): string | undefined => {
    const v = input[key]
    if (v === undefined && !required) return undefined
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw invalid(`content.${key} must be a string of 1-${max} characters`)
    return v
  }
  if (kind === 'text') return { kind, text: str('text', 4096, true)! }
  if (MEDIA_KINDS.has(kind)) {
    const media = input.media
    const url = isObject(media) && typeof media.url === 'string' ? media.url : undefined
    let parsed: URL | undefined
    try { parsed = url ? new URL(url) : undefined } catch { parsed = undefined }
    if (!parsed || !(parsed.protocol === 'https:' || (allowHttp && parsed.protocol === 'http:'))) {
      throw invalid('content.media must be { url: "https://…" }')
    }
    const base = { media: { url: parsed.toString() } }
    const caption = str('caption', 1024)
    switch (kind) {
      case 'image': return { kind, ...base, ...(caption ? { caption } : {}) }
      case 'video': return { kind, ...base, ...(caption ? { caption } : {}) }
      case 'audio': return { kind, ...base }
      case 'voice': return { kind, ...base }
      case 'sticker': return { kind, ...base }
      default: {
        const filename = str('filename', 255)
        const mimetype = str('mimetype', 255)
        return { kind: 'document', ...base, ...(caption ? { caption } : {}), ...(filename ? { filename } : {}), ...(mimetype ? { mimetype } : {}) }
      }
    }
  }
  if (kind === 'location') {
    const lat = input.lat
    const lng = input.lng
    if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw invalid('content.lat/lng must be valid coordinates')
    const name = str('name', 200)
    const address = str('address', 500)
    return { kind, lat, lng, ...(name ? { name } : {}), ...(address ? { address } : {}) }
  }
  if (kind === 'contact') {
    const displayName = str('displayName', 200)
    return { kind, phone: str('phone', 64, true)!, ...(displayName ? { displayName } : {}) }
  }
  if (kind === 'poll') {
    const options = input.options
    if (!Array.isArray(options) || options.length < 2 || options.length > 12 || !options.every((o) => typeof o === 'string' && o.length > 0 && o.length <= 100)) {
      throw invalid('content.options must be 2-12 strings')
    }
    if (input.multiSelect !== undefined && typeof input.multiSelect !== 'boolean') throw invalid('content.multiSelect must be a boolean')
    return { kind, question: str('question', 300, true)!, options: options as string[], ...(input.multiSelect === true ? { multiSelect: true } : {}) }
  }
  throw invalid(`content.kind "${kind}" is not allowed through the API`)
}

function publicMessage(m: StoredMessage): Record<string, unknown> {
  return {
    id: m.ref.id,
    chatId: m.chatId,
    ...(m.senderId !== undefined ? { senderId: m.senderId } : {}),
    timestamp: m.timestamp,
    type: m.type,
    ...(m.body !== undefined ? { body: m.body } : {}),
    ...(m.direction !== undefined ? { direction: m.direction } : {}),
    ...(m.status !== undefined ? { status: m.status } : {}),
    ...(m.fromMe !== undefined ? { fromMe: m.fromMe } : {}),
  }
}

type CursorPoint = { timestamp: number; ref: { id: string } }

function newestFirst(a: CursorPoint, b: CursorPoint): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp
  return a.ref.id < b.ref.id ? 1 : a.ref.id > b.ref.id ? -1 : 0
}

function encodeCursor(m: CursorPoint): string {
  return Buffer.from(JSON.stringify([m.timestamp, m.ref.id]), 'utf8').toString('base64url')
}

function decodeCursor(raw: string | null): CursorPoint | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'string') return { timestamp: value[0], ref: { id: value[1] } }
  } catch { /* fall through */ }
  throw invalid('cursor is malformed')
}

/** Config as echoed to clients: secrets in `provider.options` and `meta` are redacted at any depth. */
function redactConfig<T extends { provider?: { type: string; options?: Record<string, unknown> }; meta?: Record<string, unknown> }>(config: T | undefined): T | null {
  if (!config) return null
  return {
    ...config,
    ...(config.provider ? { provider: redactSecrets(config.provider) } : {}),
    ...(config.meta ? { meta: redactSecrets(config.meta) } : {}),
  }
}

function publicStatus(status: BotStatus): BotStatus {
  return status.meta ? { ...status, meta: redactSecrets(status.meta) } : status
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw invalid('body must be a JSON object')
  return body
}

function onlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k))
  if (extra.length) throw invalid(`unknown field(s): ${extra.join(', ')}`)
}

function requiredString(body: Record<string, unknown>, key: string, max: number): string {
  const v = body[key]
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw invalid(`${key} must be a string of 1-${max} characters`)
  return v
}

function optionalString(body: Record<string, unknown>, key: string, max = 64): string | undefined {
  return body[key] === undefined ? undefined : requiredString(body, key, max)
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key]
  if (v !== undefined && typeof v !== 'boolean') throw invalid(`${key} must be a boolean`)
  return v as boolean | undefined
}

function optionalObject(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = body[key]
  if (v === undefined) return undefined
  if (!isObject(v)) throw invalid(`${key} must be an object`)
  return v
}

function optionalArray(body: Record<string, unknown>, key: string): unknown[] | undefined {
  const v = body[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw invalid(`${key} must be an array`)
  return v
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isErrorBody(body: unknown): body is { error: Record<string, unknown> } {
  return isObject(body) && isObject(body.error) && Object.keys(body).length === 1
}

/** OpenAPI / JSON Schema bodies are served as is (no `requestId` merged in). */
function isEnvelopeLess(body: unknown): boolean {
  return isObject(body) && (typeof body.openapi === 'string' || typeof body.$schema === 'string')
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(header(req, 'content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', `body exceeds ${limit} bytes`))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer | string) => {
      if (done) return
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buf.length
      if (size > limit) {
        done = true
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', `body exceeds ${limit} bytes`))
        req.resume?.()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
    req.on('error', (error) => { if (!done) { done = true; reject(error) } })
  })
}

function authenticate(presented: string, tokens: ReadonlyArray<{ digest: Buffer; principal: Principal }>): Principal | undefined {
  const digest = sha256(presented)
  let found: Principal | undefined
  // Compare against every token (no early exit) so timing does not reveal which one matched.
  for (const t of tokens) if (timingSafeEqual(digest, t.digest) && !found) found = t.principal
  return found
}

function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest()
}

function bearer(value: string | undefined): string | undefined {
  if (!value) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(value)
  return m ? m[1].trim() : undefined
}

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

function parseUrl(url: string | undefined): URL | undefined {
  try { return new URL(url ?? '/', 'http://manager.local') } catch { return undefined }
}

function normalizePrefix(prefix: string): string {
  let p = prefix.trim()
  if (!p.startsWith('/')) p = `/${p}`
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

function compilePath(path: string): RegExp {
  const pattern = path.split(/(\{\w+\})/).map((part) => (/^\{\w+\}$/.test(part) ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${pattern}$`)
}

function isRateLimiter(v: unknown): v is RateLimiter {
  return typeof v === 'object' && v !== null && typeof (v as RateLimiter).take === 'function'
}

function isIdempotencyStore(v: unknown): v is IdempotencyStore {
  return typeof v === 'object' && v !== null && typeof (v as IdempotencyStore).run === 'function'
}


