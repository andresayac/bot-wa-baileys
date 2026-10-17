import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import Fastify, { type FastifyInstance } from 'fastify'
import { Hono } from 'hono'
import { createIngress, createFetchHandler } from '../src/index.js'
import { expressIngress } from '../src/adapters/express.js'
import { fastifyIngress } from '../src/adapters/fastify.js'
import { honoIngress } from '../src/adapters/hono.js'
import { FakeWebhookProvider, IngestOnlyProvider, listen, rawRequest, type Running } from './support.js'

const BODY = '{ "x" : "Ñ 🚀" }'

let running: Running | undefined
let fastify: FastifyInstance | undefined
afterEach(async () => {
  await running?.close(); running = undefined
  await fastify?.close(); fastify = undefined
})

describe('express adapter', () => {
  it('captures raw bytes and falls through to other routes', async () => {
    const provider = new FakeWebhookProvider()
    const app = express()
    app.use(expressIngress(createIngress({ routes: [{ path: '/webhook', provider }] })))
    app.use(express.json())
    app.post('/api', (req, res) => { res.json({ got: req.body }) })
    running = await listen(createServer(app))
    const res = await fetch(`${running.url}/webhook`, { method: 'POST', body: BODY, headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)
    expect((provider.calls[0]!.raw as Buffer).toString('utf8')).toBe(BODY)
    const api = await fetch(`${running.url}/api`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
    expect(await api.json()).toEqual({ got: { a: 1 } })
  })

  it('reuses a Buffer left by express.raw() and still enforces the limit', async () => {
    const provider = new FakeWebhookProvider()
    const app = express()
    app.use(express.raw({ type: '*/*' }))
    app.use(expressIngress(createIngress({ routes: [{ path: '/webhook', provider }], maxBodyBytes: 32 })))
    running = await listen(createServer(app))
    expect((await fetch(`${running.url}/webhook`, { method: 'POST', body: BODY })).status).toBe(200)
    expect((provider.calls[0]!.raw as Buffer).toString('utf8')).toBe(BODY)
    expect((await fetch(`${running.url}/webhook`, { method: 'POST', body: 'x'.repeat(40) })).status).toBe(413)
  })

  it('answers 500 (never re-serializes) when express.json() already consumed the body', async () => {
    const provider = new FakeWebhookProvider()
    const app = express()
    app.use(express.json())
    app.use(expressIngress(createIngress({ routes: [{ path: '/webhook', provider }] })))
    running = await listen(createServer(app))
    const res = await fetch(`${running.url}/webhook`, { method: 'POST', body: BODY, headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(500)
    expect(provider.calls).toHaveLength(0)
  })

  it('serves health endpoints and 413s oversized bodies', async () => {
    const app = express()
    app.use(expressIngress(createIngress({ routes: [{ path: '/webhook', provider: new FakeWebhookProvider() }], maxBodyBytes: 8 })))
    running = await listen(createServer(app))
    expect((await fetch(`${running.url}/healthz`)).status).toBe(200)
    expect((await rawRequest(running.port, { headers: { 'content-length': '20' }, chunks: ['x'.repeat(20)] })).status).toBe(413)
  })
})

describe('fastify adapter', () => {
  it('captures raw bytes without disturbing the JSON parser of sibling routes', async () => {
    const provider = new FakeWebhookProvider()
    fastify = Fastify()
    fastify.register(fastifyIngress(createIngress({ routes: [{ path: '/webhook', provider }] })))
    fastify.post('/api', async (req) => ({ got: req.body }))
    await fastify.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(fastify.server.address() as { port: number }).port}`
    const res = await fetch(`${url}/webhook`, { method: 'POST', body: BODY, headers: { 'content-type': 'application/json', 'x-sig': 's' } })
    expect(res.status).toBe(200)
    expect((provider.calls[0]!.raw as Buffer).toString('utf8')).toBe(BODY)
    expect(provider.calls[0]!.headers?.['x-sig']).toBe('s')
    const api = await fetch(`${url}/api`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
    expect(await api.json()).toEqual({ got: { a: 1 } })
  })

  it('supports a prefix, GET handshakes, health and the size limit', async () => {
    const provider = new FakeWebhookProvider()
    provider.challenge = 'c-1'
    fastify = Fastify()
    fastify.register(fastifyIngress(createIngress({ routes: [{ path: '/webhook', provider }], maxBodyBytes: 8 })), { prefix: '/hooks' })
    await fastify.listen({ port: 0, host: '127.0.0.1' })
    const port = (fastify.server.address() as { port: number }).port
    const url = `http://127.0.0.1:${port}`
    const get = await fetch(`${url}/hooks/webhook?hub.challenge=c-1`)
    expect(get.status).toBe(200)
    expect(await get.text()).toBe('c-1')
    expect((await fetch(`${url}/hooks/healthz`)).status).toBe(200)
    expect((await rawRequest(port, { path: '/hooks/webhook', headers: { 'content-length': '20', 'content-type': 'application/json' }, chunks: ['x'.repeat(20)] })).status).toBe(413)
    expect((await fetch(`${url}/hooks/webhook`, { method: 'POST', body: '{"a":1}' })).status).toBe(200)
  })
})

describe('hono / fetch adapter', () => {
  it('captures raw bytes, answers handshakes and falls through', async () => {
    const provider = new FakeWebhookProvider()
    provider.challenge = 'hc'
    const app = new Hono()
    app.use('*', honoIngress(createIngress({ routes: [{ path: '/webhook', provider }] })))
    app.get('/other', (c) => c.text('other'))
    const res = await app.request('/webhook', { method: 'POST', body: BODY, headers: { 'x-sig': 'v' } })
    expect(res.status).toBe(200)
    expect((provider.calls[0]!.raw as Buffer).toString('utf8')).toBe(BODY)
    expect(provider.calls[0]!.headers?.['x-sig']).toBe('v')
    expect(await (await app.request('/webhook?hub.challenge=hc')).text()).toBe('hc')
    expect(await (await app.request('/other')).text()).toBe('other')
    expect((await app.request('/healthz')).status).toBe(200)
  })

  it('enforces the size limit on declared and streamed bodies', async () => {
    const provider = new IngestOnlyProvider()
    const handler = createFetchHandler(createIngress({ routes: [{ path: '/tg', provider, body: 'text' }], maxBodyBytes: 8 }))
    expect((await handler(new Request('http://x/tg', { method: 'POST', body: 'x'.repeat(20) }))).status).toBe(413)
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('12345')); c.enqueue(new TextEncoder().encode('67890')); c.close() },
    })
    const streamed = await handler(new Request('http://x/tg', { method: 'POST', body: stream, duplex: 'half' } as RequestInit))
    expect(streamed.status).toBe(413)
    expect((await handler(new Request('http://x/tg', { method: 'POST', body: '{"a":1}' }))).status).toBe(200)
    expect(provider.calls).toEqual(['{"a":1}'])
    expect((await handler(new Request('http://x/none'))).status).toBe(404)
  })

  it('answers 408 when a streamed body stalls', async () => {
    const handler = createFetchHandler(createIngress({ routes: [{ path: '/tg', provider: new IngestOnlyProvider() }], bodyTimeoutMs: 30 }))
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])) } })
    const res = await handler(new Request('http://x/tg', { method: 'POST', body: stream, duplex: 'half' } as RequestInit))
    expect(res.status).toBe(408)
  })
})
