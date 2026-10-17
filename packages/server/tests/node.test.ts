import { afterEach, describe, expect, it } from 'vitest'
import { createIngress, createNodeHandler, type IngressOptions } from '../src/index.js'
import { FakeWebhookProvider, IngestOnlyProvider, deferred, listen, rawRequest, recordingLogger, tick, type Running } from './support.js'

let running: Running | undefined
afterEach(async () => { await running?.close(); running = undefined })

async function serve(options: IngressOptions) {
  const ingress = createIngress(options)
  running = await listen(createNodeHandler(ingress))
  return { ingress, url: running.url, port: running.port }
}

describe('node:http handler — routing', () => {
  it('passes the exact raw body bytes and the headers to provider.ingest', async () => {
    const provider = new FakeWebhookProvider()
    const { url } = await serve({ routes: [{ path: '/webhook', provider }] })
    // Byte-exact: odd spacing + non-ASCII must survive (signatures are over raw bytes).
    const body = '{ "a" :1,\n  "name":"Ñandú 🚀" }'
    const res = await fetch(`${url}/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=abc' } })
    expect(res.status).toBe(200)
    expect(provider.calls).toHaveLength(1)
    const raw = provider.calls[0]!.raw
    expect(Buffer.isBuffer(raw)).toBe(true)
    expect((raw as Buffer).equals(Buffer.from(body, 'utf8'))).toBe(true)
    expect(provider.calls[0]!.headers?.['x-hub-signature-256']).toBe('sha256=abc')
  })

  it("passes a utf-8 string when the route asks for body: 'text' (Telegram)", async () => {
    const provider = new IngestOnlyProvider()
    const { url } = await serve({ routes: [{ path: '/tg', provider, body: 'text' }] })
    await fetch(`${url}/tg`, { method: 'POST', body: '{"update_id":1}' })
    expect(provider.calls).toEqual(['{"update_id":1}'])
  })

  it('uses the numeric status returned by ingest', async () => {
    const provider = new FakeWebhookProvider()
    provider.result = 403
    const { url } = await serve({ routes: [{ path: '/webhook', provider }] })
    const res = await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(403)
  })

  it('awaits an async ingest and supports { status, body } results', async () => {
    const provider = new FakeWebhookProvider()
    provider.result = async () => ({ status: 202, body: { type: 1 } })
    const { url } = await serve({ routes: [{ path: '/webhook', provider }] })
    const res = await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(202)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ type: 1 })
  })

  it('answers 200 when ingest returns nothing', async () => {
    const provider = new FakeWebhookProvider()
    provider.result = undefined
    const { url } = await serve({ routes: [{ path: '/webhook', provider }] })
    expect((await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })).status).toBe(200)
  })

  it('routes several providers by path and ignores the query string / trailing slash', async () => {
    const meta = new FakeWebhookProvider()
    const tg = new IngestOnlyProvider()
    const { url } = await serve({ routes: [{ path: '/meta', provider: meta }, { path: '/tg', provider: tg }] })
    await fetch(`${url}/tg/?x=1`, { method: 'POST', body: '{}' })
    expect(tg.calls).toHaveLength(1)
    expect(meta.calls).toHaveLength(0)
  })

  it('answers the GET verification handshake via verifyChallenge', async () => {
    const provider = new FakeWebhookProvider()
    provider.challenge = 'echo-me'
    const { url } = await serve({ routes: [{ path: '/webhook', provider }] })
    const res = await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=t&hub.challenge=echo-me`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('echo-me')
    expect(provider.challengeQueries[0]).toEqual({ 'hub.mode': 'subscribe', 'hub.verify_token': 't', 'hub.challenge': 'echo-me' })
  })

  it('answers 403 when verifyChallenge rejects', async () => {
    const provider = new FakeWebhookProvider()
    provider.challenge = null
    const { url } = await serve({ routes: [{ path: '/webhook', provider }] })
    expect((await fetch(`${url}/webhook?hub.verify_token=wrong`)).status).toBe(403)
  })

  it('answers 405 to GET when the provider has no verifyChallenge, and to other methods', async () => {
    const { url } = await serve({ routes: [{ path: '/tg', provider: new IngestOnlyProvider() }] })
    const get = await fetch(`${url}/tg`)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    const put = await fetch(`${url}/tg`, { method: 'PUT', body: 'x' })
    expect(put.status).toBe(405)
  })

  it('answers 404 to unknown paths', async () => {
    const { url } = await serve({ routes: [{ path: '/webhook', provider: new FakeWebhookProvider() }] })
    expect((await fetch(`${url}/nope`, { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('maps a SyntaxError from ingest to 400 and other errors to 500', async () => {
    const provider = new FakeWebhookProvider()
    const { url } = await serve({ routes: [{ path: '/webhook', provider }] })
    provider.result = () => JSON.parse('{nope')
    expect((await fetch(`${url}/webhook`, { method: 'POST', body: '{nope' })).status).toBe(400)
    provider.result = () => { throw new Error('boom') }
    expect((await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })).status).toBe(500)
  })

  it('rejects invalid configuration', () => {
    expect(() => createIngress({ routes: [{ path: '/a', provider: {} }] })).toThrow(/ingest/)
    expect(() => createIngress({ routes: [{ path: 'a', provider: new IngestOnlyProvider() }] })).toThrow(/path/)
    expect(() => createIngress({ routes: [{ path: '/a', provider: new IngestOnlyProvider() }, { path: '/a', provider: new IngestOnlyProvider() }] })).toThrow(/duplicate/i)
    expect(() => createIngress({ routes: [{ path: '/healthz', provider: new IngestOnlyProvider() }] })).toThrow(/duplicate/i)
    expect(() => createIngress({ routes: [], maxConcurrent: 0 })).toThrow(/maxConcurrent/)
  })
})

describe('node:http handler — limits', () => {
  it('answers 413 from Content-Length without calling ingest', async () => {
    const provider = new FakeWebhookProvider()
    const { port } = await serve({ routes: [{ path: '/webhook', provider }], maxBodyBytes: 16 })
    const res = await rawRequest(port, { headers: { 'content-length': '32' }, chunks: ['x'.repeat(32)] })
    expect(res.status).toBe(413)
    expect(provider.calls).toHaveLength(0)
  })

  it('answers 413 to a chunked body that grows past the limit', async () => {
    const provider = new FakeWebhookProvider()
    const { port } = await serve({ routes: [{ path: '/webhook', provider }], maxBodyBytes: 16 })
    const res = await rawRequest(port, { headers: { 'transfer-encoding': 'chunked' }, chunks: ['x'.repeat(10), 'y'.repeat(10)] })
    expect([413, 0]).toContain(res.status) // 413, or a reset once the socket is torn down
    expect(provider.calls).toHaveLength(0)
  })

  it('accepts a body exactly at the limit and honours a per-route override', async () => {
    const small = new FakeWebhookProvider()
    const big = new FakeWebhookProvider()
    const { port } = await serve({ routes: [{ path: '/small', provider: small }, { path: '/big', provider: big, maxBodyBytes: 64 }], maxBodyBytes: 16 })
    expect((await rawRequest(port, { path: '/small', chunks: ['x'.repeat(16)] })).status).toBe(200)
    expect((await rawRequest(port, { path: '/big', chunks: ['x'.repeat(40)] })).status).toBe(200)
    expect((await rawRequest(port, { path: '/small', headers: { 'content-length': '40' }, chunks: ['x'.repeat(40)] })).status).toBe(413)
  })

  it('answers 408 when the body does not arrive in time', async () => {
    const provider = new FakeWebhookProvider()
    const { port } = await serve({ routes: [{ path: '/webhook', provider }], bodyTimeoutMs: 50 })
    const res = await rawRequest(port, { headers: { 'content-length': '100' }, chunks: ['partial'], stall: true })
    expect(res.status).toBe(408)
    expect(provider.calls).toHaveLength(0)
  })

  it('answers 503 when ingest does not settle in time', async () => {
    const provider = new FakeWebhookProvider()
    provider.result = () => new Promise(() => {})
    const { url } = await serve({ routes: [{ path: '/webhook', provider }], ingestTimeoutMs: 50 })
    const res = await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
  })

  it('answers 503 + Retry-After when the concurrency limit is saturated', async () => {
    const provider = new FakeWebhookProvider()
    const gate = deferred<number>()
    provider.result = () => gate.promise
    const { url, ingress } = await serve({ routes: [{ path: '/webhook', provider }], maxConcurrent: 1 })
    const first = fetch(`${url}/webhook`, { method: 'POST', body: '{}' })
    while (ingress.inflight === 0) await tick(5)
    const second = await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })
    expect(second.status).toBe(503)
    expect(second.headers.get('retry-after')).toBe('1')
    gate.resolve(200)
    expect((await first).status).toBe(200)
    expect((await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })).status).toBe(200)
    expect(provider.calls).toHaveLength(2)
  })

  it('keeps the concurrency slot until a timed-out ingest settles', async () => {
    const provider = new FakeWebhookProvider()
    const gate = deferred<number>()
    provider.result = () => gate.promise
    const { url, ingress } = await serve({ routes: [{ path: '/webhook', provider }], maxConcurrent: 1, ingestTimeoutMs: 30 })
    expect((await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })).status).toBe(503)
    expect(ingress.inflight).toBe(1)
    expect((await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })).status).toBe(503)
    gate.resolve(200)
    await tick(10)
    expect(ingress.inflight).toBe(0)
  })

  it('never lets health checks be blocked by saturation', async () => {
    const provider = new FakeWebhookProvider()
    const gate = deferred<number>()
    provider.result = () => gate.promise
    const { url, ingress } = await serve({ routes: [{ path: '/webhook', provider }], maxConcurrent: 1 })
    const first = fetch(`${url}/webhook`, { method: 'POST', body: '{}' })
    while (ingress.inflight === 0) await tick(5)
    expect((await fetch(`${url}/healthz`)).status).toBe(200)
    gate.resolve(200)
    await first
  })
})

describe('node:http handler — logging hygiene', () => {
  it('never logs bodies, headers, query strings or error messages', async () => {
    const { entries, logger } = recordingLogger()
    const provider = new FakeWebhookProvider()
    const { url, port } = await serve({ routes: [{ path: '/webhook', provider }], maxBodyBytes: 64, logger, ingestTimeoutMs: 30 })
    const secret = 'SUPER-SECRET-TOKEN'
    provider.challenge = null
    await fetch(`${url}/webhook?hub.verify_token=${secret}`)
    provider.result = () => JSON.parse(`{"${secret}`)
    await fetch(`${url}/webhook`, { method: 'POST', body: `{"${secret}`, headers: { authorization: `Bearer ${secret}` } })
    provider.result = () => { throw new Error(`failed for ${secret}`) }
    await fetch(`${url}/webhook`, { method: 'POST', body: secret })
    provider.result = () => new Promise(() => {})
    await fetch(`${url}/webhook`, { method: 'POST', body: secret })
    await rawRequest(port, { headers: { 'content-length': '100' }, chunks: [secret.repeat(10)] })
    expect(entries.length).toBeGreaterThan(0)
    const dump = JSON.stringify(entries)
    expect(dump).not.toContain(secret)
    expect(entries.some((e) => e.level === 'error' && (e.obj as { errName?: string }).errName === 'Error')).toBe(true)
  })
})

describe('health endpoints', () => {
  it('/healthz is always 200 while the process serves', async () => {
    const { url } = await serve({ routes: [], bot: { getConnectionState: () => 'closed' } })
    const res = await fetch(`${url}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect((await fetch(`${url}/healthz`, { method: 'HEAD' })).status).toBe(200)
  })

  it('/readyz follows the bot connection state', async () => {
    let state = 'connecting'
    const { url } = await serve({ routes: [], bot: { getConnectionState: () => state } })
    let res = await fetch(`${url}/readyz`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'not_ready', connection: 'connecting' })
    state = 'ready'
    res = await fetch(`${url}/readyz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready', connection: 'ready' })
  })

  it('/readyz is 200 without a bot and honours custom readiness checks', async () => {
    let ok: boolean | Error = true
    const { url } = await serve({ routes: [], readiness: async () => { if (ok instanceof Error) throw ok; return ok } })
    expect((await fetch(`${url}/readyz`)).status).toBe(200)
    ok = false
    expect((await fetch(`${url}/readyz`)).status).toBe(503)
    ok = new Error('db down')
    expect((await fetch(`${url}/readyz`)).status).toBe(503)
  })

  it('health paths are configurable and can be disabled', async () => {
    const { url } = await serve({ routes: [], healthPath: '/live', readyPath: false })
    expect((await fetch(`${url}/live`)).status).toBe(200)
    expect((await fetch(`${url}/healthz`)).status).toBe(404)
    expect((await fetch(`${url}/readyz`)).status).toBe(404)
  })

  it('close() drains in-flight webhooks, then refuses new ones and reports not ready', async () => {
    const provider = new FakeWebhookProvider()
    const gate = deferred<number>()
    provider.result = () => gate.promise
    const { url, ingress } = await serve({ routes: [{ path: '/webhook', provider }], bot: { getConnectionState: () => 'ready' } })
    const first = fetch(`${url}/webhook`, { method: 'POST', body: '{}' })
    while (ingress.inflight === 0) await tick(5)
    let closed = false
    const closing = ingress.close().then(() => { closed = true })
    expect(ingress.closing).toBe(true)
    expect((await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })).status).toBe(503)
    expect((await fetch(`${url}/readyz`)).status).toBe(503)
    expect((await fetch(`${url}/healthz`)).status).toBe(200)
    await tick(10)
    expect(closed).toBe(false)
    gate.resolve(200)
    expect((await first).status).toBe(200)
    await closing
    expect(closed).toBe(true)
  })

  it('close({ timeoutMs }) gives up waiting on a stuck ingest', async () => {
    const provider = new FakeWebhookProvider()
    provider.result = () => new Promise(() => {})
    const { url, ingress } = await serve({ routes: [{ path: '/webhook', provider }], ingestTimeoutMs: 20 })
    await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })
    await ingress.close({ timeoutMs: 20 })
    expect(ingress.inflight).toBe(1)
  })
})

describe('createNodeHandler fallthrough', () => {
  it('calls the onNotFound callback for unmatched paths', async () => {
    const ingress = createIngress({ routes: [] })
    running = await listen(createNodeHandler(ingress, { onNotFound: (_req, res) => { res.writeHead(418).end('teapot') } }))
    const res = await fetch(`${running.url}/other`)
    expect(res.status).toBe(418)
  })
})
