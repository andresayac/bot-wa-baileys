/**
 * SharedFileEventJournal: one JSON journal used by several processes at once. Every operation
 * runs under a cross-process mutex on the current file contents, so leases and fencing tokens
 * hold across processes; the bot's outbox lives in the same file. Exercised with several
 * journals on one file in this process, with real child processes, and as a bot backend.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bot, MemoryStore, flow } from '@botmesh/core'
import { CrashableProvider, MockProvider, crashable } from '@botmesh/core/testing'
import { runDurabilityConformance } from '../../../test-utils/durability-conformance.js'
import { runCrashRecoveryMatrix, type CrashMatrixDeps } from '../../../test-utils/durability-crash.js'
import { FileEventJournal, SharedFileEventJournal, StaleLeaseError, createEnvelope } from '../src/index.js'
import { eventsDurability } from '../src/durability.js'

const context = { tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'p', connectionId: 'c' }
const env = (id: string, occurredAt = 1) => createEnvelope({ eventId: id, eventType: 'test.event', occurredAt, context, payload: { id } })

function tempFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'botwa-events-shared-'))
  return { file: join(dir, 'events.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

let file: string
let cleanup: () => void
const open: SharedFileEventJournal[] = []
async function journal(options?: Parameters<typeof SharedFileEventJournal.open>[1]): Promise<SharedFileEventJournal> {
  const j = await SharedFileEventJournal.open(file, options)
  open.push(j)
  return j
}
beforeEach(() => { ({ file, cleanup } = tempFile()) })
afterEach(async () => {
  while (open.length) await open.pop()!.close()
  cleanup()
})

describe('SharedFileEventJournal: several journals on one file', () => {
  it('is not exclusive, and every journal sees the others\' writes', async () => {
    const a = await journal()
    const b = await journal()
    expect(a.exclusive).toBe(false)
    expect((await a.appendRecord(env('e1'))).status).toBe('appended')
    expect((await b.appendRecord(env('e1'))).status).toBe('duplicate')
    expect((await b.get('e1'))?.state).toBe('pending')
    expect(await b.append(env('e2'))).toBe(true)
    expect((await a.list()).map((r) => r.envelope.eventId)).toEqual(['e1', 'e2'])
  })

  it('leases and fencing tokens hold across journals', async () => {
    const a = await journal()
    const b = await journal()
    await a.append(env('e1'))
    const [held] = await a.claim(1, { now: 10, leaseMs: 100, owner: 'A' })
    expect(held.fencingToken).toBe(1)
    expect(await b.claim(1, { now: 50, owner: 'B' })).toEqual([])
    expect(await b.claimOne('e1', { now: 50, leaseMs: 100, owner: 'B' })).toBeNull()

    await a.extend('e1', { fencingToken: 1, leaseUntil: 300 }) // a heartbeat is shared too
    expect(await b.claim(1, { now: 200, owner: 'B' })).toEqual([])

    const [taken] = await b.claim(1, { now: 400, leaseMs: 100, owner: 'B' })
    expect(taken).toMatchObject({ fencingToken: 2, owner: 'B', attempts: 2 })
    await expect(a.ack('e1', { now: 401, fencingToken: 1 })).rejects.toBeInstanceOf(StaleLeaseError)
    await b.ack('e1', { now: 402, fencingToken: 2 })
    expect(await a.get('e1')).toMatchObject({ state: 'done', completedAt: 402 })
  })

  it('concurrent claimers never get the same record', async () => {
    const journals = [await journal(), await journal(), await journal()]
    for (let i = 0; i < 30; i++) await journals[0].append(env(`e${i}`, i))
    const claimedBy = await Promise.all(journals.map(async (j, n) => {
      const mine: string[] = []
      for (;;) {
        const records = await j.claim(2, { owner: `w${n}`, leaseMs: 60_000 })
        if (records.length === 0) return mine
        for (const r of records) {
          mine.push(r.envelope.eventId)
          await j.ack(r.envelope.eventId, { fencingToken: r.fencingToken })
        }
      }
    }))
    const all = claimedBy.flat()
    expect(all).toHaveLength(30)
    expect(new Set(all).size).toBe(30)
    const records = await journals[1].list({ limit: Infinity })
    expect(records.every((r) => r.state === 'done' && r.attempts === 1)).toBe(true)
  })

  it('fail, release, replay and purge are shared', async () => {
    const a = await journal()
    const b = await journal()
    await a.append(env('e1'))
    await a.append(env('e2'))
    const [r1, r2] = await a.claim(2, { now: 10, leaseMs: 100 })
    await a.fail('e1', new Error('boom'), { now: 11, fencingToken: r1.fencingToken, dead: true })
    await a.release('e2', { now: 11, fencingToken: r2.fencingToken })
    expect((await b.get('e1'))).toMatchObject({ state: 'dead', lastError: 'boom' })
    expect((await b.get('e2'))).toMatchObject({ state: 'pending', attempts: 0 })
    await b.replay('e1', 20)
    expect((await a.get('e1'))?.state).toBe('pending')
    const [c] = await b.claim(1, { now: 30, leaseMs: 100 })
    await b.ack(c.envelope.eventId, { now: 31, fencingToken: c.fencingToken })
    expect(await a.purge({ doneBefore: 100 })).toBe(1)
    expect(await b.list({ limit: Infinity })).toHaveLength(1)
  })

  it('side state is updated atomically under the mutex and read back by every journal', async () => {
    const a = await journal()
    const b = await journal()
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).updateSidecar('counter', (data) => {
      const n = typeof data === 'number' ? data + 1 : 1
      return { data: n, result: n }
    })))
    expect(await a.readSidecar('counter')).toBe(20)
    expect(await b.updateSidecar('counter', () => ({ result: 'read-only' }))).toBe('read-only')
    expect(await b.readSidecar('missing')).toBeUndefined()
    await a.append(env('e1'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 2, sidecars: { counter: 20 } })
  })

  it('reads the same file format as FileEventJournal (not at the same time)', async () => {
    const f = await FileEventJournal.open(file, { lock: true })
    await f.append(env('old'))
    await expect(SharedFileEventJournal.open(file)).rejects.toThrow(/FileEventJournal/)
    await f.close()
    const s = await journal()
    expect((await s.get('old'))?.state).toBe('pending')
  })

  it('a FileEventJournal of this process cannot open a file a shared journal has open', async () => {
    const s = await journal()
    await s.append(env('a'))
    await expect(FileEventJournal.open(file, { lock: true })).rejects.toThrow(/SharedFileEventJournal/)
    await s.close()
    const f = await FileEventJournal.open(file, { lock: true })
    expect((await f.get('a'))?.state).toBe('pending')
    await f.close()
  })

  it('refuses to write once a live FileEventJournal of another process holds the file, so nothing is lost', async () => {
    const s = await journal()
    await s.append(env('a'))
    writeFileSync(`${file}.lock`, String(process.ppid)) // another live process opened it as a FileEventJournal
    await expect(s.append(env('b'))).rejects.toThrow(/FileEventJournal/)
    await expect(s.list()).rejects.toThrow(/FileEventJournal/)
    rmSync(`${file}.lock`)
    expect((await s.list()).map((r) => r.envelope.eventId)).toEqual(['a'])
    writeFileSync(`${file}.lock`, '999999999') // a lock left by a dead process does not block
    expect(await s.append(env('c'))).toBe(true)
  })

  it('a locked FileEventJournal reads the snapshot under the shared mutex (no write in flight is missed)', async () => {
    writeFileSync(`${file}.mutex`, `${process.ppid}:live`) // a shared writer of another process is mid-write
    let opened = false
    const opening = FileEventJournal.open(file, { lock: true }).then((f) => { opened = true; return f })
    await new Promise((r) => setTimeout(r, 60))
    expect(opened).toBe(false)
    rmSync(`${file}.mutex`)
    const f = await opening
    expect(existsSync(`${file}.mutex`)).toBe(false)
    await f.close()
  })

  it('rejects an invalid file and operations after close', async () => {
    writeFileSync(file, 'not json')
    await expect(SharedFileEventJournal.open(file)).rejects.toThrow()
    rmSync(file)
    const j = await SharedFileEventJournal.open(file)
    await j.close()
    await j.close()
    await expect(j.append(env('late'))).rejects.toThrow(/closed/)
  })

  it('close() lets operations accepted before it finish (they are not rejected as closed)', async () => {
    const j = await SharedFileEventJournal.open(file)
    const ops = [j.append(env('a')), j.append(env('b')), j.append(env('c'))]
    const closing = j.close()
    await expect(Promise.all(ops)).resolves.toEqual([true, true, true])
    await closing
    await expect(j.append(env('late'))).rejects.toThrow(/closed/)
    const k = await journal()
    expect((await k.list()).map((r) => r.envelope.eventId).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('SharedFileEventJournal mutex', () => {
  it('breaks a mutex left by a dead process', async () => {
    const j = await journal()
    writeFileSync(`${file}.mutex`, '999999999:dead')
    await j.append(env('e1'))
    expect(existsSync(`${file}.mutex`)).toBe(false)
  })

  it('waits for a live holder and times out, but breaks one held past staleLockMs', async () => {
    const j = await journal({ lockTimeoutMs: 80, staleLockMs: 10_000 })
    writeFileSync(`${file}.mutex`, `${process.ppid}:live`)
    await expect(j.append(env('e1'))).rejects.toThrow(/timed out/)
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${file}.mutex`, old, old)
    await j.append(env('e1'))
    expect((await j.get('e1'))?.state).toBe('pending')
  })

  it('validates its options', async () => {
    await expect(SharedFileEventJournal.open(file, { lockTimeoutMs: -1 })).rejects.toThrow(/lockTimeoutMs/)
    await expect(SharedFileEventJournal.open(file, { staleLockMs: 0 })).rejects.toThrow(/staleLockMs/)
  })
})

const child = fileURLToPath(new URL('./fixtures/shared-journal-child.mjs', import.meta.url))
const built = existsSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)))

function spawnChild(...args: string[]): { proc: ChildProcess; next: () => Promise<Record<string, unknown>> } {
  const proc = fork(child, [file, ...args], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const queue: Array<Record<string, unknown>> = []
  const waiters: Array<(m: Record<string, unknown>) => void> = []
  proc.on('message', (m) => { const w = waiters.shift(); if (w) w(m as Record<string, unknown>); else queue.push(m as Record<string, unknown>) })
  const next = () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const m = queue.shift()
    if (m) return resolve(m)
    waiters.push(resolve)
    proc.once('exit', (code) => reject(new Error(`child exited (${code})`)))
  })
  return { proc, next }
}
const exited = (proc: ChildProcess) => new Promise((r) => (proc.exitCode !== null ? r(proc.exitCode) : proc.once('exit', r)))

describe.skipIf(!built)('SharedFileEventJournal across processes', () => {
  it('two processes drain one journal: every record is claimed exactly once', async () => {
    const seed = await journal()
    for (let i = 0; i < 40; i++) await seed.append(env(`e${i}`, i))
    const children = [spawnChild('drain', 'p1'), spawnChild('drain', 'p2')]
    await Promise.all(children.map((c) => c.next())) // both ready
    for (const c of children) c.proc.send('go')
    const results = await Promise.all(children.map((c) => c.next()))
    await Promise.all(children.map((c) => exited(c.proc)))
    const claimed = results.flatMap((r) => r.claimed as string[])
    expect(claimed).toHaveLength(40)
    expect(new Set(claimed).size).toBe(40)
    const records = await seed.list({ limit: Infinity })
    expect(records.every((r) => r.state === 'done' && r.attempts === 1)).toBe(true)
  }, 30_000)

  it('a process whose lease expired is fenced off when another process re-claimed the record', async () => {
    const parent = await journal()
    await parent.append(env('e1'))
    const c = spawnChild('hold', 'p1')
    expect(await c.next()).toEqual({ token: 1 })
    await new Promise((r) => setTimeout(r, 120)) // the child's 50 ms lease runs out
    const [taken] = await parent.claim(1, { owner: 'parent', leaseMs: 60_000 })
    expect(taken.fencingToken).toBe(2)
    c.proc.send('ack')
    expect(await c.next()).toEqual({ outcome: 'StaleLeaseError:2' })
    await exited(c.proc)
    await parent.ack('e1', { fencingToken: 2 })
    expect((await parent.get('e1'))?.state).toBe('done')
  }, 30_000)
})

runDurabilityConformance('eventsDurability(SharedFileEventJournal)', {
  async make() {
    const t = tempFile()
    const j = await SharedFileEventJournal.open(t.file)
    const backend = eventsDurability({ journal: j })
    await backend.start()
    return { backend, teardown: async () => { await backend.stop(); await j.close(); t.cleanup() } }
  },
})

const deps = { Bot, MemoryStore, MockProvider, CrashableProvider, crashable, flow } as unknown as CrashMatrixDeps
runCrashRecoveryMatrix('eventsDurability(SharedFileEventJournal)', deps, {
  async make() {
    const t = tempFile()
    const j = await SharedFileEventJournal.open(t.file)
    return { backend: eventsDurability({ journal: j }), teardown: async () => { await j.close(); t.cleanup() } }
  },
})

function silentLogger(): never {
  const noop = () => {}
  const l: Record<string, unknown> = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, level: 'silent' }
  l.child = () => l
  return l as never
}

async function until(cond: () => Promise<boolean> | boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('eventsDurability(SharedFileEventJournal) with two replicas', () => {
  it('replica B takes over the lease of a dead replica A, and the shared outbox answers A\'s send', async () => {
    const store = new MemoryStore()
    const ja = await journal()
    const jb = await journal()
    const a = crashable(eventsDurability({ journal: ja }))
    expect(a.exclusive).toBe(false)
    const pa = new CrashableProvider(a)
    const config = { pollMs: 20, inbox: { leaseMs: 300 } }
    const botA = new Bot({ provider: pa, store, logger: silentLogger(), durability: { journal: a, instanceId: 'replica-a', ...config } })
    botA.on('error', () => {})
    botA.when('hola', async (ctx) => {
      await ctx.reply('uno')
      a.crash()
      await new Promise(() => {})
    })
    await botA.start()
    pa.incoming('hola', { from: 'u1', id: 'm1' })
    await a.whenCrashed

    const pb = new MockProvider()
    const botB = new Bot({ provider: pb, store, logger: silentLogger(), durability: { journal: eventsDurability({ journal: jb }), instanceId: 'replica-b', ...config } })
    botB.on('error', () => {})
    let runs = 0
    botB.when('hola', async (ctx) => {
      runs++
      await ctx.reply('uno')
      await ctx.reply('dos')
    })
    await botB.start()
    await until(async () => (await botB.durability!.inbox.list({ state: 'done' })).length === 1, 'replica B to take over m1')
    expect(runs).toBe(1)
    const texts = (p: MockProvider) => p.outbox.map((m) => (m.content as { text?: string }).text)
    expect([...texts(pa), ...texts(pb)]).toEqual(['uno', 'dos'])
    const [record] = await jb.list({ channel: 'botwa:durable' })
    expect(record.state).toBe('done')
    expect(record.owner).toBeUndefined()
    expect(record.fencingToken).toBeGreaterThanOrEqual(2)
    await botB.stop()
  }, 20_000)
})
