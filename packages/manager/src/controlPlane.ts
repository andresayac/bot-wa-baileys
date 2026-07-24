import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

export type ControlAction =
  | 'bots:read' | 'bots:write' | 'bots:operate'
  | 'messages:read' | 'messages:send'
  | 'connections:read' | 'connections:write'
  | 'secrets:write' | 'audit:read'

export interface Principal {
  id: string
  tenantId: string
  scopes: readonly ControlAction[]
}

export function assertAuthorized(principal: Principal, tenantId: string, action: ControlAction): void {
  if (!principal.id || !principal.tenantId) throw new Error('principal id and tenantId are required')
  if (principal.tenantId !== tenantId) throw new ControlPlaneError('cross-tenant access denied', 'FORBIDDEN')
  if (!principal.scopes.includes(action)) throw new ControlPlaneError(`missing scope: ${action}`, 'FORBIDDEN')
}

export class ControlPlaneError extends Error {
  constructor(message: string, readonly code: 'FORBIDDEN' | 'CONFLICT' | 'NOT_FOUND' | 'INVALID') {
    super(message)
    this.name = 'ControlPlaneError'
  }
}

export interface AuditEntry {
  id: string
  at: number
  tenantId: string
  actorId: string
  action: string
  resource: string
  outcome: 'allowed' | 'denied' | 'failed'
  requestId?: string
  metadata?: Record<string, unknown>
}

/** In-memory audit sink with secret-aware metadata redaction. */
export class AuditLog {
  private readonly entries: AuditEntry[] = []
  append(entry: Omit<AuditEntry, 'id' | 'at' | 'metadata'> & { metadata?: Record<string, unknown> }): AuditEntry {
    const record: AuditEntry = {
      ...entry,
      id: randomBytes(12).toString('hex'),
      at: Date.now(),
      metadata: redact(entry.metadata),
    }
    this.entries.push(record)
    return { ...record, metadata: record.metadata ? { ...record.metadata } : undefined }
  }
  list(tenantId: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.tenantId === tenantId).map((entry) => ({ ...entry, metadata: entry.metadata ? { ...entry.metadata } : undefined }))
  }
}

/** AES-256-GCM secret vault. Responses expose a reference, never a value. */
export class SecretVault {
  private readonly records = new Map<string, { tenantId: string; iv: Buffer; tag: Buffer; ciphertext: Buffer; version: number }>()
  private readonly key: Buffer
  constructor(masterKey: Buffer | string) {
    this.key = Buffer.isBuffer(masterKey) ? Buffer.from(masterKey) : Buffer.from(masterKey, 'base64')
    if (this.key.byteLength !== 32) throw new ControlPlaneError('SecretVault master key must be exactly 32 bytes', 'INVALID')
  }
  put(tenantId: string, name: string, value: string): { ref: string; version: number } {
    if (!tenantId || !name || !value) throw new ControlPlaneError('tenantId, name and value are required', 'INVALID')
    const ref = `${tenantId}:${name}`
    const previous = this.records.get(ref)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    this.records.set(ref, { tenantId, iv, tag: cipher.getAuthTag(), ciphertext, version: (previous?.version ?? 0) + 1 })
    return { ref, version: (previous?.version ?? 0) + 1 }
  }
  get(tenantId: string, ref: string): string {
    const record = this.records.get(ref)
    if (!record || record.tenantId !== tenantId) throw new ControlPlaneError('secret not found', 'NOT_FOUND')
    const decipher = createDecipheriv('aes-256-gcm', this.key, record.iv)
    decipher.setAuthTag(record.tag)
    return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString('utf8')
  }
  describe(tenantId: string, ref: string): { ref: string; version: number } {
    const record = this.records.get(ref)
    if (!record || record.tenantId !== tenantId) throw new ControlPlaneError('secret not found', 'NOT_FOUND')
    return { ref, version: record.version }
  }
}

/** Ensures repeated tenant-scoped idempotency keys reuse one outcome. */
export class IdempotencyRegistry<T> {
  private readonly records = new Map<string, { fingerprint: string; promise: Promise<T> }>()
  async run(tenantId: string, key: string, fingerprint: string, operation: () => Promise<T>): Promise<T> {
    if (!tenantId || !key) throw new ControlPlaneError('tenantId and idempotency key are required', 'INVALID')
    const composite = `${tenantId}\u0000${key}`
    const existing = this.records.get(composite)
    if (existing) {
      // Same key MUST mean the same request. Reusing it for a different
      // operation is a client bug — fail loudly instead of silently skipping
      // the new operation and returning the previous result.
      if (existing.fingerprint !== fingerprint) {
        throw new ControlPlaneError('idempotency key reused for a different request', 'CONFLICT')
      }
      return existing.promise
    }
    const promise = operation().catch((error) => {
      this.records.delete(composite)
      throw error
    })
    this.records.set(composite, { fingerprint, promise })
    return promise
  }
}

export function verifyApiKey(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function redact(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) =>
    /secret|token|password|authorization|api[-_]?key/i.test(key) ? [key, '[REDACTED]'] : [key, value],
  ))
}
