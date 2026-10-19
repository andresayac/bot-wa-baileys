/** FileEventJournal: side state in the same snapshot (format v2), v1 compatibility and the advisory lock. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileEventJournal, createEnvelope } from '../src/index.js'

const context = { tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'p', connectionId: 'c' }
const env = (id: string) => createEnvelope({ eventId: id, eventType: 'test.event', occurredAt: 1, context, payload: { id } })

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botwa-events-')); file = join(dir, 'events.json') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const read = () => JSON.parse(readFileSync(file, 'utf8')) as { version: number; records: unknown[]; sidecars?: Record<string, unknown> }

describe('FileEventJournal side state', () => {
  it('writes version 1 while no side state is registered, and opens it', async () => {
    const j = await FileEventJournal.open(file)
    await j.append(env('a'))
    expect(read()).toMatchObject({ version: 1 })
    expect(read().sidecars).toBeUndefined()
    const again = await FileEventJournal.open(file)
    expect((await again.get('a'))?.state).toBe('pending')
  })

  it('persists side state with the records and restores it on open', async () => {
    const j = await FileEventJournal.open(file)
    let state = { n: 0 }
    const handle = j.sidecar('counter', { snapshot: () => state, restore: (d) => { state = d as { n: number } } })
    state = { n: 7 }
    await handle.changed()
    await j.append(env('a'))
    expect(read()).toMatchObject({ version: 2, sidecars: { counter: { n: 7 } } })
    expect(read().records).toHaveLength(1)

    let restored: unknown
    const reopened = await FileEventJournal.open(file)
    reopened.sidecar('counter', { snapshot: () => restored, restore: (d) => { restored = d } })
    expect(restored).toEqual({ n: 7 })
    expect(() => reopened.sidecar('counter', { snapshot: () => 0, restore: () => {} })).toThrow(/already registered/)
  })

  it('keeps side state it does not know when it rewrites the file', async () => {
    writeFileSync(file, JSON.stringify({ version: 2, records: [], sidecars: { 'botwa.outbox': { keep: true } } }))
    const j = await FileEventJournal.open(file) // an events-only process: never registers the outbox
    await j.append(env('a'))
    expect(read()).toMatchObject({ version: 2, sidecars: { 'botwa.outbox': { keep: true } } })
  })

  it('rejects an invalid snapshot', async () => {
    writeFileSync(file, JSON.stringify({ version: 3, records: [] }))
    await expect(FileEventJournal.open(file)).rejects.toThrow(/invalid event journal snapshot/)
    writeFileSync(file, JSON.stringify({ version: 2, records: [], sidecars: [] }))
    await expect(FileEventJournal.open(file)).rejects.toThrow(/invalid event journal snapshot/)
  })
})

describe('FileEventJournal lock', () => {
  it('is off by default', async () => {
    const j = await FileEventJournal.open(file)
    expect(j.locked).toBe(false)
    expect(j.exclusive).toBe(false)
  })

  it('refuses a journal locked by another live process and takes over a dead one', async () => {
    writeFileSync(`${file}.lock`, String(process.ppid)) // the parent of the test runner is alive and is not us
    await expect(FileEventJournal.open(file, { lock: true })).rejects.toThrow(/locked by live process/)
    writeFileSync(`${file}.lock`, '999999999') // no such pid
    const j = await FileEventJournal.open(file, { lock: true })
    expect(j.locked).toBe(true)
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe(String(process.pid))
    await j.close()
    expect(() => readFileSync(`${file}.lock`)).toThrow()
  })
})
