/**
 * Append-only `FileDurability` (`appendLog`): writes go to `<file>.log` and the snapshot is
 * rewritten/truncated on the compaction threshold, on close and when a leftover log is found.
 * The durable-journal conformance suites run over it too, so the on-disk format change is
 * covered by the same semantics as the whole-snapshot backend.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileDurability } from '../src/index.js'
import { runDurabilityConformance, runDurableKvConformance } from '../../../test-utils/durability-conformance.js'

const append = (j: FileDurability, id: string) =>
  j.inbox.append({ id, partitionKey: 'p', kind: 'message', payload: { id }, receivedAt: 1 }, 1)

runDurableKvConformance('FileDurability append log (kv)', {
  async make() {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-dur-log-kv-'))
    const journal = await FileDurability.open(join(dir, 'journal.json'), { appendLog: { compactEvery: 3 } })
    return {
      kv: journal.kv,
      teardown: async () => { await journal.close(); rmSync(dir, { recursive: true, force: true }) },
    }
  },
})

runDurabilityConformance('FileDurability append log', {
  async make() {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-dur-log-'))
    const backend = await FileDurability.open(join(dir, 'journal.json'), { appendLog: { compactEvery: 3, compactBytes: 1024 } })
    await backend.start()
    return {
      backend,
      teardown: async () => { await backend.stop(); await backend.close(); rmSync(dir, { recursive: true, force: true }) },
    }
  },
})

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botwa-dur-log-focused-')); file = join(dir, 'journal.json') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('FileDurability append log', () => {
  it('appends instead of rewriting and replays the log on reopen', async () => {
    const a = await FileDurability.open(file, { appendLog: true })
    await append(a, 'e1')
    await append(a, 'e2')
    expect(existsSync(`${file}.log`)).toBe(true)
    // The snapshot is not rewritten on every write: it does not exist until compaction.
    expect(existsSync(file)).toBe(false)
    await a.close()
    expect(existsSync(`${file}.log`)).toBe(false)
    expect(existsSync(file)).toBe(true)
    const b = await FileDurability.open(file, { appendLog: true })
    expect(await b.inbox.get('e1')).toMatchObject({ state: 'pending' })
    expect(await b.inbox.get('e2')).toMatchObject({ state: 'pending' })
    await b.close()
  })

  it('compacts when the threshold is reached (snapshot + truncated log), without losing records', async () => {
    const a = await FileDurability.open(file, { appendLog: { compactEvery: 2 } })
    await append(a, 'e1')
    expect(existsSync(`${file}.log`)).toBe(true)
    await append(a, 'e2') // second append triggers the compaction inside the same write
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.log`)).toBe(false)
    await append(a, 'e3')
    expect(existsSync(`${file}.log`)).toBe(true)
    await a.close()
    const b = await FileDurability.open(file, { appendLog: true })
    for (const id of ['e1', 'e2', 'e3']) expect(await b.inbox.get(id)).toMatchObject({ state: 'pending' })
    await b.close()
  })

  it('ignores and cuts a torn tail (a crash mid-append), keeping the complete entries', async () => {
    // A crash between the append and the compaction: snapshot without logSeq + the log.
    const a = await FileDurability.open(file, { appendLog: true })
    await append(a, 'e1')
    const log = readFileSync(`${file}.log`, 'utf8')
    await a.close()
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    delete snapshot.logSeq
    writeFileSync(file, JSON.stringify(snapshot))
    writeFileSync(`${file}.log`, `${log}{"s":2,"e":`)

    const b = await FileDurability.open(file, { appendLog: true })
    expect(await b.inbox.get('e1')).toMatchObject({ state: 'pending' })
    expect(readFileSync(`${file}.log`, 'utf8')).toBe(log)
    await b.close()
  })

  it('folds a leftover log into a snapshot when reopened without appendLog', async () => {
    const a = await FileDurability.open(file, { appendLog: true })
    await append(a, 'e1')
    const log = readFileSync(`${file}.log`, 'utf8')
    await a.close()
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    delete snapshot.logSeq
    writeFileSync(file, JSON.stringify(snapshot))
    writeFileSync(`${file}.log`, log)

    const b = await FileDurability.open(file) // appendLog off
    expect(await b.inbox.get('e1')).toMatchObject({ state: 'pending' })
    expect(existsSync(`${file}.log`)).toBe(false)
    await b.close()
    const c = await FileDurability.open(file)
    expect(await c.inbox.get('e1')).toMatchObject({ state: 'pending' })
    await c.close()
  })

  it('rejects an invalid appendLog option', async () => {
    await expect(FileDurability.open(file, { appendLog: { compactEvery: 0 } })).rejects.toThrow(/compactEvery/)
    await expect(FileDurability.open(file, { appendLog: { compactBytes: -1 } })).rejects.toThrow(/compactBytes/)
    await expect(FileDurability.open(file, { appendLog: 'yes' as unknown as boolean })).rejects.toThrow(/appendLog/)
  })
})
