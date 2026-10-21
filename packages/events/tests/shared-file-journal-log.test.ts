/**
 * SharedFileEventJournal append-only mode and mutex heartbeat: writes append a delta to
 * `<file>.log`, the snapshot is rewritten/truncated on the compaction threshold, a leftover
 * log is replayed (and folded), and a live mutex holder refreshes its mtime so a slow
 * operation is not broken as stale by another process.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SharedFileEventJournal, __testing, createEnvelope } from '../src/index.js'

const context = { tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'p', connectionId: 'c' }
const env = (id: string, occurredAt = 1) => createEnvelope({ eventId: id, eventType: 'test.event', occurredAt, context, payload: { id } })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let dir: string
let file: string
const open: SharedFileEventJournal[] = []
async function journal(options?: Parameters<typeof SharedFileEventJournal.open>[1]): Promise<SharedFileEventJournal> {
  const j = await SharedFileEventJournal.open(file, options)
  open.push(j)
  return j
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botwa-events-log-')); file = join(dir, 'events.json') })
afterEach(async () => {
  while (open.length) await open.pop()!.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('SharedFileEventJournal append log', () => {
  it('appends deltas instead of rewriting the snapshot, and replays them', async () => {
    const a = await journal({ appendLog: true })
    await a.append(env('e1'))
    await a.append(env('e2'))
    expect(existsSync(`${file}.log`)).toBe(true)
    expect(existsSync(file)).toBe(false)
    const b = await journal({ appendLog: true })
    expect((await b.get('e1'))?.state).toBe('pending')
    expect((await b.list()).map((record) => record.envelope.eventId).sort()).toEqual(['e1', 'e2'])
    // Leases/side state written through the log are visible to the other journal too.
    const [claimed] = await a.claim(1, { now: 10, leaseMs: 100, owner: 'A' })
    expect(claimed?.fencingToken).toBe(1)
    // b sees A's lease: it can take the other pending record but not the leased one.
    expect((await b.claim(1, { now: 20, owner: 'B' })).map((record) => record.envelope.eventId)).toEqual(['e2'])
    expect(await b.claimOne('e1', { now: 20, leaseMs: 100, owner: 'B' })).toBeNull()
  })

  it('compacts at the threshold and after that keeps every record', async () => {
    const a = await journal({ appendLog: { compactEvery: 2 } })
    await a.append(env('e1'))
    expect(existsSync(`${file}.log`)).toBe(true)
    await a.append(env('e2'))
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.log`)).toBe(false)
    await a.append(env('e3'))
    await a.ack('e2', { now: 2 })
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { logSeq?: number }
    expect(snapshot.logSeq).toBeGreaterThanOrEqual(2)

    const b = await journal({ appendLog: true })
    expect((await b.get('e1'))?.state).toBe('pending')
    expect((await b.get('e2'))?.state).toBe('done')
    expect((await b.get('e3'))?.state).toBe('pending')
  })

  it('replays and folds a leftover log when opened without appendLog', async () => {
    const a = await journal({ appendLog: true })
    await a.append(env('e1'))
    await a.close()
    open.splice(open.indexOf(a), 1)
    expect(existsSync(file)).toBe(false) // append-only: the log is the journal until compaction
    expect(existsSync(`${file}.log`)).toBe(true)

    const b = await journal() // no appendLog
    expect((await b.get('e1'))?.state).toBe('pending')
    await b.append(env('e2')) // the first write folds the leftover log into the snapshot
    expect(existsSync(`${file}.log`)).toBe(false)
    const c = await journal()
    expect((await c.list()).map((record) => record.envelope.eventId).sort()).toEqual(['e1', 'e2'])
  })

  it('ignores a torn tail left by a crash mid-append', async () => {
    const a = await journal({ appendLog: true })
    await a.append(env('e1'))
    const log = readFileSync(`${file}.log`, 'utf8')
    await a.close()
    open.splice(open.indexOf(a), 1)
    writeFileSync(`${file}.log`, `${log}{"put":[`)

    const b = await journal({ appendLog: true })
    expect((await b.get('e1'))?.state).toBe('pending')
    expect(readFileSync(`${file}.log`, 'utf8')).toBe(log)
  })

  it('rejects invalid options before touching the file', async () => {
    await expect(SharedFileEventJournal.open(file, { heartbeatMs: 0 })).rejects.toThrow(/heartbeatMs/)
    await expect(SharedFileEventJournal.open(file, { staleLockMs: 100, heartbeatMs: 100 })).rejects.toThrow(/heartbeatMs/)
    await expect(SharedFileEventJournal.open(file, { appendLog: { compactEvery: 0 } })).rejects.toThrow(/compactEvery/)
  })
})

describe('SharedFileEventJournal mutex heartbeat', () => {
  it('a live holder refreshes the mutex so another process waits instead of breaking it', async () => {
    const path = join(dir, 'events.json.mutex')
    // Generous ratios (heartbeat 20 ms vs stale 300 ms) so a busy event loop — the whole
    // suite runs in parallel — cannot make the holder look stalled.
    const release = await __testing.acquireMutex(path, 100, 300, 20)
    try {
      await sleep(500) // well past the stale threshold without a heartbeat
      const waiter = await SharedFileEventJournal.open(file, { staleLockMs: 300, heartbeatMs: 20, lockTimeoutMs: 200 })
      open.push(waiter)
      await expect(waiter.get('missing')).rejects.toThrow(/timed out waiting for the event journal mutex/)
    } finally {
      await release()
    }
  })

  it('still breaks a mutex whose mtime is old (a stalled holder)', async () => {
    const path = join(dir, 'events.json.mutex')
    writeFileSync(path, `999999999:dead`)
    const old = new Date(Date.now() - 60_000)
    await import('node:fs/promises').then((fs) => fs.utimes(path, old, old))
    const j = await journal({ staleLockMs: 60 })
    expect(await j.get('missing')).toBeUndefined()
  })
})
