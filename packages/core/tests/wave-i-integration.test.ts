/**
 * The round-I opt-ins together: multi-replica coordination, the durable inbox/outbox and
 * the persistent scheduler on the decomposed Bot (lifecycle steps, inbound/outbound seams).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Bot, MemoryCoordinationHub, MemoryCoordinator, MemoryDurability, MemoryScheduleStore, MemoryStore, ProviderNotLeaderError,
  type BotConfig,
} from '../src/index.js'
import { MockProvider } from '../src/testing/index.js'

const bots: Bot[] = []
afterEach(async () => {
  for (const b of bots.splice(0)) await b.stop().catch(() => {})
  vi.useRealTimers()
})

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

const texts = (p: MockProvider) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind))

function replica(
  shared: { hub: MemoryCoordinationHub; store: MemoryStore; journal: MemoryDurability; schedules: MemoryScheduleStore },
  id: string,
  extra: Partial<BotConfig> = {},
  providerOpts: ConstructorParameters<typeof MockProvider>[0] = {},
) {
  const provider = new MockProvider(providerOpts)
  const coordinator = new MemoryCoordinator({ hub: shared.hub, replicaId: id })
  const bot = new Bot({
    provider,
    store: shared.store,
    botId: 'shop',
    logger: silent(),
    coordination: { coordinator },
    durability: { journal: shared.journal, instanceId: id, pollMs: 10, outbox: { backoff: { baseMs: 5, capMs: 20, jitter: 0 } } },
    scheduler: { store: shared.schedules, tickMs: 20 },
    ...extra,
  })
  bots.push(bot)
  return { bot, provider, coordinator }
}

function sharedBackends() {
  return { hub: new MemoryCoordinationHub(), store: new MemoryStore(), journal: new MemoryDurability(), schedules: new MemoryScheduleStore() }
}

describe('coordination + durability + durable scheduler on one bot', () => {
  it('two replicas process one chat in order, journal every message and reply exactly once', async () => {
    const shared = sharedBackends()
    const a = replica(shared, 'a')
    const b = replica(shared, 'b')
    for (const r of [a, b]) r.bot.onMessage(async (ctx) => { await ctx.reply(`echo ${ctx.body}`) })
    await a.bot.start()
    await b.bot.start()

    const bodies = ['1', '2', '3', '4', '5', '6']
    bodies.forEach((body, i) => (i % 2 === 0 ? a.provider : b.provider).incoming(body, { from: 'u1', id: `m${i}` }))
    await vi.waitFor(() => expect(texts(a.provider).length + texts(b.provider).length).toBe(6))
    // Per-replica order follows ingress order; nothing is sent twice.
    const all = [...texts(a.provider), ...texts(b.provider)]
    expect(new Set(all).size).toBe(6)
    expect(texts(a.provider)).toEqual(['echo 1', 'echo 3', 'echo 5'])
    expect(texts(b.provider)).toEqual(['echo 2', 'echo 4', 'echo 6'])
    await vi.waitFor(async () => {
      // One namespace, one journal scope: both replicas see the same six records.
      expect(a.bot.durability!.scope).toBe(b.bot.durability!.scope)
      const states = (await a.bot.durability!.inbox.list()).map((r) => r.state)
      expect(states).toEqual(['done', 'done', 'done', 'done', 'done', 'done'])
    })
  })

  it('a redelivery that reaches the other replica is deduplicated by the shared inbox journal', async () => {
    const shared = sharedBackends()
    const a = replica(shared, 'a')
    const b = replica(shared, 'b')
    const handled: string[] = []
    for (const r of [a, b]) r.bot.onMessage(async (ctx) => { handled.push(ctx.body); await ctx.reply('ok') })
    await a.bot.start()
    await b.bot.start()
    a.provider.incoming('hola', { from: 'u1', id: 'wamid-1' })
    await vi.waitFor(async () => expect((await a.bot.durability!.inbox.list())[0]?.state).toBe('done'))
    b.provider.incoming('hola', { from: 'u1', id: 'wamid-1' })   // webhook retry on the other replica
    await vi.waitFor(() => expect(b.bot.durability!.metrics().inboundDuplicates).toBe(1))
    expect(handled).toEqual(['hola'])
    expect(texts(a.provider).length + texts(b.provider).length).toBe(1)
  })

    it('a standby (leader provider session) never sends from its outbox sweeper; the leader delivers', async () => {
    const shared = sharedBackends()
    const leader = replica(shared, 'a', {}, { exclusiveSession: true })
    await leader.bot.start()
    await vi.waitFor(() => expect(leader.provider.starts).toBe(1))
    const standby = replica(shared, 'b', {}, { exclusiveSession: true })
    await standby.bot.start()
    expect(standby.provider.starts).toBe(0)

    // An inline send on the standby is refused by the coordination fence.
    await expect(standby.bot.send('u1', 'direct')).rejects.toBeInstanceOf(ProviderNotLeaderError)
    expect(standby.provider.outbox).toEqual([])
    // Both bots share the namespace, so one journal scope: the leader's sweeper picks up
    // what the standby queued.
    expect(await standby.bot.enqueue('u1', 'queued on standby', { idempotencyKey: 'reminder:1' })).toMatchObject({ status: 'queued' })
    await vi.waitFor(() => expect(texts(leader.provider)).toContain('queued on standby'), { timeout: 5_000 })
    expect(standby.provider.outbox).toEqual([])
  })

  it('a durable task runs once per slot across replicas, led through the coordinator', async () => {
    const shared = sharedBackends()
    const ran: string[] = []
    const a = replica(shared, 'a', { durability: undefined })
    const b = replica(shared, 'b', { durability: undefined })
    a.bot.every(60, { id: 'tick' }, () => { ran.push('a') })
    b.bot.every(60, { id: 'tick' }, () => { ran.push('b') })
    await a.bot.start()
    await b.bot.start()
    await vi.waitFor(() => expect(ran.length).toBeGreaterThanOrEqual(3), { timeout: 5_000 })
    // Leadership through the shared coordinator: the leader runs every slot on time.
    expect(new Set(ran).size).toBe(1)
  })
})
