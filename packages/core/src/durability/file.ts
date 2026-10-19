/**
 * Single-process durability backend persisted to one JSON file.
 *
 * Every committed write rewrites the snapshot atomically (temp file + rename), the
 * same technique as `@bot-wa/events`' `FileEventJournal`, so a crash leaves either the
 * previous or the next snapshot, never a torn one. A `<file>.lock` advisory lock holding
 * the owner's pid keeps a second PROCESS from opening the same journal while the first
 * is alive; a lock left by a dead process is taken over. Within one process, a second
 * locked `open()` of the same file is refused until the first journal is closed. Nothing
 * is ever killed.
 */

import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { KvDurability } from './journal.js'
import { MemoryKv, type MemoryKvSnapshot } from './kv.js'

/** Options of {@link FileDurability.open}. */
export interface FileDurabilityOptions {
  /** Skip the advisory lock file (only when something else guarantees a single writer). */
  lock?: boolean
  /**
   * How long `open()` waits for a lock file that another opener has created but not written
   * its pid to yet (default 2000 ms). An empty lock older than 10 s is treated as stale.
   */
  lockWaitMs?: number
}

class FileKv extends MemoryKv {
  private writeQueue: Promise<void> = Promise.resolve()
  closed = false
  constructor(private readonly filePath: string) { super() }

  protected override changed(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`durability journal is closed: ${this.filePath}`))
    const snapshot = JSON.stringify(this.snapshot())
    const write = this.writeQueue.then(async () => {
      const temporary = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, snapshot, 'utf8')
        await rename(temporary, this.filePath)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    })
    // The caller sees this write's failure; the queue does not, so one failed write never blocks later ones.
    this.writeQueue = write.catch(() => {})
    return write
  }

  /** Wait for every queued write (failures were already reported to their callers). */
  flushed(): Promise<void> { return this.writeQueue }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0) // signal 0: existence probe only, sends nothing
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Lock files held by an open FileDurability of THIS process (canonical paths). */
const heldLocks = new Set<string>()

/** A canonical key for a lock path: real directory (symlinks resolved), case-folded on Windows. */
async function lockKey(lockPath: string): Promise<string> {
  const key = join(await realpath(dirname(lockPath)), basename(lockPath))
  return process.platform === 'win32' ? key.toLowerCase() : key
}

/** An empty or garbled lock file younger than this may still be being written by its opener. */
const EMPTY_LOCK_STALE_MS = 10_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function acquireLock(lockPath: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  for (let takeovers = 0; takeovers < 3;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(String(process.pid), 'utf8')
      } finally {
        await handle.close()
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const text = await readFile(lockPath, 'utf8').catch(() => undefined)
      if (text === undefined) continue // released meanwhile: try again
      const holder = /^\s*\d+\s*$/.test(text) ? Number.parseInt(text, 10) : Number.NaN
      if (Number.isNaN(holder)) {
        // Empty or garbled: another opener may be between creating the file and writing its
        // pid. Only an old one is stale (a crash at that exact point).
        const age = Date.now() - ((await stat(lockPath).catch(() => undefined))?.mtimeMs ?? 0)
        if (age < EMPTY_LOCK_STALE_MS) {
          if (Date.now() >= deadline) throw new Error(`durability journal lock is being acquired by another process: ${lockPath}`)
          await sleep(Math.min(25, Math.max(1, deadline - Date.now())))
          continue
        }
      } else if (holder !== process.pid && pidAlive(holder)) {
        throw new Error(`durability journal is locked by live process ${holder}: ${lockPath}`)
      }
      // Stale: a dead process, or our own pid while no journal of this process holds it
      // (open() checks heldLocks first): an earlier process that had this pid (a restarted container).
      await rm(lockPath, { force: true })
      takeovers++
    }
  }
  throw new Error(`could not acquire durability journal lock: ${lockPath}`)
}

/** {@link DurabilityBackend} persisted to a JSON file (single process). */
export class FileDurability extends KvDurability {
  private closing: Promise<void> | undefined
  private constructor(
    private readonly fileKv: FileKv,
    private readonly lockPath: string | undefined,
    /** Key of this journal's entry in the in-process lock registry. */
    private readonly lockKey: string | undefined,
  ) { super(fileKv, { exclusive: true }) }

  /** The file is held under the advisory lock and the journal is not closed. */
  get locked(): boolean { return this.lockPath !== undefined && !this.fileKv.closed }

  /**
   * Open (or create) the journal at `filePath`.
   * @throws {Error} when another live process holds the lock, another open journal of this
   *   process holds it, or the file is not a valid journal.
   */
  static async open(filePath: string, options: FileDurabilityOptions = {}): Promise<FileDurability> {
    const waitMs = options.lockWaitMs ?? 2_000
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError('FileDurability.open(): lockWaitMs must be a non-negative number')
    await mkdir(dirname(filePath), { recursive: true })
    const lockPath = options.lock === false ? undefined : `${filePath}.lock`
    let key: string | undefined
    if (lockPath) {
      key = await lockKey(lockPath)
      // Checked and claimed with no await in between, so two concurrent opens cannot both pass.
      if (heldLocks.has(key)) throw new Error(`durability journal is already open in this process: ${filePath}`)
      heldLocks.add(key)
      try {
        await acquireLock(lockPath, waitMs)
      } catch (error) {
        heldLocks.delete(key)
        throw error
      }
    }
    const kv = new FileKv(filePath)
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as MemoryKvSnapshot
      kv.restore(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (lockPath) await rm(lockPath, { force: true }).catch(() => {})
        if (key) heldLocks.delete(key)
        throw error
      }
    }
    return new FileDurability(kv, lockPath, key)
  }

  /**
   * Wait for pending writes and release the lock file. Idempotent; later writes reject (a
   * closed journal never writes without its lock). The bot does NOT call this on `stop()`
   * (a restart reuses the instance).
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.fileKv.closed = true
      await this.fileKv.flushed()
      if (this.lockPath) await rm(this.lockPath, { force: true })
      if (this.lockKey) heldLocks.delete(this.lockKey)
    })()
    return this.closing
  }
}
