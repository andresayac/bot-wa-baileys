/**
 * createManagerApi — HTTP handler tests. Calls the handler with fake
 * req/res objects (no real server, no network). Fully hermetic.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BotManager, createManagerApi, type ManagerApiHandler } from '../src/index.js'

interface FakeBot {
  calls: string[]
  isStarted: boolean
  start: () => Promise<void>
  stop: () => Promise<void>
}

function fakeBot(): FakeBot {
  const bot: FakeBot = {
    calls: [],
    isStarted: false,
    start: async () => {
      bot.calls.push('start')
      bot.isStarted = true
    },
    stop: async () => {
      bot.calls.push('stop')
      bot.isStarted = false
    },
  }
  return bot
}

interface HttpResponse {
  status: number
  headers: Record<string, string | number>
  body: unknown
  raw: string
}

/** Invoke the handler with fake req/res and resolve with the JSON response. */
function call(handler: ManagerApiHandler, method: string, url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string | number>,
      writeHead(status: number, headers: Record<string, string | number>) {
        this.statusCode = status
        this.headers = headers
        return this
      },
      end(payload?: string) {
        const raw = payload ?? ''
        resolve({
          status: this.statusCode,
          headers: this.headers,
          raw,
          body: raw && String(this.headers['content-type'] ?? '').includes('application/json') ? JSON.parse(raw) : undefined,
        })
      },
    }
    const req = { method, url, headers }
    Promise.resolve(handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)).catch(reject)
  })
}

describe('createManagerApi', () => {
  let manager: BotManager
  let handler: ManagerApiHandler
  let good: FakeBot
  let bad: FakeBot

  beforeEach(() => {
    manager = new BotManager()
    handler = createManagerApi(manager)
    good = fakeBot()
    bad = fakeBot()
    bad.start = async () => {
      throw new Error('boom')
    }
    manager.add(good, { id: 'a', meta: { tenant: 'acme' } })
    manager.add(bad, { id: 'bad' })
  })

  it('GET /bots returns the list as JSON', async () => {
    const res = await call(handler, 'GET', '/bots')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body).toEqual([
      { id: 'a', running: false, meta: { tenant: 'acme' } },
      { id: 'bad', running: false, meta: undefined },
    ])
  })

  it('exposes health and Prometheus-compatible metrics', async () => {
    const health = await call(handler, 'GET', '/health')
    expect(health.status).toBe(200)
    expect(health.body).toEqual({ status: 'ok', bots: 2, running: 0 })
    const metrics = await call(handler, 'GET', '/metrics')
    expect(metrics.status).toBe(200)
    expect(metrics.headers['content-type']).toContain('text/plain')
    expect(metrics.raw).toContain('botwa_manager_bots_registered 2')
  })

  it('GET /bots tolerates a trailing slash', async () => {
    const res = await call(handler, 'GET', '/bots/')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('GET /bots/:id returns status for a known bot', async () => {
    const res = await call(handler, 'GET', '/bots/a')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'a', running: false, meta: { tenant: 'acme' } })
  })

  it('GET /bots/:id decodes percent-encoded ids', async () => {
    manager.add(fakeBot(), { id: 'my bot' })
    const res = await call(handler, 'GET', '/bots/my%20bot')
    expect(res.status).toBe(200)
    expect((res.body as { id: string }).id).toBe('my bot')
  })

  it('GET /bots/:id returns 404 JSON for an unknown bot', async () => {
    const res = await call(handler, 'GET', '/bots/ghost')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'bot "ghost" not found' })
  })

  it('POST /bots/:id/start starts the bot and reports running', async () => {
    const res = await call(handler, 'POST', '/bots/a/start')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'a', running: true })
    expect(good.calls).toEqual(['start'])
    expect(manager.isRunning('a')).toBe(true)
  })

  it('POST /bots/:id/stop stops the bot and reports running', async () => {
    await manager.start('a')
    const res = await call(handler, 'POST', '/bots/a/stop')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'a', running: false })
    expect(good.calls).toEqual(['start', 'stop'])
  })

  it('POST start on unknown id returns 404 without touching the manager', async () => {
    const res = await call(handler, 'POST', '/bots/ghost/start')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'bot "ghost" not found' })
  })

  it('POST stop on unknown id returns 404', async () => {
    const res = await call(handler, 'POST', '/bots/ghost/stop')
    expect(res.status).toBe(404)
  })

  it('POST start on a failing bot returns 500 without leaking the error message', async () => {
    const res = await call(handler, 'POST', '/bots/bad/start')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'start failed' })
    expect(res.raw).not.toContain('boom')
    expect(manager.isRunning('bad')).toBe(false)
  })

  it('hands lifecycle failures to onError for the host to log', async () => {
    const seen: Array<{ message: string; id: string; action: string }> = []
    const h = createManagerApi(manager, { onError: (error, info) => seen.push({ message: (error as Error).message, ...info }) })
    const res = await call(h, 'POST', '/bots/bad/start')
    expect(res.status).toBe(500)
    expect(seen).toEqual([{ message: 'boom', id: 'bad', action: 'start' }])
  })

  it('unknown routes return 404 JSON', async () => {
    const res = await call(handler, 'GET', '/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('unsupported methods on known routes return 404 JSON', async () => {
    const del = await call(handler, 'DELETE', '/bots/a')
    expect(del.status).toBe(404)
    const postList = await call(handler, 'POST', '/bots')
    expect(postList.status).toBe(404)
    const getStart = await call(handler, 'GET', '/bots/a/start')
    expect(getStart.status).toBe(404)
  })

  it('honors a prefix option', async () => {
    const prefixed = createManagerApi(manager, { prefix: '/api' })
    const ok = await call(prefixed, 'GET', '/api/bots')
    expect(ok.status).toBe(200)
    const one = await call(prefixed, 'GET', '/api/bots/a')
    expect(one.status).toBe(200)
    const start = await call(prefixed, 'POST', '/api/bots/a/start')
    expect(start.status).toBe(200)
    const missing = await call(prefixed, 'GET', '/bots')
    expect(missing.status).toBe(404)
  })

  it('normalizes prefix variants (no leading slash, trailing slash)', async () => {
    const prefixed = createManagerApi(manager, { prefix: 'api/' })
    const res = await call(prefixed, 'GET', '/api/bots')
    expect(res.status).toBe(200)
  })

  it('reflects running state after lifecycle changes', async () => {
    await call(handler, 'POST', '/bots/a/start')
    const res = await call(handler, 'GET', '/bots/a')
    expect(res.status).toBe(200)
    expect((res.body as { running: boolean }).running).toBe(true)
  })

  describe('auth', () => {
    it('rejects every route with 401 when no token is presented', async () => {
      const secured = createManagerApi(manager, { auth: { token: 'secret' } })
      const list = await call(secured, 'GET', '/bots')
      expect(list.status).toBe(401)
      expect(list.body).toEqual({ error: 'unauthorized' })
      const start = await call(secured, 'POST', '/bots/a/start')
      expect(start.status).toBe(401)
      // The mutating route must NOT have touched the manager.
      expect(good.calls).toEqual([])
    })

    it('rejects a wrong token', async () => {
      const secured = createManagerApi(manager, { auth: { token: 'secret' } })
      const res = await call(secured, 'GET', '/bots', { authorization: 'Bearer nope' })
      expect(res.status).toBe(401)
    })

    it('accepts the correct token with the Bearer prefix', async () => {
      const secured = createManagerApi(manager, { auth: { token: 'secret' } })
      const res = await call(secured, 'GET', '/bots', { authorization: 'Bearer secret' })
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('accepts the raw token without the Bearer prefix', async () => {
      const secured = createManagerApi(manager, { auth: { token: 'secret' } })
      const res = await call(secured, 'GET', '/bots', { authorization: 'secret' })
      expect(res.status).toBe(200)
    })

    it('accepts the Bearer scheme in any case (RFC 9110: schemes are case-insensitive)', async () => {
      const secured = createManagerApi(manager, { auth: { token: 'secret' } })
      expect((await call(secured, 'GET', '/bots', { authorization: 'bearer secret' })).status).toBe(200)
      expect((await call(secured, 'GET', '/bots', { authorization: 'BEARER  secret' })).status).toBe(200)
    })

    it('fails fast on a missing or empty token instead of crashing on the first request', () => {
      // e.g. `{ token: process.env.MANAGER_TOKEN! }` with the variable unset.
      expect(() => createManagerApi(manager, { auth: { token: undefined as unknown as string } })).toThrow(/auth\.token/)
      expect(() => createManagerApi(manager, { auth: { token: '' } })).toThrow(/auth\.token/)
    })

    it('supports a custom header name', async () => {
      const secured = createManagerApi(manager, { auth: { token: 'secret', header: 'x-api-key' } })
      const ok = await call(secured, 'POST', '/bots/a/start', { 'x-api-key': 'secret' })
      expect(ok.status).toBe(200)
      expect(good.calls).toEqual(['start'])
      const bad = await call(secured, 'GET', '/bots', { authorization: 'Bearer secret' })
      expect(bad.status).toBe(401)
    })
  })
})
