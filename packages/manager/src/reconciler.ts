import type { BotManager } from './BotManager.js'

export type DesiredLifecycleState = 'running' | 'stopped'

export interface BotDesiredState {
  tenantId: string
  botId: string
  desired: DesiredLifecycleState
  observed: DesiredLifecycleState | 'missing' | 'error'
  version: number
  updatedAt: number
  lastError?: string
}

export interface DesiredStateStore {
  get(tenantId: string, botId: string): Promise<BotDesiredState | undefined>
  list(tenantId: string): Promise<BotDesiredState[]>
  set(tenantId: string, botId: string, desired: DesiredLifecycleState, expectedVersion?: number): Promise<BotDesiredState>
  observe(tenantId: string, botId: string, observed: BotDesiredState['observed'], lastError?: string): Promise<BotDesiredState | undefined>
}

/** CAS-capable in-memory store; replace this interface with a durable adapter in deployments. */
export class MemoryDesiredStateStore implements DesiredStateStore {
  private readonly records = new Map<string, BotDesiredState>()
  async get(tenantId: string, botId: string): Promise<BotDesiredState | undefined> {
    const record = this.records.get(key(tenantId, botId))
    return record ? { ...record } : undefined
  }
  async list(tenantId: string): Promise<BotDesiredState[]> {
    return [...this.records.values()].filter((record) => record.tenantId === tenantId).map((record) => ({ ...record }))
  }
  async set(tenantId: string, botId: string, desired: DesiredLifecycleState, expectedVersion?: number): Promise<BotDesiredState> {
    const existing = this.records.get(key(tenantId, botId))
    if (expectedVersion !== undefined && existing?.version !== expectedVersion) throw new DesiredStateConflictError(tenantId, botId)
    const record: BotDesiredState = {
      tenantId, botId, desired, observed: existing?.observed ?? 'missing', version: (existing?.version ?? 0) + 1, updatedAt: Date.now(), lastError: undefined,
    }
    this.records.set(key(tenantId, botId), record)
    return { ...record }
  }
  async observe(tenantId: string, botId: string, observed: BotDesiredState['observed'], lastError?: string): Promise<BotDesiredState | undefined> {
    const existing = this.records.get(key(tenantId, botId))
    if (!existing) return undefined
    const record = { ...existing, observed, lastError, updatedAt: Date.now() }
    this.records.set(key(tenantId, botId), record)
    return { ...record }
  }
}

export class DesiredStateConflictError extends Error {
  constructor(tenantId: string, botId: string) { super(`desired state version conflict for ${tenantId}/${botId}`); this.name = 'DesiredStateConflictError' }
}

export interface ReconcileResult { botId: string; changed: boolean; state: BotDesiredState }

/** Moves registered bots toward their desired lifecycle state without duplicate transitions. */
export class BotReconciler {
  constructor(private readonly manager: BotManager, private readonly store: DesiredStateStore) {}
  async reconcile(tenantId: string, botId: string): Promise<ReconcileResult> {
    const state = await this.store.get(tenantId, botId)
    if (!state) throw new Error(`desired state missing for ${tenantId}/${botId}`)
    if (!this.manager.has(botId)) {
      const observed = await this.store.observe(tenantId, botId, 'missing', 'bot is not registered')
      return { botId, changed: false, state: observed! }
    }
    const currentlyRunning = this.manager.isRunning(botId)
    try {
      if (state.desired === 'running' && !currentlyRunning) await this.manager.start(botId)
      if (state.desired === 'stopped' && currentlyRunning) await this.manager.stop(botId)
      const observed = await this.store.observe(tenantId, botId, state.desired)
      return { botId, changed: currentlyRunning !== (state.desired === 'running'), state: observed! }
    } catch (error) {
      const observed = await this.store.observe(tenantId, botId, 'error', error instanceof Error ? error.message : String(error))
      return { botId, changed: false, state: observed! }
    }
  }
  async reconcileTenant(tenantId: string): Promise<ReconcileResult[]> {
    return Promise.all((await this.store.list(tenantId)).map((state) => this.reconcile(tenantId, state.botId)))
  }
}
function key(tenantId: string, botId: string): string { return `${tenantId}\u0000${botId}` }
