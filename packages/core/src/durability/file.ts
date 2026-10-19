/**
 * Single-process durability backend persisted to one JSON file.
 *
 * Every committed write rewrites the snapshot atomically (temp file + rename), the
 * same technique as `@bot-wa/events`' `FileEventJournal`, so a crash leaves either the
 * previous or the next snapshot, never a torn one. A `<file>.lock` advisory lock holding
 * the owner's pid keeps a second PROCESS from opening the same journal while the first
 * is alive; a lock left by a dead process is taken over. Nothing is ever killed.
 */

import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { KvDurability } from './journal.js'
import { MemoryKv, type MemoryKvSnapshot } from './kv.js'

/** Options of {@link FileDurability.open}. */
export interface FileDurabilityOptions {
  /** Skip the advisory lock file (only when something else guarantees a single writer). */
  lock?: boolean
}

class FileKv extends MemoryKv {
  private writeQueue: Promise<void> = Promise.resolve()
  constructor(private readonly filePath: string) { super() }

  protected override changed(): Promise<void> {
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

async function acquireLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(String(process.pid), 'utf8')
      await handle.close()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10)
      // Our own pid: a previous FileDurability of this process (e.g. a bot restarted in-process).
      if (holder === process.pid) return
      if (pidAlive(holder)) throw new Error(`durability journal is locked by live process ${holder}: ${lockPath}`)
      await rm(lockPath, { force: true }) // stale lock of a dead process
    }
  }
  throw new Error(`could not acquire durability journal lock: ${lockPath}`)
}

/** {@link DurabilityBackend} persisted to a JSON file (single process). */
export class FileDurability extends KvDurability {
  private constructor(kv: FileKv, private readonly lockPath: string | undefined) { super(kv, { exclusive: true }) }

  /**
   * Open (or create) the journal at `filePath`.
   * @throws {Error} when another live process holds the lock, or the file is not a valid journal.
   */
  static async open(filePath: string, options: FileDurabilityOptions = {}): Promise<FileDurability> {
    await mkdir(dirname(filePath), { recursive: true })
    const lockPath = options.lock === false ? undefined : `${filePath}.lock`
    if (lockPath) await acquireLock(lockPath)
    const kv = new FileKv(filePath)
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as MemoryKvSnapshot
      kv.restore(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (lockPath) await rm(lockPath, { force: true }).catch(() => {})
        throw error
      }
    }
    return new FileDurability(kv, lockPath)
  }

  /** Release the lock file. The bot does NOT call this on `stop()` (a restart reuses the instance). */
  async close(): Promise<void> {
    if (this.lockPath) await rm(this.lockPath, { force: true })
  }
}
