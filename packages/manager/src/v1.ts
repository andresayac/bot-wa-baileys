import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BotManager } from './BotManager.js'
import { AuditLog, assertAuthorized, ControlPlaneError, IdempotencyRegistry, type ControlAction, type Principal, verifyApiKey } from './controlPlane.js'

export interface ControlPlaneApiKey extends Principal { secret: string }
export interface ControlPlaneApiOptions {
  tenantId: string
  apiKeys: readonly ControlPlaneApiKey[]
  prefix?: string
  auditLog?: AuditLog
  idempotency?: IdempotencyRegistry<unknown>
}
export type ControlPlaneApiHandler = (req: IncomingMessage, res: ServerResponse) => void

/** Versioned control-plane API. It deliberately has no unauthenticated mode. */
export function createControlPlaneApi(manager: BotManager, options: ControlPlaneApiOptions): ControlPlaneApiHandler {
  if (!options.tenantId || options.apiKeys.length === 0) throw new Error('tenantId and at least one API key are required')
  const prefix = normalizePrefix(options.prefix ?? '/v1')
  const audit = options.auditLog ?? new AuditLog()
  const idempotency = options.idempotency ?? new IdempotencyRegistry<unknown>()
  return (req, res) => {
    const path = pathname(req.url)
    const requestId = header(req, 'x-request-id') ?? randomUUID()
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId })
      res.end(JSON.stringify(body))
    }
    const principal = authenticate(req, options.apiKeys)
    if (!principal) return send(401, { error: { code: 'UNAUTHORIZED', requestId } })
    const method = (req.method ?? 'GET').toUpperCase()
    const fail = (status: number, code: string, action: string, resource: string) => {
      audit.append({ tenantId: options.tenantId, actorId: principal.id, action, resource, outcome: 'denied', requestId })
      send(status, { error: { code, requestId } })
    }
    const authorize = (action: ControlAction, resource: string): boolean => {
      try { assertAuthorized(principal, options.tenantId, action); return true }
      catch { fail(403, 'FORBIDDEN', action, resource); return false }
    }
    if (method === 'GET' && path === `${prefix}/health`) {
      if (!authorize('bots:read', 'health')) return
      const bots = manager.list()
      audit.append({ tenantId: options.tenantId, actorId: principal.id, action: 'health.read', resource: 'health', outcome: 'allowed', requestId })
      return send(200, { data: { status: 'ok', bots: bots.length, running: bots.filter((bot) => bot.running).length }, requestId })
    }
    if (method === 'GET' && path === `${prefix}/bots`) {
      if (!authorize('bots:read', 'bots')) return
      audit.append({ tenantId: options.tenantId, actorId: principal.id, action: 'bots.read', resource: 'bots', outcome: 'allowed', requestId })
      return send(200, { data: manager.list(), requestId })
    }
    const lifecycle = new RegExp(`^${escapeRegExp(prefix)}/bots/([^/]+)/(start|stop)$`).exec(path)
    if (method === 'POST' && lifecycle) {
      const id = decodeURIComponent(lifecycle[1])
      const action = lifecycle[2] as 'start' | 'stop'
      if (!authorize('bots:operate', `bots/${id}`)) return
      if (!manager.has(id)) return fail(404, 'NOT_FOUND', `bots.${action}`, `bots/${id}`)
      const key = header(req, 'idempotency-key')
      const operation = async () => {
        try {
          await manager[action](id)
          audit.append({ tenantId: options.tenantId, actorId: principal.id, action: `bots.${action}`, resource: `bots/${id}`, outcome: 'allowed', requestId })
          return { data: { id, running: manager.isRunning(id) }, requestId }
        } catch {
          audit.append({ tenantId: options.tenantId, actorId: principal.id, action: `bots.${action}`, resource: `bots/${id}`, outcome: 'failed', requestId })
          throw new Error('operation failed')
        }
      }
      // Bind the idempotency key to THIS request (method + path) so reusing the
      // same key for a different bot/action is a 409, not a silent stale success.
      const fingerprint = `${method} ${path}`
      const run = key ? idempotency.run(options.tenantId, key, fingerprint, operation) : operation()
      void run.then((body) => send(200, body)).catch((error) => {
        if (error instanceof ControlPlaneError && error.code === 'CONFLICT') {
          return send(409, { error: { code: 'CONFLICT', requestId } })
        }
        send(500, { error: { code: 'INTERNAL', requestId } })
      })
      return
    }
    if (method === 'GET' && path === `${prefix}/audit`) {
      if (!authorize('audit:read', 'audit')) return
      return send(200, { data: audit.list(options.tenantId), requestId })
    }
    return send(404, { error: { code: 'NOT_FOUND', requestId } })
  }
}
function authenticate(req: IncomingMessage, keys: readonly ControlPlaneApiKey[]): ControlPlaneApiKey | undefined {
  const presented = header(req, 'x-api-key') ?? header(req, 'authorization')?.replace(/^Bearer\s+/i, '')
  return presented ? keys.find((key) => verifyApiKey(presented, key.secret)) : undefined
}
function header(req: IncomingMessage, name: string): string | undefined { const raw = req.headers[name]; return Array.isArray(raw) ? raw[0] : raw }
function pathname(url: string | undefined): string { try { return new URL(url ?? '/', 'http://manager.local').pathname } catch { return '/' } }
function normalizePrefix(prefix: string): string { const p = prefix.startsWith('/') ? prefix : `/${prefix}`; return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
