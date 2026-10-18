/**
 * createRestApi — hermetic tests: fake req (a Readable) / res objects, no sockets.
 */
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, it, expect, beforeEach } from 'vitest'
import { Bot, RateLimitedError } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import {
  BotManager,
  MemoryBotConfigStore,
  ROUTES,
  buildOpenApiDocument,
  createRestApi,
  type RestApiHandler,
  type RestApiOptions,
} from '../src/index.js'

interface Res { status: number; headers: Record<string, string>; body: any; raw: string }

const OPS = 'ops-secret-0123456789abcdef'
const ACME = 'acme-secret-0123456789abcdef'
const READER = 'reader-secret-0123456789abcd'

function call(handler: RestApiHandler, method: string, url: string, opts: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(payload)]) as unknown as IncomingMessage
  const headers: Record<string, string> = { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '10.0.0.1' } })
  return new Promise((resolve) => {
    const out: Res = { status: 0, headers: {}, body: undefined, raw: '' }
    const res: { headersSent: boolean; writeHead(status: number, h: Record<string, string>): unknown; end(chunk?: string): void } = {
      headersSent: false,
      writeHead(status: number, h: Record<string, string>) { out.status = status; out.headers = h; res.headersSent = true; return res },
      end(chunk?: string) {
        out.raw = chunk ?? ''
        out.body = chunk ? JSON.parse(chunk) : undefined
        resolve(out)
      },
    }
    handler(req, res as unknown as ServerResponse)
  })
}

function setup(extra: Partial<RestApiOptions> = {}) {
  const providers = new Map<string, MockProvider>()
  const manager = new BotManager({
    configStore: new MemoryBotConfigStore(),
    factory: (cfg) => {
      const provider = new MockProvider()
      providers.set(cfg.id, provider)
      return new Bot({ provider })
    },
  })
  const api = createRestApi(manager, {
    tokens: [
      { id: 'ops', token: OPS, scopes: ['*'] },
      { id: 'acme', token: ACME, tenantId: 'acme', scopes: ['*'] },
      { id: 'reader', token: READER, tenantId: 'acme', scopes: ['bots:read'] },
    ],
    rateLimit: false,
    ...extra,
  })
  return { manager, api, providers }
}

describe('REST API — basics', () => {
  it('requires at least one token', () => {
    expect(() => createRestApi(new BotManager(), { tokens: [] })).toThrow(/token/)
    expect(() => createRestApi(new BotManager(), { tokens: [{ id: 'x', token: 'short', scopes: ['*'] }] })).toThrow(/16/)
    expect(() => createRestApi(new BotManager(), { tokens: [{ id: 'x', token: OPS, scopes: ['nope' as never] }] })).toThrow(/scope/)
  })

  it('health and docs are public; everything else needs a token', async () => {
    const { api } = setup()
    const health = await call(api, 'GET', '/v1/health')
    expect(health.status).toBe(200)
    expect(health.body.data.status).toBe('ok')
    expect((await call(api, 'GET', '/v1/openapi.json')).body.openapi).toBe('3.1.0')
    expect((await call(api, 'GET', '/v1/flows/schema')).body.$id).toMatch(/flow-document/)
    const denied = await call(api, 'GET', '/v1/bots')
    expect(denied.status).toBe(401)
    expect(denied.headers['www-authenticate']).toBe('Bearer')
    expect(denied.body.error.code).toBe('UNAUTHORIZED')
    expect((await call(api, 'GET', '/v1/bots', { token: 'wrong-token-0123456789' })).status).toBe(401)
    expect((await call(api, 'GET', '/v1/bots', { headers: { 'x-api-key': OPS } })).status).toBe(200)
  })

  it('docs can be made private', async () => {
    const { api } = setup({ publicDocs: false })
    expect((await call(api, 'GET', '/v1/openapi.json')).status).toBe(401)
    expect((await call(api, 'GET', '/v1/openapi.json', { token: READER })).status).toBe(200)
  })

  it('echoes a sane X-Request-Id and generates one otherwise', async () => {
    const { api } = setup()
    const echoed = await call(api, 'GET', '/v1/health', { headers: { 'x-request-id': 'req-123' } })
    expect(echoed.headers['x-request-id']).toBe('req-123')
    expect(echoed.body.requestId).toBe('req-123')
    const generated = await call(api, 'GET', '/v1/health', { headers: { 'x-request-id': 'bad id\n' } })
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('404 for unknown routes, 405 with Allow for wrong methods, next() outside the prefix', async () => {
    const { api } = setup()
    expect((await call(api, 'GET', '/v1/nope', { token: OPS })).status).toBe(404)
    const wrong = await call(api, 'PATCH', '/v1/bots', { token: OPS })
    expect(wrong.status).toBe(405)
    expect(wrong.headers.allow).toBe('GET, POST')
    let nextCalled = false
    api({ url: '/other', method: 'GET', headers: {} } as IncomingMessage, {} as ServerResponse, () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })

  it('enforces scopes', async () => {
    const { api } = setup()
    const res = await call(api, 'POST', '/v1/bots', { token: READER, body: { id: 'x' } })
    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('bots:write')
  })

  it('rejects bodies that are too large, not JSON, or malformed', async () => {
    const { api } = setup({ maxBodyBytes: 100 })
    expect((await call(api, 'POST', '/v1/bots', { token: OPS, body: { name: 'x'.repeat(200) } })).status).toBe(413)
    expect((await call(api, 'POST', '/v1/bots', { token: OPS, rawBody: '{}', headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await call(api, 'POST', '/v1/bots', { token: OPS, rawBody: '{nope' })).body.error.code).toBe('INVALID_JSON')
    expect((await call(api, 'POST', '/v1/bots', { token: OPS, body: { bogus: 1 } })).body.error.code).toBe('VALIDATION_FAILED')
  })

  it('rate limits per token with RateLimit headers and Retry-After', async () => {
    let now = 0
    const { api } = setup({ rateLimit: { capacity: 2, refillPerSecond: 1, now: () => now } })
    const a = await call(api, 'GET', '/v1/bots', { token: OPS })
    expect(a.headers['ratelimit-limit']).toBe('2')
    expect(a.headers['ratelimit-remaining']).toBe('1')
    await call(api, 'GET', '/v1/bots', { token: OPS })
    const limited = await call(api, 'GET', '/v1/bots', { token: OPS })
    expect(limited.status).toBe(429)
    expect(limited.headers['retry-after']).toBe('1')
    expect((await call(api, 'GET', '/v1/bots', { token: ACME })).status).toBe(200)
    now = 1000
    expect((await call(api, 'GET', '/v1/bots', { token: OPS })).status).toBe(200)
  })

  it('serves an OpenAPI 3.1 document covering every route', () => {
    const doc = buildOpenApiDocument()
    expect(doc.openapi).toBe('3.1.0')
    for (const route of ROUTES) {
      const op = doc.paths[`/v1${route.path}`][route.method.toLowerCase()] as { operationId: string }
      expect(op.operationId).toBe(route.operationId)
    }
    const send = doc.paths['/v1/bots/{botId}/send'].post as { security: unknown[]; parameters: Array<{ name: string }> }
    expect(send.security).toEqual([{ bearerAuth: ['messages:send'] }, { apiKey: ['messages:send'] }])
    expect(send.parameters.map((p) => p.name)).toEqual(['botId', 'Idempotency-Key'])
    expect((doc.components as { schemas: Record<string, unknown> }).schemas.FlowDocument).toBeDefined()
  })
})

describe('REST API — bots, tenancy, lifecycle', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => { ctx = setup() })

  it('CRUD + lifecycle', async () => {
    const { api } = ctx
    const created = await call(api, 'POST', '/v1/bots', { token: OPS, body: { id: 'a1', tenantId: 'acme', name: 'Acme', provider: { type: 'mock', options: { apiToken: 's3cr3t', region: 'eu' } } } })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ id: 'a1', running: true, tenantId: 'acme', config: { version: 1 } })
    expect(created.body.data.config.provider.options).toEqual({ apiToken: '[REDACTED]', region: 'eu' })
    expect((await call(api, 'POST', '/v1/bots', { token: OPS, body: { id: 'a1' } })).status).toBe(409)

    const list = await call(api, 'GET', '/v1/bots', { token: OPS })
    expect(list.body.data.map((b: { id: string }) => b.id)).toEqual(['a1'])

    const stopped = await call(api, 'POST', '/v1/bots/a1/stop', { token: OPS })
    expect(stopped.body.data.running).toBe(false)
    expect((await call(api, 'POST', '/v1/bots/a1/start', { token: OPS })).body.data.running).toBe(true)
    expect((await call(api, 'POST', '/v1/bots/a1/restart', { token: OPS })).status).toBe(200)

    const updated = await call(api, 'PUT', '/v1/bots/a1', { token: OPS, body: { name: 'Acme 2', expectedVersion: 99 } })
    expect(updated.status).toBe(409)
    const version = ctx.manager.getConfig('a1')!.version
    const ok = await call(api, 'PUT', '/v1/bots/a1', { token: OPS, body: { name: 'Acme 2', expectedVersion: version } })
    expect(ok.body.data.name).toBe('Acme 2')

    expect((await call(api, 'DELETE', '/v1/bots/a1', { token: OPS })).status).toBe(204)
    expect((await call(api, 'GET', '/v1/bots/a1', { token: OPS })).status).toBe(404)
    await ctx.manager.shutdown()
  })

  it('isolates tenants: tokens only see and create their own bots', async () => {
    const { api } = ctx
    await call(api, 'POST', '/v1/bots', { token: OPS, body: { id: 'beta-1', tenantId: 'beta', autoStart: false } })
    const mine = await call(api, 'POST', '/v1/bots', { token: ACME, body: { id: 'acme-1', autoStart: false } })
    expect(mine.body.data.tenantId).toBe('acme')
    expect((await call(api, 'POST', '/v1/bots', { token: ACME, body: { id: 'x', tenantId: 'beta' } })).status).toBe(403)
    expect((await call(api, 'GET', '/v1/bots', { token: ACME })).body.data.map((b: { id: string }) => b.id)).toEqual(['acme-1'])
    expect((await call(api, 'GET', '/v1/bots/beta-1', { token: ACME })).status).toBe(404)
    expect((await call(api, 'POST', '/v1/bots/beta-1/start', { token: ACME })).status).toBe(404)
    expect((await call(api, 'GET', '/v1/bots?tenantId=beta', { token: ACME })).status).toBe(403)
    expect((await call(api, 'GET', '/v1/bots?tenantId=beta', { token: OPS })).body.data).toHaveLength(1)
  })

  it('bots added without a tenant belong to the default tenant', async () => {
    const { api, manager } = ctx
    manager.add({ start: async () => {}, stop: async () => {} }, { id: 'plain' })
    expect((await call(api, 'GET', '/v1/bots/plain', { token: ACME })).status).toBe(404)
    expect((await call(api, 'GET', '/v1/bots/plain', { token: OPS })).body.data.config).toBeNull()
    expect((await call(api, 'POST', '/v1/bots/plain/send', { token: OPS, body: { chatId: 'c', text: 'x' } })).status).toBe(501)
  })

  it('reports lifecycle failures as 500 LIFECYCLE_FAILED without leaking the cause', async () => {
    const { api, manager } = ctx
    manager.add({ start: async () => { throw new Error('secret db password wrong') }, stop: async () => {} }, { id: 'bad', tenantId: 'acme' })
    const res = await call(api, 'POST', '/v1/bots/bad/start', { token: ACME })
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('LIFECYCLE_FAILED')
    expect(res.raw).not.toContain('password')
  })

  it('connection + metrics endpoints', async () => {
    const { api } = ctx
    await call(api, 'POST', '/v1/bots', { token: OPS, body: { id: 'm1' } })
    const conn = await call(api, 'GET', '/v1/bots/m1/connection', { token: OPS })
    expect(conn.status).toBe(200)
    expect(conn.body.data.state).toBeDefined()
    const metrics = await call(api, 'GET', '/v1/bots/m1/metrics', { token: OPS })
    expect(metrics.body.data).toMatchObject({ id: 'm1', running: true, starts: 1, flows: 0 })
    const all = await call(api, 'GET', '/v1/metrics', { token: OPS })
    expect(all.body.data).toMatchObject({ bots: 1, running: 1 })
    await ctx.manager.shutdown()
  })
})

describe('REST API — messaging, conversations, flows, idempotency', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(async () => {
    ctx = setup()
    await call(ctx.api, 'POST', '/v1/bots', { token: OPS, body: { id: 'b' } })
  })

  it('sends text and sanitized content; refuses local paths', async () => {
    const { api, providers } = ctx
    const sent = await call(api, 'POST', '/v1/bots/b/send', { token: OPS, body: { chatId: 'chat-1', text: 'hola' } })
    expect(sent.status).toBe(200)
    expect(sent.body.data.chatId).toBe('chat-1')
    expect(typeof sent.body.data.messageId).toBe('string')
    const img = await call(api, 'POST', '/v1/bots/b/send', { token: OPS, body: { chatId: 'chat-1', content: { kind: 'image', media: { url: 'https://example.com/a.png' }, caption: 'c', extra: 1 } } })
    expect(img.status).toBe(200)
    expect(providers.get('b')!.outbox.map((m) => m.content)).toEqual([
      { kind: 'text', text: 'hola' },
      { kind: 'image', media: { url: 'https://example.com/a.png' }, caption: 'c' },
    ])
    for (const media of ['/etc/passwd', { path: '/etc/passwd' }, { url: 'file:///etc/passwd' }, { url: 'http://insecure' }]) {
      const res = await call(api, 'POST', '/v1/bots/b/send', { token: OPS, body: { chatId: 'c', content: { kind: 'document', media } } })
      expect(res.status).toBe(400)
    }
    expect((await call(api, 'POST', '/v1/bots/b/send', { token: OPS, body: { chatId: 'c', content: { kind: 'native', provider: 'x', payload: {} } } })).status).toBe(400)
    await ctx.manager.shutdown()
  })

  it('maps provider errors to HTTP statuses', async () => {
    const { api, providers } = ctx
    providers.get('b')!.send = async () => { throw new RateLimitedError(2500) }
    const res = await call(api, 'POST', '/v1/bots/b/send', { token: OPS, body: { chatId: 'c', text: 'x' } })
    expect(res.status).toBe(503)
    expect(res.headers['retry-after']).toBe('3')
    await ctx.manager.shutdown()
  })

  it('flows CRUD, trigger, conversations list/cancel', async () => {
    const { api, providers } = ctx
    const doc = { version: 1, id: 'encuesta', trigger: 'encuesta', steps: [{ kind: 'ask', text: '¿Nombre?', stateKey: 'name' }, { kind: 'say', text: 'Gracias {{name}}' }] }
    expect((await call(api, 'POST', '/v1/bots/b/flows', { token: OPS, body: doc })).status).toBe(201)
    expect((await call(api, 'POST', '/v1/bots/b/flows', { token: OPS, body: doc })).status).toBe(409)
    const bad = await call(api, 'POST', '/v1/bots/b/flows', { token: OPS, body: { version: 1, id: 'x', trigger: 'x', steps: [{ kind: 'eval', code: '1' }] } })
    expect(bad.status).toBe(400)
    expect(bad.body.error.details[0].path).toBe('/steps/0/kind')
    expect((await call(api, 'GET', '/v1/bots/b/flows/encuesta', { token: OPS })).body.data.id).toBe('encuesta')
    const listed = await call(api, 'GET', '/v1/bots/b/flows', { token: OPS })
    expect(listed.body.data.registered).toContainEqual({ id: 'encuesta', kind: 'flow', steps: 2, persistent: false })

    const trig = await call(api, 'POST', '/v1/bots/b/trigger', { token: OPS, body: { flowId: 'encuesta', chatId: 'chat-9', state: { source: 'api' } } })
    expect(trig.status).toBe(202)
    expect((await call(api, 'POST', '/v1/bots/b/trigger', { token: OPS, body: { flowId: 'nope', chatId: 'chat-9' } })).status).toBe(404)
    await new Promise((r) => setTimeout(r, 5))
    expect(providers.get('b')!.outbox.at(-1)!.content).toEqual({ kind: 'text', text: '¿Nombre?' })
    const convs = await call(api, 'GET', '/v1/bots/b/conversations', { token: OPS })
    expect(convs.body.data).toEqual([{ key: 'chat-9', state: { source: 'api' }, waiting: true, queued: 0, accepts: 'text' }])
    expect((await call(api, 'POST', '/v1/bots/b/conversations/chat-9/cancel', { token: OPS })).status).toBe(200)
    expect((await call(api, 'POST', '/v1/bots/b/conversations/chat-9/cancel', { token: OPS })).status).toBe(404)

    const put = await call(api, 'PUT', '/v1/bots/b/flows/encuesta', { token: OPS, body: { ...doc, steps: [{ kind: 'say', text: 'v2' }] } })
    expect(put.body.data).toEqual({ id: 'encuesta', created: false })
    expect((await call(api, 'PUT', '/v1/bots/b/flows/nuevo', { token: OPS, body: { ...doc, id: 'nuevo' } })).status).toBe(201)
    expect((await call(api, 'DELETE', '/v1/bots/b/flows/encuesta', { token: OPS })).status).toBe(204)
    expect((await call(api, 'DELETE', '/v1/bots/b/flows/encuesta', { token: OPS })).status).toBe(404)
    expect(ctx.manager.getConfig('b')!.flows!.map((f) => f.id)).toEqual(['nuevo'])
    await ctx.manager.shutdown()
  })

  it('paginates stored messages newest first', async () => {
    const { api, manager } = ctx
    const store = (manager.get('b') as Bot).getStore()
    for (let i = 1; i <= 5; i++) {
      await store.saveMessage({ ref: { id: `m${i}`, chatId: 'c1' }, chatId: 'c1', timestamp: i * 1000, type: 'text', body: `msg ${i}`, direction: 'inbound', raw: { secret: true } })
    }
    const p1 = await call(api, 'GET', '/v1/bots/b/messages?chatId=c1&limit=2', { token: OPS })
    expect(p1.body.data.map((m: { id: string }) => m.id)).toEqual(['m5', 'm4'])
    expect(p1.body.data[0].raw).toBeUndefined()
    const p2 = await call(api, 'GET', `/v1/bots/b/messages?chatId=c1&limit=2&cursor=${p1.body.nextCursor}`, { token: OPS })
    expect(p2.body.data.map((m: { id: string }) => m.id)).toEqual(['m3', 'm2'])
    const p3 = await call(api, 'GET', `/v1/bots/b/messages?chatId=c1&limit=2&cursor=${p2.body.nextCursor}`, { token: OPS })
    expect(p3.body.data.map((m: { id: string }) => m.id)).toEqual(['m1'])
    expect(p3.body.nextCursor).toBeNull()
    expect((await call(api, 'GET', '/v1/bots/b/messages', { token: OPS })).status).toBe(400)
    expect((await call(api, 'GET', '/v1/bots/b/messages?chatId=c1&limit=500', { token: OPS })).status).toBe(400)
    expect((await call(api, 'GET', '/v1/bots/b/messages?chatId=c1&cursor=zzz', { token: OPS })).status).toBe(400)
    await ctx.manager.shutdown()
  })

  it('replays idempotent requests and rejects a reused key with a different body', async () => {
    const { api, providers } = ctx
    const headers = { 'idempotency-key': 'k-1' }
    const first = await call(api, 'POST', '/v1/bots/b/send', { token: OPS, headers, body: { chatId: 'c', text: 'once' } })
    const again = await call(api, 'POST', '/v1/bots/b/send', { token: OPS, headers, body: { chatId: 'c', text: 'once' } })
    expect(again.status).toBe(200)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(again.body.data).toEqual(first.body.data)
    expect(providers.get('b')!.outbox).toHaveLength(1)
    const reused = await call(api, 'POST', '/v1/bots/b/send', { token: OPS, headers, body: { chatId: 'c', text: 'other' } })
    expect(reused.status).toBe(422)
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    // Keys are per token.
    expect((await call(api, 'POST', '/v1/bots/b/send', { token: ACME, headers, body: { chatId: 'c', text: 'other' } })).status).toBe(404)
    await ctx.manager.shutdown()
  })
})

describe('REST API — secret redaction', () => {
  it('redacts secrets recursively in provider.options and meta, in every bot response', async () => {
    const { api, manager } = setup()
    const options = {
      region: 'eu',
      graph: { accessToken: 'AT', version: 'v20' },
      logins: [{ user: 'bob', password: 'pw' }],
      privateKey: 'PK', signingKey: 'SK', pass: 'p', pin: '1234', cookie: 'c',
    }
    const meta = { plan: 'pro', webhook: { secret: 'whs', url: 'https://x' } }
    const created = await call(api, 'POST', '/v1/bots', { token: OPS, body: { id: 'r1', tenantId: 'acme', provider: { type: 'mock', options }, meta } })
    expect(created.status).toBe(201)
    const expected = {
      region: 'eu',
      graph: { accessToken: '[REDACTED]', version: 'v20' },
      logins: [{ user: 'bob', password: '[REDACTED]' }],
      privateKey: '[REDACTED]', signingKey: '[REDACTED]', pass: '[REDACTED]', pin: '[REDACTED]', cookie: '[REDACTED]',
    }
    const redactedMeta = { plan: 'pro', webhook: { secret: '[REDACTED]', url: 'https://x' } }
    expect(created.body.data.config.provider.options).toEqual(expected)
    expect(created.body.data.config.meta).toEqual(redactedMeta)
    expect(created.body.data.meta).toEqual(redactedMeta)
    const got = await call(api, 'GET', '/v1/bots/r1', { token: OPS })
    expect(got.body.data.config.provider.options).toEqual(expected)
    const list = await call(api, 'GET', '/v1/bots', { token: OPS })
    expect(list.body.data[0].meta).toEqual(redactedMeta)
    const updated = await call(api, 'PUT', '/v1/bots/r1', { token: OPS, body: { meta: { apiKey: 'k' } } })
    expect(updated.body.data.config.meta).toEqual({ apiKey: '[REDACTED]' })
    // The manager itself keeps the real values (the factory needs them).
    expect(manager.getConfig('r1')!.provider!.options).toMatchObject({ graph: { accessToken: 'AT' } })
    await manager.shutdown()
  })
})
