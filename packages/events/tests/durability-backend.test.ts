/**
 * `@botmesh/events/durability`: an events journal as a bot's durability backend. It must pass
 * the same conformance suite and crash-recovery matrix as the core backends.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Bot, MemoryStore, StaleLeaseError, flow } from '@botmesh/core'
import { CrashableProvider, MockProvider, crashable } from '@botmesh/core/testing'
import { runDurabilityConformance } from '../../../test-utils/durability-conformance.js'
import { runCrashRecoveryMatrix, type CrashMatrixDeps } from '../../../test-utils/durability-crash.js'
import { EventWorker, FileEventJournal, MemoryEventJournal } from '../src/index.js'
import { eventsDurability } from '../src/durability.js'

function tempFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'botwa-events-dur-'))
  return { file: join(dir, 'events.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

runDurabilityConformance('eventsDurability(MemoryEventJournal)', {
  async make() {
    const backend = eventsDurability({ journal: new MemoryEventJournal() })
    await backend.start()
    return { backend, teardown: () => backend.stop() }
  },
})

runDurabilityConformance('eventsDurability(FileEventJournal)', {
  async make() {
    const { file, cleanup } = tempFile()
    const journal = await FileEventJournal.open(file, { lock: true })
    const backend = eventsDurability({ journal })
    await backend.start()
    return { backend, teardown: async () => { await backend.stop(); await journal.close(); cleanup() } }
  },
})

const deps = { Bot, MemoryStore, MockProvider, CrashableProvider, crashable, flow } as unknown as CrashMatrixDeps
runCrashRecoveryMatrix('eventsDurability(MemoryEventJournal)', deps, {
  async make() { return { backend: eventsDurability({ journal: new MemoryEventJournal() }), teardown: async () => {} } },
})
runCrashRecoveryMatrix('eventsDurability(FileEventJournal)', deps, {
  async make() {
    const { file, cleanup } = tempFile()
    const journal = await FileEventJournal.open(file, { lock: true })
    return { backend: eventsDurability({ journal }), teardown: async () => { await journal.close(); cleanup() } }
  },
})

function silentLogger(): never {
  const noop = () => {}
  const l: Record<string, unknown> = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, level: 'silent' }
  l.child = () => l
  return l as never
}

async function until(cond: () => Promise<boolean> | boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const texts = (p: MockProvider) => p.outbox.map((m) => (m.content as { text?: string }).text)

describe('eventsDurability with a bot', () => {
  it('a FileEventJournal survives a crash mid-handler: reopened, the event replays once and the outbox answers the first send', async () => {
    const { file, cleanup } = tempFile()
    try {
      const store = new MemoryStore()
      const journalA = await FileEventJournal.open(file, { lock: true })
      const a = crashable(eventsDurability({ journal: journalA }))
      const pa = new CrashableProvider(a)
      const botA = new Bot({ provider: pa, store, logger: silentLogger(), durability: { journal: a, instanceId: 'r1', pollMs: 20 } })
      botA.on('error', () => {})
      botA.when('hola', async (ctx) => {
        await ctx.reply('uno')
        a.crash()
        await new Promise(() => {})
      })
      await botA.start()
      pa.incoming('hola', { from: 'u1', id: 'm1' })
      await a.whenCrashed

      // "Restart": the dead process's journal is gone (closing it frees this process's claim
      // on the file; the crashed wrapper never touches it again), and a new one opens the file.
      await expect(FileEventJournal.open(file, { lock: true })).rejects.toThrow(/already open in this process/)
      await journalA.close()
      const journalB = await FileEventJournal.open(file, { lock: true })
      const backendB = eventsDurability({ journal: journalB })
      const pb = new MockProvider()
      const botB = new Bot({ provider: pb, store, logger: silentLogger(), durability: { journal: backendB, instanceId: 'r1', pollMs: 20 } })
      let runs = 0
      botB.when('hola', async (ctx) => {
        runs++
        await ctx.reply('uno')
        await ctx.reply('dos')
      })
      await botB.start()
      const inbox = botB.durability!.inbox
      await until(async () => (await inbox.list({ state: 'done' })).length === 1, 'the replay')
      expect(runs).toBe(1)
      expect([...texts(pa), ...texts(pb)]).toEqual(['uno', 'dos'])
      expect((await journalB.list({ channel: 'botwa:durable' })).map((r) => r.state)).toEqual(['done'])
      await botB.stop()
      await journalB.close()
    } finally {
      cleanup()
    }
  })

  it('an operator replay from the events side is picked up by the bot sweeper; an EventWorker never sees bot records', async () => {
    const journal = new MemoryEventJournal()
    const p = new MockProvider()
    const bot = new Bot({ provider: p, logger: silentLogger(), durability: { journal: eventsDurability({ journal }), pollMs: 20 } })
    let runs = 0
    bot.when('hola', async (ctx) => { runs++; await ctx.reply('hi') })
    await bot.start()
    p.incoming('hola', { from: 'u1', id: 'm1' })
    await until(async () => (await bot.durability!.inbox.list({ state: 'done' })).length === 1, 'm1')

    const worker = new EventWorker(journal)
    worker.on('botwa.inbound.message', () => { throw new Error('a worker must never run a bot record') })
    await journal.replay((await journal.list({ channel: 'botwa:durable' }))[0].envelope.eventId)
    expect(await worker.runBatch()).toEqual({ processed: 0, failed: 0, stale: 0 })
    await until(() => runs === 2, 'the sweeper to replay it')
    await until(async () => (await bot.durability!.inbox.list({ state: 'done' })).length === 1, 'done again')
    expect(texts(p)).toEqual(['hi']) // the re-run's send was answered from the outbox
    await bot.stop()
  })

  it('records show up in the events journal with the bot envelope', async () => {
    const journal = new MemoryEventJournal()
    const backend = eventsDurability({ journal, context: { botId: 'shop' } })
    await backend.inbox.append({ id: 'e1', partitionKey: 'p', kind: 'message', payload: { body: 'x' }, receivedAt: 5, idempotencyKey: 'k' }, 5)
    const [record] = await journal.list()
    expect(record).toMatchObject({
      channel: 'botwa:durable', state: 'pending',
      envelope: { eventId: 'inbox::e1', eventType: 'botwa.inbound.message', occurredAt: 5, partitionKey: 'p', context: { botId: 'shop', tenantId: 'botwa' } },
    })
    expect(record.envelope.payload).toEqual({ id: 'e1', kind: 'message', payload: { body: 'x' }, idempotencyKey: 'k' })
  })

  it('fenced completions reject with the core StaleLeaseError', async () => {
    const backend = eventsDurability({ journal: new MemoryEventJournal() })
    await expect(backend.inbox.ack('nope', 1, 0)).rejects.toBeInstanceOf(StaleLeaseError)
    await backend.inbox.append({ id: 'e1', partitionKey: 'p', kind: 'message', payload: null, receivedAt: 1 }, 1, { owner: 'w', leaseMs: 100, now: 1 })
    await expect(backend.inbox.release('e1', 7, 2)).rejects.toBeInstanceOf(StaleLeaseError)
  })

  it('validates its journal', async () => {
    const { file, cleanup } = tempFile()
    try {
      const unlocked = await FileEventJournal.open(file)
      expect(() => eventsDurability({ journal: unlocked })).toThrow(/lock: true/)
      const plain = { append: async () => true } as never
      expect(() => eventsDurability({ journal: plain })).toThrow(/LeasedEventJournal/)
      const noSidecar = Object.assign(Object.create(MemoryEventJournal.prototype), new MemoryEventJournal(), { sidecar: undefined })
      expect(() => eventsDurability({ journal: noSidecar })).toThrow(/sidecar/)
      // one outbox sidecar per journal, shared by every bot on it
      const shared = new MemoryEventJournal()
      expect(() => { eventsDurability({ journal: shared }); eventsDurability({ journal: shared }) }).not.toThrow()
    } finally {
      cleanup()
    }
  })
})
