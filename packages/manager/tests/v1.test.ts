import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BotManager, createControlPlaneApi, type ControlPlaneApiHandler } from '../src/index.js'

function call(handler: ControlPlaneApiHandler, method: string, url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const res = { status: 200, writeHead(status: number) { this.status = status; return this }, end(raw: string) { resolve({ status: this.status, body: JSON.parse(raw) }) } }
    handler({ method, url, headers } as unknown as IncomingMessage, res as unknown as ServerResponse)
  })
}
describe('control plane /v1', () => {
  it('requires scopes, audits calls and coalesces lifecycle retries', async () => {
    let starts = 0
    const manager = new BotManager()
    manager.add({ start: async () => { starts += 1 }, stop: async () => {} }, { id: 'bot' })
    const api = createControlPlaneApi(manager, { tenantId: 'acme', apiKeys: [
      { id: 'reader', tenantId: 'acme', secret: 'read', scopes: ['bots:read'] },
      { id: 'operator', tenantId: 'acme', secret: 'operate', scopes: ['bots:read', 'bots:operate', 'audit:read'] },
    ] })
    expect((await call(api, 'GET', '/v1/bots')).status).toBe(401)
    expect((await call(api, 'POST', '/v1/bots/bot/start', { 'x-api-key': 'read' })).status).toBe(403)
    const [a, b] = await Promise.all([
      call(api, 'POST', '/v1/bots/bot/start', { 'x-api-key': 'operate', 'idempotency-key': 'same' }),
      call(api, 'POST', '/v1/bots/bot/start', { 'x-api-key': 'operate', 'idempotency-key': 'same' }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(starts).toBe(1)
    const audit = await call(api, 'GET', '/v1/audit', { 'x-api-key': 'operate' })
    expect(audit.status).toBe(200)
    expect(audit.body.data.some((entry: { action: string }) => entry.action === 'bots.start')).toBe(true)
  })
})
