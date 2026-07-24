import { describe, expect, it } from 'vitest'
import { AuditLog, ControlPlaneError, IdempotencyRegistry, SecretVault, assertAuthorized, verifyApiKey } from '../src/index.js'

describe('control plane primitives', () => {
  it('enforces tenant and scope boundaries', () => {
    expect(() => assertAuthorized({ id: 'u', tenantId: 'a', scopes: ['bots:read'] }, 'b', 'bots:read')).toThrow(ControlPlaneError)
    expect(() => assertAuthorized({ id: 'u', tenantId: 'a', scopes: ['bots:read'] }, 'a', 'bots:write')).toThrow(/missing scope/)
  })
  it('encrypts values and never exposes them from describe or audit', () => {
    const vault = new SecretVault(Buffer.alloc(32, 7))
    const secret = vault.put('a', 'meta-token', 'super-secret')
    expect(vault.describe('a', secret.ref)).toEqual({ ref: 'a:meta-token', version: 1 })
    expect(vault.get('a', secret.ref)).toBe('super-secret')
    expect(() => vault.get('b', secret.ref)).toThrow(/not found/)
    const audit = new AuditLog().append({ tenantId: 'a', actorId: 'u', action: 'secret.write', resource: secret.ref, outcome: 'allowed', metadata: { token: 'super-secret' } })
    expect(audit.metadata).toEqual({ token: '[REDACTED]' })
  })
  it('coalesces concurrent idempotent operations per tenant (same key + same request)', async () => {
    const registry = new IdempotencyRegistry<number>()
    let runs = 0
    const op = async () => { runs += 1; return runs }
    await expect(Promise.all([registry.run('a', 'k', 'fp', op), registry.run('a', 'k', 'fp', op), registry.run('b', 'k', 'fp', op)])).resolves.toEqual([1, 1, 2])
    expect(verifyApiKey('key', 'key')).toBe(true)
    expect(verifyApiKey('key', 'nope')).toBe(false)
  })
  it('rejects an idempotency key reused for a DIFFERENT request with CONFLICT', async () => {
    const registry = new IdempotencyRegistry<number>()
    const op = async () => 1
    await registry.run('a', 'k', 'start:botA', op)
    await expect(registry.run('a', 'k', 'stop:botB', op)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
