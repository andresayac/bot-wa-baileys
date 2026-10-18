import { describe, it, expect } from 'vitest'
import { Bot } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import { BotManager, MemoryBotConfigStore, type BotConfigRecord, type BotFactory, type FlowDocument } from '../src/index.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class SlowBot {
  started = false
  starts = 0
  stops = 0
  failStart = false
  startGate?: Promise<void>
  constructor(readonly config?: BotConfigRecord) {}
  async start(): Promise<void> {
    this.starts++
    if (this.startGate) await this.startGate
    if (this.failStart) throw new Error('start failed')
    this.started = true
  }
  async stop(): Promise<void> { this.stops++; this.started = false }
}

describe('BotManager concurrency', () => {
  it('createBot reserves the id: a concurrent create for another tenant gets CONFLICT and changes nothing', async () => {
    const store = new MemoryBotConfigStore()
    const made: SlowBot[] = []
    const factory: BotFactory = async (cfg) => { await sleep(5); const b = new SlowBot(cfg as BotConfigRecord); made.push(b); return b }
    const manager = new BotManager({ factory, configStore: store })
    const results = await Promise.allSettled([
      manager.createBot({ id: 'x', tenantId: 'acme' }),
      manager.createBot({ id: 'x', tenantId: 'evil' }),
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } })
    expect(manager.status('x')!.tenantId).toBe('acme')
    expect(manager.getConfig('x')!.tenantId).toBe('acme')
    expect((await store.get('x'))!.tenantId).toBe('acme')
    expect(made).toHaveLength(1)
    await manager.shutdown()
  })

  it('a plain add() cannot steal an id reserved by an in-flight createBot', async () => {
    const factory: BotFactory = async () => { await sleep(5); return new SlowBot() }
    const manager = new BotManager({ factory, configStore: new MemoryBotConfigStore() })
    const pending = manager.createBot({ id: 'r' })
    expect(() => manager.add(new SlowBot(), { id: 'r' })).toThrow(/already registered/)
    await pending
    await manager.shutdown()
  })

  it('serializes config mutations: a flow added during a rebuilding update is kept (config and live bot)', async () => {
    const store = new MemoryBotConfigStore()
    const manager = new BotManager({
      configStore: store,
      factory: async () => { await sleep(5); return new Bot({ provider: new MockProvider() }) },
    })
    await manager.createBot({ id: 'y' })
    const flow: FlowDocument = { version: 1, id: 'hola', trigger: 'hola', steps: [{ kind: 'say', text: 'hi' }] }
    await Promise.all([
      manager.updateBot('y', { provider: { type: 'v2' } }),
      manager.addFlow('y', flow),
    ])
    const config = manager.getConfig('y')!
    expect(config.flows?.map((f) => f.id)).toEqual(['hola'])
    expect(config.version).toBe(3)
    expect((manager.get('y') as Bot).hasFlow('hola')).toBe(true)
    expect((await store.get('y'))!.flows?.map((f) => f.id)).toEqual(['hola'])
    await manager.shutdown()
  })

  it('expectedVersion is checked atomically: only one of two concurrent updates wins', async () => {
    const factory: BotFactory = async () => { await sleep(5); return new SlowBot() }
    const manager = new BotManager({ factory, configStore: new MemoryBotConfigStore() })
    await manager.createBot({ id: 'v' })
    const results = await Promise.allSettled([
      manager.updateBot('v', { provider: { type: 'a' } }, { expectedVersion: 1 }),
      manager.updateBot('v', { provider: { type: 'b' } }, { expectedVersion: 1 }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')[0]).toMatchObject({ reason: { code: 'CONFLICT' } })
    await manager.shutdown()
  })

  it('remove() waits for an in-flight start and stops the bot', async () => {
    const manager = new BotManager()
    const bot = new SlowBot()
    let release!: () => void
    bot.startGate = new Promise<void>((r) => { release = r })
    manager.add(bot, { id: 'z' })
    const starting = manager.start('z').catch((e: unknown) => e)
    await sleep(1)
    expect(bot.starts).toBe(1)
    const removing = manager.remove('z')
    release()
    expect(await removing).toBe(true)
    await starting
    expect(manager.has('z')).toBe(false)
    expect(manager.isRunning('z')).toBe(false)
    expect(bot.started).toBe(false)
  })

  it('a bot whose start failed is stopped when it is replaced or removed', async () => {
    const made: SlowBot[] = []
    const factory: BotFactory = () => { const b = new SlowBot(); b.failStart = made.length === 0; made.push(b); return b }
    const manager = new BotManager({ factory, configStore: new MemoryBotConfigStore() })
    await manager.createBot({ id: 'f' })
    expect(manager.isRunning('f')).toBe(false)
    await manager.restart('f', { recreate: true })
    expect(made).toHaveLength(2)
    expect(made[0].stops).toBe(1)
    expect(manager.isRunning('f')).toBe(true)

    const plain = new SlowBot()
    plain.failStart = true
    manager.add(plain, { id: 'p' })
    await expect(manager.start('p')).rejects.toThrow('start failed')
    await manager.remove('p')
    expect(plain.stops).toBe(1)
    await manager.shutdown()
  })
})
