/**
 * Conversation hand-over between replicas against a REAL Redis server: RedisCoordinator
 * (turns), RedisStore (checkpoints) and RedisDurability (inbox/outbox) shared by two bots.
 *
 * Skipped unless BOTWA_TEST_REDIS_URL is set (see integration.test.ts / CONTRIBUTING):
 *
 *   docker run -d --rm --name botwa-it-redis -p 127.0.0.1:56379:6379 redis:7-alpine
 *   BOTWA_TEST_REDIS_URL=redis://127.0.0.1:56379 pnpm --filter @bot-wa/redis-store test
 *
 * Every test uses its own key prefix and deletes it afterwards. The kill -9 test runs the
 * dying replica in a child process and needs the package built (`lib/`).
 */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from 'redis'
import { Bot, flow, type BotConfig, type ConversationHandoverConfig } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import { RedisCoordinator, RedisDurability, RedisStore, type NativeRedisClient } from '../src/index.js'

const REDIS_URL = process.env.BOTWA_TEST_REDIS_URL
const RUN = `botwa-ho-it:${process.pid}-${randomUUID().slice(0, 8)}`
let n = 0
const nextPrefix = (tag: string) => `${RUN}:${tag}${++n}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const texts = (...ps: MockProvider[]) => ps.flatMap((p) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : `[${m.content.kind}]`)))
const CHILD = fileURLToPath(new URL('./fixtures/handover-child.mjs', import.meta.url))
const BUILT = existsSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)))

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

describe.skipIf(!REDIS_URL)('conversation hand-over (real Redis)', { timeout: 30_000 }, () => {
  let admin: NativeRedisClient
  const cleanups: Array<() => Promise<unknown>> = []
  const children: ChildProcess[] = []

  beforeAll(async () => {
    admin = createClient({ url: REDIS_URL })
    await admin.connect()
  })

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    for (const c of cleanups.reverse()) await c().catch(() => {})
    for await (const batch of admin.scanIterator({ MATCH: `${RUN}:*`, COUNT: 500 })) {
      const keys = Array.isArray(batch) ? batch : [batch]
      if (keys.length) await admin.del(keys)
    }
    await admin.quit()
  })

  interface ReplicaOpts { durable?: boolean; settleMs?: number; handover?: ConversationHandoverConfig }

  /** One replica: its own connections (store, coordinator, journal) on the shared prefix. */
  function replica(prefix: string, id: string, o: ReplicaOpts = {}) {
    const provider = new MockProvider()
    const store = new RedisStore({ url: REDIS_URL, prefix })
    const coordinator = new RedisCoordinator({ url: REDIS_URL, prefix, replicaId: id, leaseMs: 1_000, maxPollMs: 20 })
    const bot = new Bot({
      provider, store, logger: silent(),
      coordination: {
        coordinator,
        ...(o.settleMs !== undefined ? { settleMs: o.settleMs } : {}),
        ...(o.handover ? { handover: o.handover } : {}),
      },
      ...(o.durable === false ? {} : {
        durability: { journal: new RedisDurability({ url: REDIS_URL, prefix }), instanceId: id, pollMs: 20, inbox: { leaseMs: 1_000 } },
      }),
    })
    cleanups.push(() => bot.stop())
    return { bot, provider, store, coordinator }
  }

  function signup(r: ReturnType<typeof replica>, opts: { persistent?: boolean; validate?: () => Promise<true> } = {}) {
    let f = flow('signup')
    if (opts.persistent !== false) f = f.persistent()
    r.bot.use(f
      .say('hi')
      .ask('name?', 'name', opts.validate ? { validate: opts.validate } : undefined)
      .ask('email?', 'email')
      .say((_ctx, c) => `done ${String(c.state.name)} ${String(c.state.email)}`))
    return r
  }

  const checkpoint = async (store: RedisStore, key: string) =>
    (await store.listCheckpoints()).find(([k]) => k === key || k.endsWith(`|${key}`))?.[1]

  it('a step cut short after its first answer continues with that answer on the other replica (durability)', async () => {
    const prefix = nextPrefix('answer')
    let slow = true
    const validate = async (): Promise<true> => { if (slow) { slow = false; await sleep(500) } return true }
    const a = signup(replica(prefix, 'a', { settleMs: 50 }), { validate })
    const b = signup(replica(prefix, 'b'), { validate })
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']), { timeout: 5_000 })
    a.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(async () => expect((await checkpoint(a.store, 'c1'))?.answer?.inboundId).toEqual(expect.any(String)), { timeout: 5_000 })
    await vi.waitFor(async () => {
      const recs = await a.bot.durability!.inbox.list()
      expect(recs.every((r) => r.state === 'done')).toBe(true)
    }, { timeout: 5_000 })
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']), { timeout: 5_000 })
    await sleep(600)
    expect(texts(a.provider)).toEqual(['hi', 'name?'])
  })

  it("flows: 'forward' continues a non-persistent flow after its replica crashed", async () => {
    const prefix = nextPrefix('forward')
    const a = signup(replica(prefix, 'a', { durable: false, handover: { flows: 'forward' } }), { persistent: false })
    const b = signup(replica(prefix, 'b', { durable: false, handover: { flows: 'forward' } }), { persistent: false })
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']), { timeout: 5_000 })
    await vi.waitFor(async () => expect(await checkpoint(a.store, 'c1')).toMatchObject({ parked: true, handover: { kind: 'ephemeral' } }), { timeout: 5_000 })
    a.coordinator.simulateCrash()
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']), { timeout: 5_000 })
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']), { timeout: 5_000 })
    await vi.waitFor(async () => expect(await checkpoint(b.store, 'c1')).toBeUndefined(), { timeout: 5_000 })
  })

  it("fallback 'notify' tells the user when an async conversation's replica crashed", async () => {
    const prefix = nextPrefix('notify')
    const make = (id: string) => {
      const r = replica(prefix, id, { handover: { fallback: 'notify', notifyMessage: 'start again please' } })
      r.bot.conversation('quiz', async (c) => { await c.ask('q1?'); await c.ask('q2?') }, { trigger: 'quiz' })
      return r
    }
    const a = make('a')
    const b = make('b')
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('quiz', { from: 'c1' })
    await vi.waitFor(async () => expect((await checkpoint(a.store, 'c1'))?.handover?.kind).toBe('stub'), { timeout: 5_000 })
    a.coordinator.simulateCrash()
    b.provider.incoming('42', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['start again please']), { timeout: 5_000 })
    await vi.waitFor(async () => expect(await checkpoint(b.store, 'c1')).toBeUndefined(), { timeout: 5_000 })
  })

  it.skipIf(!BUILT)('kill -9 mid-step: the journaled answer is replayed on the survivor and the flow goes on', async () => {
    const prefix = nextPrefix('kill')
    const child = spawn(process.execPath, [CHILD, REDIS_URL!, prefix, 'c9'], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('answered')) resolve() })
      child.once('exit', (code) => reject(new Error(`child exited early (${code})`)))
    })
    const b = signup(replica(prefix, 'b'), { validate: async () => true })
    await b.bot.start()
    child.kill('SIGKILL')
    // The child's inbox lease lapses; B replays the answer record, which IS the recorded answer.
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']), { timeout: 10_000 })
    b.provider.incoming('ana@x.co', { from: 'c9' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']), { timeout: 5_000 })
  }, 30_000)
})
