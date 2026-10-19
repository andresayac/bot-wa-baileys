/** FileEventJournal write cost: concurrent writes share one snapshot rewrite, lease heartbeats do not rewrite the file. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renames = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => { renames.count++; return actual.rename(...args) } }
})

const { FileEventJournal, createEnvelope } = await import('../src/index.js')

const context = { tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'p', connectionId: 'c' }
const env = (id: string) => createEnvelope({ eventId: id, eventType: 'test.event', occurredAt: 1, context, payload: { id } })

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botwa-events-w-')); file = join(dir, 'events.json'); renames.count = 0 })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const onDisk = () => JSON.parse(readFileSync(file, 'utf8')) as { records: Array<{ envelope: { eventId: string }; leaseUntil?: number }> }

describe('FileEventJournal writes', () => {
  it('coalesces concurrent writes into far fewer snapshot rewrites, and every caller sees its change on disk', async () => {
    const j = await FileEventJournal.open(file, { lock: true })
    await Promise.all(Array.from({ length: 50 }, (_, i) => j.append(env(`e${i}`)).then(() => {
      expect(onDisk().records.map((r) => r.envelope.eventId)).toContain(`e${i}`)
    })))
    expect(onDisk().records).toHaveLength(50)
    expect(renames.count).toBeLessThanOrEqual(3)
    await j.close()
  })

  it('a lease extension stays in memory and is written with the next write (a heartbeat does not rewrite the file)', async () => {
    const j = await FileEventJournal.open(file, { lock: true })
    await j.append(env('a'))
    const [claimed] = await j.claim(1, { now: 10, leaseMs: 100 })
    const before = renames.count
    await j.extend('a', { fencingToken: claimed.fencingToken!, leaseUntil: 500 })
    await j.extend('a', { fencingToken: claimed.fencingToken!, leaseUntil: 600 })
    expect(renames.count).toBe(before)
    expect((await j.get('a'))?.leaseUntil).toBe(600)
    await j.close() // flushes the pending extension
    expect(onDisk().records[0].leaseUntil).toBe(600)
  })
})
