/**
 * RedisCoordinator — multi-replica integration tests against a REAL Redis server.
 *
 * Skipped unless BOTWA_TEST_REDIS_URL is set (see integration.test.ts / CONTRIBUTING):
 *
 *   docker run -d --rm --name botwa-it-redis -p 127.0.0.1:56379:6379 redis:7-alpine
 *   BOTWA_TEST_REDIS_URL=redis://127.0.0.1:56379 pnpm --filter @bot-wa/redis-store test
 *
 * Every test uses its own key prefix (`botwa-co-it:<uuid>:…`) and deletes it afterwards.
 * The failover test runs the dying replica in a child process (started, and killed, by
 * the test) and needs the package built (`lib/`).
 */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from 'redis'
import { Bot, LeaseLostError, flow, type Coordinator, type Ticket } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import { RedisCoordinator, RedisStore, type CoordinatorClient, type NativeRedisClient } from '../src/index.js'
import { RELEASE_TURN_SCRIPT } from '../src/coordScripts.js'

const REDIS_URL = process.env.BOTWA_TEST_REDIS_URL
const RUN = `botwa-co-it:${process.pid}-${randomUUID().slice(0, 8)}`
let n = 0
const nextPrefix = (tag: string) => `${RUN}:${tag}${++n}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const texts = (p: MockProvider) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : `[${m.content.kind}]`))
const HOLDER = fileURLToPath(new URL('./fixtures/coord-holder.mjs', import.meta.url))
const BUILT = existsSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)))

/** Wrap a coordinator so the test can wait until N reservations reached Redis (= ingress order). */
function counting(inner: Coordinator) {
  let count = 0
  const wrapped: Coordinator = {
    replicaId: inner.replicaId,
    start: () => inner.start(),
    stop: () => inner.stop(),
    acquireTurn: (t, o) => inner.acquireTurn(t, o),
    lead: (name, o) => inner.lead(name, o),
    tryLead: (name) => inner.tryLead(name),
    on: (e, l) => inner.on(e, l),
    reserve: async (key: string): Promise<Ticket> => { const t = await inner.reserve(key); count++; return t },
  }
  return { coordinator: wrapped, reserved: () => count }
}

describe.skipIf(!REDIS_URL)('RedisCoordinator (real Redis)', () => {
  let admin: NativeRedisClient
  const cleanups: Array<() => Promise<unknown>> = []
  const children: ChildProcess[] = []

  beforeAll(async () => {
    admin = createClient({ url: REDIS_URL })
    await admin.connect()
  })

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill()
    for (const c of cleanups.reverse()) await c().catch(() => {})
    for await (const batch of admin.scanIterator({ MATCH: `${RUN}:*`, COUNT: 500 })) {
      const keys = Array.isArray(batch) ? batch : [batch]
      if (keys.length) await admin.del(keys)
    }
    await admin.quit()
  })

  /** One replica: its own connections (store + coordinator) on the shared prefix. */
  function replica(prefix: string, id: string, opts: { leaseMs?: number; exclusive?: boolean } = {}) {
    const provider = new MockProvider({ exclusiveSession: opts.exclusive })
    const store = new RedisStore({ url: REDIS_URL, prefix })
    const inner = new RedisCoordinator({ url: REDIS_URL, prefix, replicaId: id, leaseMs: opts.leaseMs ?? 3_000, maxPollMs: 20 })
    const { coordinator, reserved } = counting(inner)
    const bot = new Bot({ provider, store, coordination: { coordinator } })
    cleanups.push(() => bot.stop())
    return { bot, provider, store, coordinator: inner, reserved }
  }

  it('two replicas keep 200 interleaved messages of one chat in ingress order, never overlapping, with growing fences', async () => {
    const prefix = nextPrefix('order')
    const a = replica(prefix, 'a')
    const b = replica(prefix, 'b')
    const log: Array<{ body: string; start: number; end: number }> = []
    for (const r of [a, b]) {
      r.bot.onMessage(async (ctx) => {
        const start = performance.now()
        await sleep(Math.floor(Math.random() * 20))
        log.push({ body: ctx.body, start, end: performance.now() })
      })
      await r.bot.start()
    }
    const N = 200
    for (let i = 0; i < N; i++) {
      const r = i % 2 === 0 ? a : b
      const before = r.reserved()
      r.provider.incoming(`m${i}`, { from: 'chat-1', id: `id-${i}` })
      await vi.waitFor(() => expect(r.reserved()).toBe(before + 1), { interval: 1, timeout: 5_000 })
    }
    await vi.waitFor(() => expect(log).toHaveLength(N), { timeout: 60_000, interval: 50 })
    expect(log.map((e) => e.body)).toEqual(Array.from({ length: N }, (_, i) => `m${i}`))
    for (let i = 1; i < N; i++) expect(log[i]!.start).toBeGreaterThanOrEqual(log[i - 1]!.end)
    expect(Number(await admin.get(`${prefix}:co:t:chat-1:seq`))).toBe(N)
  }, 90_000)

  it('does not serialize different chats', async () => {
    const prefix = nextPrefix('chats')
    const a = replica(prefix, 'a')
    const b = replica(prefix, 'b')
    let running = 0
    let maxRunning = 0
    const perChat = new Map<string, string[]>()
    for (const r of [a, b]) {
      r.bot.onMessage(async (ctx) => {
        maxRunning = Math.max(maxRunning, ++running)
        await sleep(30)
        perChat.set(ctx.from, [...(perChat.get(ctx.from) ?? []), ctx.body])
        running--
      })
      await r.bot.start()
    }
    for (let i = 0; i < 4; i++) {
      for (let c = 0; c < 5; c++) {
        const r = (i + c) % 2 === 0 ? a : b
        const before = r.reserved()
        r.provider.incoming(`${i}`, { from: `chat-${c}`, id: `c${c}-${i}` })
        await vi.waitFor(() => expect(r.reserved()).toBe(before + 1), { interval: 1 })
      }
    }
    await vi.waitFor(() => expect([...perChat.values()].flat()).toHaveLength(20), { timeout: 20_000 })
    for (let c = 0; c < 5; c++) expect(perChat.get(`chat-${c}`)).toEqual(['0', '1', '2', '3'])
    expect(maxRunning).toBeGreaterThan(1)
  }, 30_000)

  it.skipIf(!BUILT)('fails over when the replica holding a chat dies (child process killed)', async () => {
    const prefix = nextPrefix('failover')
    const leaseMs = 1_000
    const child = spawn(process.execPath, [HOLDER, REDIS_URL!, prefix, 'chat-f', String(leaseMs)], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('held')) resolve() })
      child.once('exit', (code) => reject(new Error(`holder exited early (${code})`)))
    })
    const b = replica(prefix, 'b', { leaseMs })
    const handled: string[] = []
    b.bot.onMessage(async (ctx) => { handled.push(ctx.body) })
    await b.bot.start()
    b.provider.incoming('waiting', { from: 'chat-f', id: 'f1' })
    await sleep(300)
    expect(handled).toEqual([])                     // the child holds the chat
    const killedAt = performance.now()
    child.kill('SIGKILL')
    await vi.waitFor(() => expect(handled).toEqual(['waiting']), { timeout: leaseMs * 3, interval: 20 })
    expect(performance.now() - killedAt).toBeLessThan(leaseMs * 1.5 + 500)
  }, 20_000)

  it('fails over in-process too (simulateCrash: heartbeat stops, nothing released)', async () => {
    const prefix = nextPrefix('crash')
    const leaseMs = 600
    const dying = new RedisCoordinator({ url: REDIS_URL, prefix, replicaId: 'dying', leaseMs })
    cleanups.push(() => dying.stop())
    await dying.start()
    const held = await dying.acquireTurn(await dying.reserve('chat-c'))
    const b = replica(prefix, 'b', { leaseMs })
    const handled: string[] = []
    b.bot.onMessage(async (ctx) => { handled.push(ctx.body) })
    await b.bot.start()
    b.provider.incoming('next', { from: 'chat-c', id: 'c1' })
    await sleep(200)
    expect(handled).toEqual([])
    dying.simulateCrash()
    expect(held.signal.aborted).toBe(true)
    await vi.waitFor(() => expect(handled).toEqual(['next']), { timeout: leaseMs * 3, interval: 20 })
  }, 20_000)

  it('a replica stalled past its lease gives the chat up: its late send rejects and the other replica proceeds', async () => {
    const prefix = nextPrefix('stall')
    const leaseMs = 400
    const a = replica(prefix, 'a', { leaseMs })
    const b = replica(prefix, 'b', { leaseMs })
    let lateError: unknown
    let stalled!: () => void
    const done = new Promise<void>((resolve) => { stalled = resolve })
    a.bot.onMessage(async (ctx) => {
      const until = Date.now() + leaseMs * 2
      while (Date.now() < until) { /* blocks the event loop: no renewals */ }
      try { await ctx.reply('late') } catch (error) { lateError = error }
      stalled()
    })
    const handledByB: string[] = []
    b.bot.onMessage(async (ctx) => { handledByB.push(ctx.body) })
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('first', { from: 'chat-s', id: 's1' })
    await vi.waitFor(() => expect(a.reserved()).toBe(1), { interval: 1 })
    await sleep(20)
    await done
    expect(lateError).toBeInstanceOf(LeaseLostError)
    expect(a.provider.outbox).toHaveLength(0)
    b.provider.incoming('second', { from: 'chat-s', id: 's2' })
    await vi.waitFor(() => expect(handledByB).toEqual(['second']), { timeout: 5_000 })
  }, 20_000)

  it('runs an exclusive-session provider on one replica and hands it over when the leader stops', async () => {
    const prefix = nextPrefix('lead')
    const leaseMs = 800
    const a = replica(prefix, 'a', { leaseMs, exclusive: true })
    const b = replica(prefix, 'b', { leaseMs, exclusive: true })
    await a.bot.start()
    await vi.waitFor(() => expect(a.provider.starts).toBe(1))
    await b.bot.start()
    await sleep(leaseMs)
    expect(b.provider.starts).toBe(0)
    const stoppedAt = performance.now()
    await a.bot.stop()
    await vi.waitFor(() => expect(b.provider.starts).toBe(1), { timeout: leaseMs * 2 })
    expect(performance.now() - stoppedAt).toBeLessThan(leaseMs)   // released, not expired
    expect(Number(await admin.get(`${prefix}:co:lead:provider:mock:term`))).toBe(2)
  }, 20_000)

  it('a persistent flow started on one replica continues on the other through the shared store', async () => {
    const prefix = nextPrefix('flow')
    const make = (id: string) => {
      const r = replica(prefix, id)
      r.bot.use(flow('signup').persistent().say('hi').ask('name?', 'name').ask('email?', 'email')
        .say((_ctx, c) => `done ${String(c.state.name)} ${String(c.state.email)}`))
      return r
    }
    const a = make('a')
    const b = make('b')
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'chat-p', id: 'p1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    b.provider.incoming('Ana', { from: 'chat-p', id: 'p2' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']))
    a.provider.incoming('ana@x.co', { from: 'chat-p', id: 'p3' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?', 'done Ana ana@x.co']))
    await vi.waitFor(async () => expect(await admin.keys(`${prefix}:cp:*`)).toEqual([]))   // flow finished: checkpoint cleared
  }, 20_000)
  /** Two raw coordinators on one prefix; `a` goes through `wrap` (e.g. to fail one EVAL). */
  async function rawPair(tag: string, leaseMs: number, wrap?: (c: NativeRedisClient) => CoordinatorClient) {
    const prefix = nextPrefix(tag)
    const ca = createClient({ url: REDIS_URL }) as NativeRedisClient
    await ca.connect()
    cleanups.push(() => ca.quit())
    const a = new RedisCoordinator({ client: wrap ? wrap(ca) : ca, prefix, replicaId: 'a', leaseMs, maxPollMs: 10 })
    const b = new RedisCoordinator({ url: REDIS_URL, prefix, replicaId: 'b', leaseMs, maxPollMs: 10 })
    cleanups.push(() => a.stop(), () => b.stop())
    await a.start(); await b.start()
    return { prefix, a, b }
  }

  it('after a failover the next turn names the dead holder (real scripts)', async () => {
    const { a, b } = await rawPair('skiplast', 600)
    await (await a.acquireTurn(await a.reserve('k'))).release()
    await b.acquireTurn(await b.reserve('k'))
    const ta = await a.reserve('k')
    b.simulateCrash()                                     // heartbeat and owner lapse server-side
    const turn = await a.acquireTurn(ta, { maxWaitMs: 5_000 })
    expect(turn.previousHolder).toBe(b.incarnation)
    await turn.release()
  }, 20_000)

  it('repairs a release that failed on the wire (real scripts)', async () => {
    let failRelease = false
    const { a, b } = await rawPair('repair', 300, (c) => ({
      eval: async (script: string, o?: { keys?: string[]; arguments?: string[] }) => {
        if (failRelease && script === RELEASE_TURN_SCRIPT) { failRelease = false; throw new Error('ECONNRESET') }
        return c.eval(script, o)
      },
    }))
    const turn = await a.acquireTurn(await a.reserve('k'))
    const tb = await b.reserve('k')
    failRelease = true
    await expect(turn.release()).rejects.toThrow('ECONNRESET')
    const next = await b.acquireTurn(tb, { maxWaitMs: 3_000 })   // a is alive: only the repair frees it
    expect(next.previousHolder).toBeNull()
    await next.release()
  }, 20_000)
})
