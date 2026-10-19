/**
 * FileDurability lock: one open journal per file and per process (a second open is refused until
 * `close()`), a lock left by a dead process or by an earlier process with our pid (a restarted
 * container) is taken over, and a lock file that is still being written is not mistaken for a
 * stale one.
 */
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileDurability } from '../src/index.js'

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botwa-dur-lock-')); file = join(dir, 'journal.json') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const append = (j: FileDurability, id: string) =>
  j.inbox.append({ id, partitionKey: 'p', kind: 'message', payload: { id }, receivedAt: 1 }, 1)

describe('FileDurability lock', () => {
  it('refuses a second open of the same file in this process until the first is closed', async () => {
    const a = await FileDurability.open(file)
    expect(a.locked).toBe(true)
    await expect(FileDurability.open(file)).rejects.toThrow(/already open in this process/)
    await expect(FileDurability.open(join(dir, '.', 'journal.json'))).rejects.toThrow(/already open in this process/)
    await append(a, 'e1')
    await a.close()
    expect(a.locked).toBe(false)
    const b = await FileDurability.open(file)
    expect((await b.inbox.get('e1'))?.state).toBe('pending')
    await b.close()
  })

  it('takes over a lock file with its own pid when no journal of this process holds it (a restarted container reuses pids)', async () => {
    writeFileSync(`${file}.lock`, String(process.pid))
    const j = await FileDurability.open(file)
    expect(j.locked).toBe(true)
    await j.close()
    expect(() => readFileSync(`${file}.lock`)).toThrow()
  })

  it('takes over a lock of a dead process and refuses one of a live process', async () => {
    writeFileSync(`${file}.lock`, String(process.ppid))
    await expect(FileDurability.open(file)).rejects.toThrow(/locked by live process/)
    writeFileSync(`${file}.lock`, '999999999')
    const j = await FileDurability.open(file)
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe(String(process.pid))
    await j.close()
  })

  it('does not take over an empty lock that is still being written, but does once it is old', async () => {
    writeFileSync(`${file}.lock`, '')
    await expect(FileDurability.open(file, { lockWaitMs: 50 })).rejects.toThrow(/being acquired/)
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${file}.lock`, old, old)
    const j = await FileDurability.open(file, { lockWaitMs: 50 })
    expect(j.locked).toBe(true)
    await j.close()
  })

  it('frees the in-process claim when open fails on an invalid file', async () => {
    writeFileSync(file, 'not json')
    await expect(FileDurability.open(file)).rejects.toThrow()
    expect(() => readFileSync(`${file}.lock`)).toThrow()
    rmSync(file)
    const j = await FileDurability.open(file)
    await j.close()
  })

  it('close is idempotent and later writes reject, so a closed journal never writes without its lock', async () => {
    const j = await FileDurability.open(file)
    await j.close()
    await j.close()
    await expect(append(j, 'late')).rejects.toThrow(/closed/)
    expect(() => readFileSync(file)).toThrow()
  })

  it('lock: false keeps today\'s behaviour (no lock file, no in-process registry)', async () => {
    const a = await FileDurability.open(file, { lock: false })
    const b = await FileDurability.open(file, { lock: false })
    expect(a.locked).toBe(false)
    expect(() => readFileSync(`${file}.lock`)).toThrow()
    await a.close()
    await b.close()
  })
})
