/**
 * Conversation hand-over between replicas with a REAL PostgreSQL holding the checkpoints
 * (PostgresStore) and the inbox/outbox journal (PostgresDurability); coordination runs
 * in-process (MemoryCoordinationHub). Opt-in: skipped unless BOTWA_TEST_POSTGRES_URL is
 * set (see integration.test.ts for the docker command). Every replica pair gets its own
 * random table prefix; all of them are dropped afterwards.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import {
  Bot, MemoryCoordinationHub, MemoryCoordinator, flow,
  type BotConfig, type ConversationHandoverConfig, type DurabilityBackend,
} from '@botmesh/core'
import { CrashableProvider, crashable } from '@botmesh/core/testing'
import { PostgresDurability, PostgresStore } from '../src/index.js'

const URL = process.env.BOTWA_TEST_POSTGRES_URL
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const texts = (...ps: CrashableProvider[]) => ps.flatMap((p) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind)))

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

describe.skipIf(!URL)('conversation hand-over — real PostgreSQL', { timeout: 30_000 }, () => {
  const run = `itho${randomBytes(4).toString('hex')}_`
  let n = 0
  // application_name keeps this pool out of integration.test.ts' "kill idle backends" test.
  const pool = URL ? new pg.Pool({ connectionString: URL, max: 10, application_name: 'botwa-handover-it' }) : (undefined as unknown as pg.Pool)
  pool?.on('error', () => {})
  const bots: Bot[] = []

  afterEach(async () => {
    for (const b of bots.splice(0)) await Promise.race([b.stop().catch(() => {}), sleep(1_000)])
  })

  afterAll(async () => {
    const { rows } = await pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE tablename LIKE $1`, [`${run}%`])
    for (const { tablename } of rows) await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`)
    await pool.end()
  })

  async function backends() {
    const tablePrefix = `${run}${n++}_`
    const store = new PostgresStore({ pool, tablePrefix })
    const journal = new PostgresDurability({ pool, tablePrefix })
    return { hub: new MemoryCoordinationHub(), store, journal }
  }
  type Backends = Awaited<ReturnType<typeof backends>>

  function replica(s: Backends, id: string, o: { journal?: DurabilityBackend; settleMs?: number; handover?: ConversationHandoverConfig } = {}) {
    const provider = new CrashableProvider()
    const coordinator = new MemoryCoordinator({ hub: s.hub, replicaId: id })
    const bot = new Bot({
      provider, store: s.store, logger: silent(),
      coordination: { coordinator, ...(o.settleMs !== undefined ? { settleMs: o.settleMs } : {}), ...(o.handover ? { handover: o.handover } : {}) },
      durability: { journal: o.journal ?? s.journal, instanceId: id, pollMs: 20, inbox: { leaseMs: 500 } },
    })
    bots.push(bot)
    return { bot, provider, coordinator }
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

  const checkpoint = async (store: PostgresStore, key: string) =>
    (await store.listCheckpoints()).find(([k]) => k === key || k.endsWith(`|${key}`))?.[1]

  it('a crash right after the prompt: the record is replayed on the survivor, the prompt is not repeated', async () => {
    const s = await backends()
    const journalA = crashable(s.journal)
    const a = signup(replica(s, 'a', { journal: journalA }))
    const b = signup(replica(s, 'b'))
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']), { timeout: 5_000 })
    journalA.crash(); a.provider.crash(); a.coordinator.crash()
    await sleep(800)                                         // A's inbox lease lapses; B may replay
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']), { timeout: 5_000 })
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']), { timeout: 5_000 })
    expect(texts(a.provider, b.provider).filter((t) => t === 'name?')).toHaveLength(1)
  })

  it('a step cut short after its first answer continues with that answer on the other replica', async () => {
    const s = await backends()
    let slow = true
    const validate = async (): Promise<true> => { if (slow) { slow = false; await sleep(500) } return true }
    const a = signup(replica(s, 'a', { settleMs: 50 }), { validate })
    const b = signup(replica(s, 'b'), { validate })
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']), { timeout: 5_000 })
    a.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(async () => expect((await checkpoint(s.store, 'c1'))?.answer?.inboundId).toEqual(expect.any(String)), { timeout: 5_000 })
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']), { timeout: 5_000 })
    await sleep(600)
    expect(texts(a.provider)).toEqual(['hi', 'name?'])
  })

  it("flows: 'forward' continues a non-persistent flow after a graceful stop", async () => {
    const s = await backends()
    const a = signup(replica(s, 'a', { handover: { flows: 'forward' } }), { persistent: false })
    await a.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']), { timeout: 5_000 })
    await vi.waitFor(async () => expect(await checkpoint(s.store, 'c1')).toMatchObject({ parked: true, handover: { kind: 'ephemeral' } }), { timeout: 5_000 })
    await a.bot.stop()
    const b = signup(replica(s, 'b', { handover: { flows: 'forward' } }), { persistent: false })
    await b.bot.start()
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']), { timeout: 5_000 })
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']), { timeout: 5_000 })
  })
})
