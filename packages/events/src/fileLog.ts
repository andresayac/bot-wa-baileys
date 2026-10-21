/**
 * Append-only log next to a file-backed journal (`<file>.log`): one newline-delimited
 * JSON entry per committed operation, each stamped with a sequence number, so a write
 * costs one `appendFile` instead of a rewrite of the whole snapshot. The snapshot keeps
 * the sequence it was taken at (`logSeq`); opening replays every complete entry beyond
 * it, so a crash between "snapshot written" and "log truncated" is harmless (those
 * entries are skipped by their sequence) and a torn last line (a crash mid-append) is
 * ignored and cut off. It knows nothing about what an entry means.
 *
 * Sibling copy of `@bot-wa/core`'s `durability/fileLog.ts` (the core cannot export a new
 * public helper for a private package): keep the on-disk format in sync.
 */

import { appendFile, open, readFile, rm, stat, truncate } from 'node:fs/promises'

/** One replayed log entry: its sequence number and the payload the writer appended. */
export interface AppendLogEntry<T = unknown> {
  s: number
  entry: T
}

/** What {@link AppendLog.replay} found on disk. */
export interface AppendLogReplay<T = unknown> {
  /** Complete entries with a sequence beyond the one asked for, in file order. */
  entries: Array<AppendLogEntry<T>>
  /** Highest sequence seen in the log (`afterSeq` when the log is empty or missing). */
  lastSeq: number
  /** Bytes of complete entries in the log (what the next append grows). */
  bytes: number
  /** A torn tail (no final newline, or an unparsable last line) was found. */
  torn: boolean
}

/** Options of {@link AppendLog}. */
export interface AppendLogOptions {
  /** Compact (snapshot + truncate) once this many entries were appended since the last snapshot. Default 1000. */
  compactEvery?: number
  /** Compact once the log holds this many bytes. Default 4 MiB. */
  compactBytes?: number
  /** `fsync` every append (default `false`, like the snapshot writes). */
  fsync?: boolean
}

export const DEFAULT_COMPACT_EVERY = 1000
export const DEFAULT_COMPACT_BYTES = 4 * 1024 * 1024

/** Normalise {@link AppendLogOptions} (`true` = defaults). @throws {TypeError} on an invalid value. */
export function appendLogOptions(value: boolean | AppendLogOptions | undefined, who: string): Required<AppendLogOptions> | undefined {
  if (value === undefined || value === false) return undefined
  const o = value === true ? {} : value
  if (typeof o !== 'object' || o === null) throw new TypeError(`${who}: appendLog must be a boolean or an options object`)
  const compactEvery = o.compactEvery ?? DEFAULT_COMPACT_EVERY
  const compactBytes = o.compactBytes ?? DEFAULT_COMPACT_BYTES
  if (!Number.isInteger(compactEvery) || compactEvery < 1) throw new TypeError(`${who}: appendLog.compactEvery must be a positive integer`)
  if (!Number.isFinite(compactBytes) || compactBytes < 1) throw new TypeError(`${who}: appendLog.compactBytes must be a positive number`)
  return { compactEvery, compactBytes, fsync: o.fsync === true }
}

/**
 * The log file of one journal. Appends are the caller's to serialise (the journals run
 * every write through one queue, or under their cross-process mutex); this class only
 * owns the on-disk format and the compaction bookkeeping.
 */
export class AppendLog {
  /** Entries appended since the last compaction (or since open). */
  private count = 0
  /** Bytes the log holds (complete entries only). */
  private bytes = 0
  readonly path: string

  constructor(filePath: string, private readonly options: Required<AppendLogOptions>) {
    this.path = `${filePath}.log`
  }

  /** The log path of a journal file (what {@link replay} reads). */
  static pathOf(filePath: string): string { return `${filePath}.log` }

  /**
   * Read `<file>.log` and return every complete entry with `s > afterSeq`. A torn tail is
   * cut off the file (the writer serialises appends, so nothing else is writing it). A
   * missing log is an empty one.
   */
  static async replay<T = unknown>(filePath: string, afterSeq: number): Promise<AppendLogReplay<T>> {
    const path = AppendLog.pathOf(filePath)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], lastSeq: afterSeq, bytes: 0, torn: false }
      throw error
    }
    const entries: Array<AppendLogEntry<T>> = []
    let lastSeq = afterSeq
    let complete = 0 // bytes of the lines kept
    let torn = false
    let offset = 0
    while (offset < text.length) {
      const nl = text.indexOf('\n', offset)
      if (nl < 0) { torn = true; break }
      const line = text.slice(offset, nl)
      let parsed: { s?: unknown; e?: unknown }
      try {
        parsed = JSON.parse(line) as { s?: unknown; e?: unknown }
      } catch {
        torn = true
        break
      }
      if (typeof parsed?.s !== 'number' || !('e' in parsed)) { torn = true; break }
      offset = nl + 1
      complete = Buffer.byteLength(text.slice(0, offset), 'utf8')
      if (parsed.s > lastSeq) lastSeq = parsed.s
      if (parsed.s > afterSeq) entries.push({ s: parsed.s, entry: parsed.e as T })
    }
    if (torn) await truncate(path, complete)
    return { entries, lastSeq, bytes: complete, torn }
  }

  /** Adopt what {@link replay} found (so compaction thresholds count the existing tail). */
  adopt(replay: Pick<AppendLogReplay, 'entries' | 'bytes'>): void {
    this.count = replay.entries.length
    this.bytes = replay.bytes
  }

  /** Append one entry (`{"s":seq,"e":entry}` + newline). */
  async append(seq: number, entry: unknown): Promise<void> {
    const line = `${JSON.stringify({ s: seq, e: entry })}\n`
    if (this.options.fsync) {
      const handle = await open(this.path, 'a')
      try {
        await handle.writeFile(line, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    } else {
      await appendFile(this.path, line, 'utf8')
    }
    this.count++
    this.bytes += Buffer.byteLength(line, 'utf8')
  }

  /** Whether the thresholds say the journal should snapshot and truncate now. */
  get due(): boolean {
    return this.count >= this.options.compactEvery || this.bytes >= this.options.compactBytes
  }

  /** Entries appended since the last compaction. */
  get pending(): number { return this.count }

  /** Delete the log (after the snapshot that holds its entries was written). */
  async truncate(): Promise<void> {
    await rm(this.path, { force: true })
    this.count = 0
    this.bytes = 0
  }

  /** Whether a log file exists on disk (a reopen decides whether to drain it). */
  static async exists(filePath: string): Promise<boolean> {
    return (await stat(AppendLog.pathOf(filePath)).catch(() => undefined)) !== undefined
  }
}
