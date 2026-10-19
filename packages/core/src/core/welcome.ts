/**
 * WelcomeTracker — the store-backed "first contact" state behind the `WELCOME`
 * trigger (see `core/triggers.ts` for the user-facing semantics).
 *
 * Storage: the optional cursor key/value of `IStore` (`getCursor`/`setCursor`),
 * which every bundled store implements and `NamespacedStore` isolates per bot.
 * No new store contract, so any conforming store works; a store without cursor
 * support degrades to the in-process cache (not restart-proof).
 *
 * Entries (ids are opaque: escaped and hashed, never parsed):
 *  - DM marker          (chat)          → `'w'` once welcomed, `''` when re-armed
 *  - group participant  (chat, user)    → `'w' + <generation>`
 *  - group generation   (chat)          → token bumped by `reset(chat)`
 * A participant counts as welcomed only when their marker carries the current
 * generation, so `reset(groupId)` re-arms every participant with one write and
 * without enumerating them. Store keys are `welcome:<sha256>` of the entry, so
 * no raw (personal) id is written into the cursor table and every key has the
 * same short length (fits MySQL's `VARCHAR(255)` key column). The cursor API
 * has no delete, so a re-armed entry is an empty value under a hashed key.
 *
 * Concurrency: the Dispatcher asks inside its per-chat FIFO, whose key is never
 * coarser-grained than a welcome key, so two messages of the same subject are
 * never decided concurrently. `reset()`/`forget()` come from outside that FIFO
 * (a command handler of another chat, an admin API), so every store-touching
 * operation is also serialized per chat id: a reset issued while a check is
 * reading or recording a first contact runs after it, and is never undone by it.
 * The positive result is cached in memory (bounded LRU), so a known user costs
 * no store reads (and no queueing) afterwards.
 */

import { createHash } from 'node:crypto'
import { randomId } from '../utils/timers.js'
import { KeyedQueue } from '../utils/keyedQueue.js'

/** The slice of `IStore` the tracker uses. */
export interface WelcomeStore {
  getCursor?(key: string): Promise<string | undefined>
  setCursor?(key: string, value: string): Promise<void>
}

/** The message fields that identify a welcome subject. */
export interface WelcomeSubject {
  from: string
  sender: string
  isGroup: boolean
}

export interface WelcomeTrackerOptions {
  /** Persistent backend. Omit for an in-process tracker. */
  store?: WelcomeStore
  /** Max welcomed subjects kept in memory (LRU). Default 10 000. */
  maxCached?: number
  /** Receives store failures (reads fail closed; writes are best-effort). */
  onError?: (error: unknown) => void
}

const WELCOMED = 'w'

export class WelcomeTracker {
  /** Subjects known to be welcomed (positive cache, insertion order = LRU order). */
  private readonly welcomed = new Map<string, true>()
  /** One decision per message object, shared by every WELCOME matcher of that dispatch. */
  private readonly decisions = new WeakMap<object, Promise<boolean>>()
  private readonly maxCached: number
  /** Serializes checks, resets and erasures per chat id (see "Concurrency" above). */
  private readonly lanes = new KeyedQueue()

  constructor(private readonly opts: WelcomeTrackerOptions = {}) {
    this.maxCached = Math.max(1, opts.maxCached ?? 10_000)
  }

  /**
   * Is this message the subject's first contact? A `true` answer is returned
   * exactly once per subject (until {@link reset}); the subject is marked as
   * welcomed before resolving. Repeated calls with the same message object get
   * the same answer.
   */
  isFirstContact(subject: WelcomeSubject): Promise<boolean> {
    let decision = this.decisions.get(subject)
    if (!decision) {
      decision = this.decide(subject)
      this.decisions.set(subject, decision)
    }
    return decision
  }

  /**
   * Re-arm WELCOME. With `userId`: that participant of a group chat (and the
   * chat itself if it is a DM). Without it: the DM chat, or every participant
   * of the group chat.
   */
  reset(chatId: string, userId?: string): Promise<void> {
    return this.lanes.run(chatId, () => this.resetNow(chatId, userId))
  }

  private async resetNow(chatId: string, userId?: string): Promise<void> {
    const chatKey = subjectKey(chatId)
    this.welcomed.delete(chatKey)
    if (userId === undefined) {
      const prefix = `${chatKey}:`
      for (const key of this.welcomed.keys()) if (key.startsWith(prefix)) this.welcomed.delete(key)
    } else {
      this.welcomed.delete(subjectKey(chatId, userId))
    }

    const store = this.opts.store
    if (!store?.setCursor) return
    await Promise.all([
      store.setCursor(storeKey(chatKey), ''),
      userId === undefined
        ? store.setCursor(storeKey(generationKey(chatId)), randomId('gen'))
        : store.setCursor(storeKey(subjectKey(chatId, userId)), ''),
    ])
  }

  /**
   * Subject erasure (`Bot.deleteSubject`): re-arm `userId` as a participant of
   * each of `chatIds`, and as the DM whose chat id equals `userId`. Reads first
   * and only clears entries that are set, so no rows are created for chats the
   * subject was never greeted in.
   */
  async forget(userId: string, chatIds: Iterable<string>): Promise<void> {
    // welcome entry → lane (chat id): the DM whose chat id is the user, and each group.
    const entries = new Map<string, string>([[subjectKey(userId), userId]])
    for (const chatId of chatIds) entries.set(subjectKey(chatId, userId), chatId)
    for (const [key, lane] of entries) {
      await this.lanes.run(lane, async () => {
        this.welcomed.delete(key)
        const store = this.opts.store
        if (!store?.getCursor || !store.setCursor) return
        if (await store.getCursor(storeKey(key))) await store.setCursor(storeKey(key), '')
      })
    }
  }

  private async decide(subject: WelcomeSubject): Promise<boolean> {
    const key = subjectKey(subject.from, subject.isGroup ? subject.sender : undefined)
    if (this.welcomed.has(key)) {
      this.remember(key) // refresh LRU position
      return false
    }
    return this.lanes.run(subject.from, () => this.decideNow(subject, key))
  }

  private async decideNow(subject: WelcomeSubject, key: string): Promise<boolean> {
    // Re-check: an earlier check of this subject may have completed while this one queued.
    if (this.welcomed.has(key)) {
      this.remember(key)
      return false
    }

    const store = this.opts.store
    let generation = ''
    let welcomedBefore: boolean
    try {
      const [marker, gen] = await Promise.all([
        store?.getCursor?.(storeKey(key)),
        subject.isGroup ? store?.getCursor?.(storeKey(generationKey(subject.from))) : undefined,
      ])
      generation = gen ?? ''
      welcomedBefore = subject.isGroup ? marker === WELCOMED + generation : !!marker
    } catch (error) {
      // Fail closed: never greet on an unknown state. Not cached, so the next message retries.
      this.opts.onError?.(error)
      return false
    }

    this.remember(key)
    if (welcomedBefore) return false
    try {
      await store?.setCursor?.(storeKey(key), WELCOMED + generation)
    } catch (error) {
      // Still welcomed in this process (cached above); only the restart-proofing is lost.
      this.opts.onError?.(error)
    }
    return true
  }

  private remember(key: string): void {
    this.welcomed.delete(key)
    this.welcomed.set(key, true)
    while (this.welcomed.size > this.maxCached) {
      const oldest = this.welcomed.keys().next().value
      if (oldest === undefined) break
      this.welcomed.delete(oldest)
    }
  }
}

function subjectKey(chatId: string, userId?: string): string {
  const chat = `welcome:${encodeURIComponent(chatId)}`
  return userId === undefined ? chat : `${chat}:${encodeURIComponent(userId)}`
}

function generationKey(chatId: string): string {
  return `welcome-gen:${encodeURIComponent(chatId)}`
}

/** Fixed-length, id-free store key for an entry (`welcome:` + 43 chars). */
function storeKey(key: string): string {
  return `welcome:${createHash('sha256').update(key).digest('base64url')}`
}
