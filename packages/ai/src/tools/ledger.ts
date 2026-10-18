import type { AIToolExecution } from './types.js'

/** Default window of `dedupe: 'args'`. */
export const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60_000
/** How long successful side-effecting runs are remembered per chat (at least the largest dedupe window). */
export const DEFAULT_LEDGER_RETENTION_MS = 30 * 60_000

const MAX_PER_CHAT = 20
const MAX_CHATS = 1000

/** Stable JSON (sorted object keys) used to compare arguments. */
export function stableKey(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  try {
    return JSON.stringify(norm(value)) ?? String(value)
  } catch {
    return String(value)
  }
}

interface Entry extends AIToolExecution { argsKey: string }

/** The ledger of one chat, as seen by the tool loop. */
export interface ChatToolLedger {
  /** Last successful run of `tool` still remembered. */
  last(tool: string): AIToolExecution | undefined
  /** A successful run of `tool` with the same arguments within `windowMs`. */
  find(tool: string, args: unknown, windowMs: number): AIToolExecution | undefined
  /** Remember a successful run. */
  record(tool: string, args: unknown, result: unknown): void
  /** Remembered runs, oldest first. */
  list(): AIToolExecution[]
}

/**
 * In-memory record of successful runs of side-effecting tools (`confirm: true`
 * or `dedupe`) per chat, so a repeated call can be flagged in the confirmation
 * prompt or blocked. Bounded per chat and in number of chats; entries expire
 * after `retentionMs`. It lives in RAM (lost on restart), like a cooldown.
 */
export class ToolLedger {
  private readonly chats = new Map<string, Entry[]>()

  constructor(private readonly retentionMs = DEFAULT_LEDGER_RETENTION_MS, private readonly now: () => number = Date.now) {}

  private live(chatKey: string): Entry[] {
    const list = this.chats.get(chatKey)
    if (!list) return []
    const cutoff = this.now() - this.retentionMs
    const kept = list.filter((e) => e.at >= cutoff)
    if (kept.length === 0) this.chats.delete(chatKey)
    else if (kept.length !== list.length) this.chats.set(chatKey, kept)
    return kept
  }

  /** A view bound to one chat. */
  forChat(chatKey: string): ChatToolLedger {
    const strip = ({ argsKey: _k, ...e }: Entry): AIToolExecution => e
    return {
      last: (tool) => {
        const hit = findLast(this.live(chatKey), (e) => e.tool === tool)
        return hit && strip(hit)
      },
      find: (tool, args, windowMs) => {
        const key = stableKey(args)
        const cutoff = this.now() - windowMs
        const hit = findLast(this.live(chatKey), (e) => e.tool === tool && e.argsKey === key && e.at >= cutoff)
        return hit && strip(hit)
      },
      record: (tool, args, result) => {
        const list = [...this.live(chatKey), { tool, args, result, at: this.now(), argsKey: stableKey(args) }].slice(-MAX_PER_CHAT)
        // Re-insert to keep the map in least-recently-used order, then cap the number of chats.
        this.chats.delete(chatKey)
        this.chats.set(chatKey, list)
        while (this.chats.size > MAX_CHATS) this.chats.delete(this.chats.keys().next().value as string)
      },
      list: () => this.live(chatKey).map(strip),
    }
  }

  /** Forget one chat (e.g. on `/reset`), or every chat. */
  clear(chatKey?: string): void {
    if (chatKey === undefined) this.chats.clear()
    else this.chats.delete(chatKey)
  }
}

function findLast<T>(list: readonly T[], pred: (x: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i]!)) return list[i]
  return undefined
}
