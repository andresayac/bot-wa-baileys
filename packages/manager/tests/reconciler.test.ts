import { describe, expect, it } from 'vitest'
import { BotManager, BotReconciler, DesiredStateConflictError, MemoryDesiredStateStore } from '../src/index.js'

describe('BotReconciler', () => {
  it('converges desired state idempotently and isolates tenants', async () => {
    const manager = new BotManager(); let starts = 0; let stops = 0
    manager.add({ start: async () => { starts += 1 }, stop: async () => { stops += 1 } }, { id: 'a' })
    const store = new MemoryDesiredStateStore(); const reconciler = new BotReconciler(manager, store)
    const first = await store.set('tenant-a', 'a', 'running')
    await reconciler.reconcile('tenant-a', 'a'); await reconciler.reconcile('tenant-a', 'a')
    expect(starts).toBe(1); expect((await store.get('tenant-a', 'a'))?.observed).toBe('running')
    await store.set('tenant-a', 'a', 'stopped', first.version)
    await reconciler.reconcile('tenant-a', 'a')
    expect(stops).toBe(1); expect(await store.list('tenant-b')).toEqual([])
  })
  it('uses CAS and records missing bots', async () => {
    const store = new MemoryDesiredStateStore(); await store.set('a', 'gone', 'running')
    await expect(store.set('a', 'gone', 'stopped', 99)).rejects.toBeInstanceOf(DesiredStateConflictError)
    const result = await new BotReconciler(new BotManager(), store).reconcile('a', 'gone')
    expect(result.state).toMatchObject({ observed: 'missing', lastError: 'bot is not registered' })
  })
})
