import { describe, expect, it, vi } from 'vitest'

import type { BotKernel } from '../src/core/bot/kernel.js'
import { Lifecycle, type LifecycleStep } from '../src/core/bot/lifecycle.js'

function fakeKernel() {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  const kernel = {
    state: {
      isStarted: false,
      acceptingInbound: false,
      pacedSendsOpen: false,
      connState: 'connecting',
      lifecycleAbort: new AbortController(),
      sendsAbort: new AbortController(),
    },
    logger,
    events: { emit: vi.fn() },
    counters: { markStarted: vi.fn(), markStopped: vi.fn() },
    runtime: { close: vi.fn() },
    inflightSends: new Set<Promise<unknown>>(),
  }
  return { kernel: kernel as unknown as BotKernel, logger, state: kernel.state }
}

describe('Lifecycle start rollback', () => {
  it('does not roll back a quiesce step whose start() never ran', async () => {
    const { kernel } = fakeKernel()
    const lease: LifecycleStep = {
      name: 'lease',
      quiesce: true,
      start: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    }
    const steps: LifecycleStep[] = [
      { name: 'boom', start: async () => { throw new Error('boom') } },
      lease,
    ]
    await expect(new Lifecycle(kernel, steps).start()).rejects.toThrow('boom')
    expect(lease.start).not.toHaveBeenCalled()
    expect(lease.rollback).not.toHaveBeenCalled()
  })

  it('rolls back an unreached step only when it opts in with alwaysRollback', async () => {
    const { kernel } = fakeKernel()
    const jobs: LifecycleStep = {
      name: 'jobs',
      alwaysRollback: true,
      start: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    }
    const steps: LifecycleStep[] = [
      { name: 'boom', start: async () => { throw new Error('boom') } },
      jobs,
    ]
    await expect(new Lifecycle(kernel, steps).start()).rejects.toThrow('boom')
    expect(jobs.start).not.toHaveBeenCalled()
    expect(jobs.rollback).toHaveBeenCalledOnce()
  })

  it('isolates a throwing rollback: later rollbacks still run and the start error wins', async () => {
    const { kernel, logger, state } = fakeKernel()
    const order: string[] = []
    const steps: LifecycleStep[] = [
      { name: 'storage', start: async () => {}, rollback: async () => { order.push('storage') } },
      { name: 'bad', start: async () => {}, rollback: async () => { order.push('bad'); throw new Error('rollback failed') } },
      { name: 'transport', start: async () => { throw new Error('start failed') } },
    ]
    await expect(new Lifecycle(kernel, steps).start()).rejects.toThrow('start failed')
    expect(order).toEqual(['bad', 'storage'])
    expect(logger.error).toHaveBeenCalledOnce()
    expect(state.connState).toBe('closed')
  })
})
