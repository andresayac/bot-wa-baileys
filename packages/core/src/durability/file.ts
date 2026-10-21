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
import { MemoryKv, type KvMutation, type MemoryKvSnapshot } from './kv.js'
import { AppendLog, appendLogOptions } from './fileLog.js'

/** Options of {@link FileDurability.open}. */
export interface FileDurabilityOptions {
  /** Skip the advisory lock file (only when something else guarantees a single writer). */
  lock?: boolean
  /**
   * How long `open()` waits for a lock file that another opener has created but not written
   * its pid to yet (default 2000 ms). An empty lock older than 10 s is treated as stale.
   */
  lockWaitMs?: number
  /**
   * Append-only journal (`<file>.log`): each write appends one line instead of rewriting the
   * whole snapshot, and the snapshot is rewritten (and the log truncated) every
   * `compactEvery` entries (1000) or `compactBytes` (4 MiB). `true` uses those defaults;
   * `false`/omitted keeps the whole-snapshot behaviour. A leftover log is always replayed
   * (and folded into a snapshot) on open, even with this off.
   */
  appendLog?: boolean | { compactEvery?: number; compactBytes?: number; fsync?: boolean }
}

class FileKv extends MemoryKv {
  private writeQueue: Promise<void> = Promise.resolve()
  closed = false
  /** Append-only log; `undefined` = rewrite the whole snapshot on every write. */
  private log: AppendLog | undefined
  private seq = 0
  constructor(private readonly filePath: string) { super() }

  /** Use (or stop using) the append-only log and the sequence it must continue from. */
  useLog(log: AppendLog | undefined, seq: number): void {
    this.log = log
    this.seq = seq
  }

  /** Apply one replayed mutation without writing it back. */
  applyLogged(mutation: KvMutation): void { this.applyMutation(mutation) }

  override snapshot(): MemoryKvSnapshot {
    const snapshot = super.snapshot()
    return this.log ? { ...snapshot, logSeq: this.seq } : snapshot
  }

  protected override changed(mutation?: KvMutation): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`durability journal is closed: ${this.filePath}`))
    const write = this.writeQueue.then(async () => {
      if (this.log && mutation) {
        await this.log.append(++this.seq, mutation)
        if (this.log.due) await this.compactNow()
        return
      }
      await this.writeSnapshot()
    })
    // The caller sees this write's failure; the queue does not, so one failed write never blocks later ones.
    this.writeQueue = write.catch(() => {})
    return write
  }

  private async writeSnapshot(): Promise<void> {
    const snapshot = JSON.stringify(this.snapshot())
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, snapshot, 'utf8')
      await rename(temporary, this.filePath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Snapshot the current state and drop the log (the snapshot carries `logSeq`). */
  private async compactNow(): Promise<void> {
    await this.writeSnapshot()
    await this.log?.truncate()
  }

  /** Queue a full snapshot (used by `close()` and when folding a leftover log). */
  checkpoint(): Promise<void> {
    const write = this.writeQueue.then(() => this.writeSnapshot())
    this.writeQueue = write.catch(() => {})
    return write
  }

  /** Queue a snapshot + log truncation. */
  compact(): Promise<void> {
    const write = this.writeQueue.then(() => this.compactNow())
    this.writeQueue = write.catch(() => {})
    return write
  }

  /** Whether the append-only log holds entries not yet folded into the snapshot. */
  get logPending(): boolean { return this.log !== undefined && this.log.pending > 0 }

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

/** How many times in a row the lock may vanish between `open('wx')` and its read before giving up. */
const MAX_LOCK_VANISHED = 50

async function acquireLock(lockPath: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  let vanished = 0
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
      let text: string
      try {
        text = await readFile(lockPath, 'utf8')
      } catch (readError) {
        const code = (readError as NodeJS.ErrnoException).code
        // Released meanwhile: try again (bounded, so lock churn cannot spin forever).
        if (code === 'ENOENT' && ++vanished < MAX_LOCK_VANISHED) continue
        // Anything else (a directory in its place, no permission...) fails the same way every
        // time: retrying would loop forever.
        throw new Error(`cannot read durability journal lock ${lockPath}: ${code ?? String(readError)}`, { cause: readError })
      }
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
    // Validated before the lock is taken: an invalid option never leaves a stale lock.
    const logOptions = appendLogOptions(options.appendLog, 'FileDurability.open()')
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
    let snapshot: MemoryKvSnapshot | undefined
    try {
      snapshot = JSON.parse(await readFile(filePath, 'utf8')) as MemoryKvSnapshot
      kv.restore(snapshot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (lockPath) await rm(lockPath, { force: true }).catch(() => {})
        if (key) heldLocks.delete(key)
        throw error
      }
    }
    // A leftover log is replayed even when appendLog is off now (its entries are newer than
    // the snapshot); with the option off it is folded into a snapshot and removed.
    const leftover = await AppendLog.exists(filePath)
    if (logOptions || leftover) {
      try {
        const replay = await AppendLog.replay<KvMutation>(filePath, snapshot?.logSeq ?? 0)
        for (const { entry } of replay.entries) kv.applyLogged(entry)
        if (logOptions) {
          const log = new AppendLog(filePath, logOptions)
          log.adopt(replay)
          kv.useLog(log, replay.lastSeq)
        } else {
          kv.useLog(undefined, replay.lastSeq)
          await kv.checkpoint()
          await rm(AppendLog.pathOf(filePath), { force: true })
        }
      } catch (error) {
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
      try {
        await this.fileKv.flushed()
        // Fold a non-empty log into the snapshot so the next open does not replay it.
        if (this.fileKv.logPending) await this.fileKv.compact()
      } finally {
        if (this.lockPath) await rm(this.lockPath, { force: true })
        if (this.lockKey) heldLocks.delete(this.lockKey)
      }
    })()
    return this.closing
  }
}
