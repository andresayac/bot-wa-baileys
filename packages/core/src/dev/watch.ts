/**
 * File watching for `bot-wa dev` hot reload: `node:fs` `watch` (recursive),
 * filtered to source files and debounced so one save = one reload.
 */

import { watch as fsWatch } from 'node:fs'

/** Source files whose change triggers a reload. */
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i

/**
 * Should a change to `file` (relative to the watched directory, as reported by
 * `fs.watch`) reload the bot? Only JS/TS sources outside `node_modules`,
 * dot-folders and session folders count — so store files, logs, `.env` or
 * WhatsApp auth files written while the bot runs never cause reload loops.
 * `null` (platform did not report a name) counts as relevant.
 */
export function isReloadRelevant(file: string | null): boolean {
  if (file === null) return true
  const parts = file.split(/[\\/]/)
  const ignored = parts.some((part) =>
    part === 'node_modules' || part === 'sessions' || part.endsWith('_sessions') || (part.startsWith('.') && part.length > 1))
  return !ignored && SOURCE_FILE.test(file)
}

/** The minimal `fs.FSWatcher` surface {@link watchForChanges} uses. */
export interface WatchHandle {
  close(): void
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Signature-compatible subset of `fs.watch`, injectable for tests. */
export type WatchFunction = (
  dir: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => WatchHandle

/** Options for {@link watchForChanges}. */
export interface WatchOptions {
  /** Quiet period before firing, so editors' multi-write saves reload once. Default 120 ms. */
  debounceMs?: number
  /** Which changed files matter. Default {@link isReloadRelevant}. */
  filter?: (file: string | null) => boolean
  /** `fs.watch` replacement (tests). */
  watch?: WatchFunction
}

/** A running watcher. */
export interface ReloadWatcher {
  close(): void
}

const defaultWatch: WatchFunction = (dir, options, listener) =>
  fsWatch(dir, options, (event, filename) => listener(event, filename === null ? null : String(filename)))

/**
 * Watch `dir` recursively and call `onChange` with the (POSIX-style, deduped)
 * relative paths of the relevant files that changed, after a debounce. Falls
 * back to a non-recursive watch where recursion is unsupported. Watcher errors
 * (e.g. the directory was deleted) are swallowed — the session keeps running.
 */
export function watchForChanges(dir: string, onChange: (files: string[]) => void, options: WatchOptions = {}): ReloadWatcher {
  const debounceMs = options.debounceMs ?? 120
  const filter = options.filter ?? isReloadRelevant
  const watch = options.watch ?? defaultWatch
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined

  const flush = () => {
    timer = undefined
    const files = [...pending]
    pending.clear()
    onChange(files)
  }
  const listener = (_event: string, filename: string | null) => {
    const file = filename === null ? null : filename.replace(/\\/g, '/')
    if (!filter(file)) return
    pending.add(file ?? '(unknown file)')
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }

  let handle: WatchHandle
  try {
    handle = watch(dir, { recursive: true }, listener)
  } catch {
    handle = watch(dir, { recursive: false }, listener)
  }
  handle.on('error', () => { /* keep the session alive; a later save may work again */ })

  return {
    close() {
      if (timer) clearTimeout(timer)
      timer = undefined
      handle.close()
    },
  }
}
