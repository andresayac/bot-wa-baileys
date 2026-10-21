/**
 * Long-term, per-user memory for the AI plugin (FEATURES.md #30).
 *
 * Facts live in the persistent user profile (`ctx.user`, FEATURES.md #1) under
 * the namespace `'ai.memory'` (key `facts`), keyed by the canonical sender id —
 * so the same person keeps their memory across chats (DM and groups) and
 * restarts (with a persistent store), and `bot.deleteSubject(userId)` erases
 * it together with the rest of the profile.
 *
 * Background extraction is tied to a memory *epoch* (key `epoch` of the same
 * namespace): erasing the profile or `clear()` ends it, and facts extracted
 * under an ended epoch are dropped, so an in-flight extraction can never bring
 * erased data back.
 */

import { parseDuration, type UserData } from '@botmesh/core'

/** One remembered fact about a user. */
export interface MemoryFact {
  text: string
  /** Epoch ms when first remembered. */
  createdAt: number
  /** Epoch ms of the last time the fact was (re)stated. */
  updatedAt: number
  /** Epoch ms after which the fact is forgotten (absent = permanent). */
  expiresAt?: number
  /** `'auto'` = extracted by the model, `'manual'` = written by your code. */
  source: 'auto' | 'manual'
}

/** Strict extraction options (see {@link AIMemoryConfig.autoExtract}). */
export interface AIMemoryExtractConfig {
  /** Model used for extraction (default: the plugin's model). */
  model?: string
  /**
   * Token budget of the extraction call (reasoning models spend part of it thinking). Default 1024 on providers with a built-in
   * cap; Ollama sends no cap unless this (or the plugin's `maxTokens`) is set.
   */
  maxTokens?: number
  /** Max new facts accepted per turn. Default 5. */
  maxFactsPerTurn?: number
  /** Extra guidance appended to the extraction prompt (what to keep / ignore). */
  instructions?: string
  /** Drop a candidate fact when this returns false (e.g. a PII filter). */
  filter?: (fact: string) => boolean
}

/** `aiPlugin({ memory })` options. */
export interface AIMemoryConfig {
  /** Only `'per-user'` is supported (keyed by `ctx.sender`). */
  type?: 'per-user'
  /** Max facts kept per user; the oldest are dropped first. Default 50. */
  maxFacts?: number
  /**
   * Lifetime of each fact (`'30d'`, `'12h'`, ms). Re-stating a fact renews
   * it. Default: permanent.
   */
  ttl?: string | number
  /** Max characters per fact (longer facts are rejected). Default 300. */
  maxFactLength?: number
  /** Inject the user's facts into the system prompt of `replyInChat`. Default true. */
  inject?: boolean
  /**
   * Also inject them when the user writes in a group. Every member reads the
   * reply, so facts learned in private could leak there. Default false.
   */
  injectInGroups?: boolean
  /**
   * After each autoreply turn, ask the model (in the background) to extract
   * durable facts as strict JSON (`{"facts": string[]}`) and store them.
   * Default false.
   */
  autoExtract?: boolean | AIMemoryExtractConfig
  /** Profile namespace. Default `'ai.memory'`. */
  namespace?: string
}

/** Options of {@link MemoryManager.add}. */
export interface RememberOptions {
  /** Override the configured fact TTL for these facts. */
  ttl?: string | number
  /** Default `'manual'`. */
  source?: 'auto' | 'manual'
}

export const DEFAULT_MEMORY_NAMESPACE = 'ai.memory'
const FACTS_KEY = 'facts'
const EPOCH_KEY = 'epoch'

const newEpoch = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`

/** Resolves the persistent profile of a subject (`(id) => bot.user(id)`). */
export type UserDataAccessor = (userId: string) => UserData

const normalise = (text: string): string =>
  text.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/[.!¡¿?]+$/u, '').toLowerCase()

function toMs(ttl: string | number | undefined): number | undefined {
  if (ttl === undefined) return undefined
  const ms = parseDuration(ttl)
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`invalid memory ttl: ${String(ttl)}`)
  return ms
}

function isFact(v: unknown): v is MemoryFact {
  const f = v as MemoryFact
  return !!f && typeof f === 'object' && typeof f.text === 'string' && typeof f.createdAt === 'number' && typeof f.updatedAt === 'number'
}

export class MemoryManager {
  readonly maxFacts: number
  readonly maxFactLength: number
  readonly namespace: string
  private readonly ttlMs: number | undefined
  /** Per-user read-modify-write lock (the profile serialises writes, not RMW cycles). */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly access: UserDataAccessor,
    readonly config: AIMemoryConfig = {},
    private readonly now: () => number = Date.now,
  ) {
    this.maxFacts = config.maxFacts ?? 50
    this.maxFactLength = config.maxFactLength ?? 300
    this.namespace = config.namespace ?? DEFAULT_MEMORY_NAMESPACE
    this.ttlMs = toMs(config.ttl)
    if (!Number.isSafeInteger(this.maxFacts) || this.maxFacts < 1) throw new RangeError('memory.maxFacts must be a positive integer')
  }

  /** Whether facts are injected into the system prompt. */
  get injects(): boolean { return this.config.inject !== false }

  /** Whether facts are injected into replies sent to group chats. */
  get injectsInGroups(): boolean { return this.injects && this.config.injectInGroups === true }

  /** Extraction settings, or `undefined` when auto-extraction is off. */
  get extraction(): AIMemoryExtractConfig | undefined {
    const a = this.config.autoExtract
    if (!a) return undefined
    return a === true ? {} : a
  }

  private profile(userId: string): UserData {
    return this.access(userId).ns(this.namespace)
  }

  private locked<T>(userId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve()
    const run = prev.then(op, op)
    const tail = run.catch(() => {})
    this.locks.set(userId, tail)
    void tail.then(() => { if (this.locks.get(userId) === tail) this.locks.delete(userId) })
    return run
  }

  private async read(userId: string): Promise<MemoryFact[]> {
    const raw = await this.profile(userId).get<unknown>(FACTS_KEY)
    if (!Array.isArray(raw)) return []
    const now = this.now()
    return raw.filter(isFact).filter((f) => f.expiresAt === undefined || f.expiresAt > now)
  }

  private async write(userId: string, facts: MemoryFact[]): Promise<void> {
    const profile = this.profile(userId)
    if (facts.length === 0) { await profile.delete(FACTS_KEY); return }
    // The profile key expires with its longest-lived fact (none permanent → TTL).
    const permanent = facts.some((f) => f.expiresAt === undefined)
    const ttl = permanent ? undefined : Math.max(1, Math.max(...facts.map((f) => f.expiresAt!)) - this.now())
    await profile.set(FACTS_KEY, facts, ttl === undefined ? undefined : { ttl })
  }

  /** Live facts of `userId`, oldest first. */
  facts(userId: string): Promise<MemoryFact[]> {
    return this.read(userId)
  }

  /** Live fact texts of `userId`, oldest first. */
  async list(userId: string): Promise<string[]> {
    return (await this.read(userId)).map((f) => f.text)
  }

  /**
   * Remember one or more facts. Duplicates (case/punctuation-insensitive)
   * renew the existing fact instead of adding a copy; beyond `maxFacts` the
   * oldest facts are dropped. Resolves with the facts that were NEW.
   */
  add(userId: string, input: string | readonly string[], options: RememberOptions = {}): Promise<string[]> {
    return this.store(userId, input, options, undefined)
  }

  /**
   * Token of the current life of `userId`'s memory, created on first use.
   * Erasing the profile (`bot.deleteSubject`) or {@link clear} ends it.
   */
  epoch(userId: string): Promise<string> {
    return this.locked(userId, async () => {
      const profile = this.profile(userId)
      const current = await profile.get<unknown>(EPOCH_KEY)
      if (typeof current === 'string' && current) return current
      const next = newEpoch()
      await profile.set(EPOCH_KEY, next)
      return next
    })
  }

  /**
   * {@link add}, but only while `epoch` (from {@link epoch}) is still current:
   * facts gathered before an erasure are dropped instead of written back.
   */
  addIfCurrent(userId: string, epoch: string, input: string | readonly string[], options: RememberOptions = {}): Promise<string[]> {
    return this.store(userId, input, options, epoch)
  }

  private store(userId: string, input: string | readonly string[], options: RememberOptions, epoch: string | undefined): Promise<string[]> {
    const ttlMs = options.ttl === undefined ? this.ttlMs : toMs(options.ttl)
    const texts = (typeof input === 'string' ? [input] : [...input])
      .map((t) => (typeof t === 'string' ? t.trim().replace(/\s+/g, ' ') : ''))
      .filter((t) => t.length > 0 && t.length <= this.maxFactLength)
    if (texts.length === 0) return Promise.resolve([])
    const current = async (): Promise<boolean> =>
      epoch === undefined || (await this.profile(userId).get<unknown>(EPOCH_KEY)) === epoch
    return this.locked(userId, async () => {
      if (!(await current())) return []
      const now = this.now()
      const facts = await this.read(userId)
      const added: string[] = []
      for (const text of texts) {
        const key = normalise(text)
        const existing = facts.findIndex((f) => normalise(f.text) === key)
        const expiresAt = ttlMs === undefined ? undefined : now + ttlMs
        if (existing >= 0) {
          const [f] = facts.splice(existing, 1)
          const renewed: MemoryFact = { ...f!, updatedAt: now }
          if (expiresAt === undefined) delete renewed.expiresAt
          else renewed.expiresAt = expiresAt
          facts.push(renewed) // most recently stated goes last (survives trimming)
          continue
        }
        const fact: MemoryFact = { text, createdAt: now, updatedAt: now, source: options.source ?? 'manual' }
        if (expiresAt !== undefined) fact.expiresAt = expiresAt
        facts.push(fact)
        added.push(text)
      }
      const kept = facts.length > this.maxFacts ? facts.slice(facts.length - this.maxFacts) : facts
      await this.write(userId, kept)
      // Erasure is not under this lock: if it landed between the check and the
      // write, the epoch is gone now, so undo the write (erasure wins).
      if (!(await current())) {
        await this.profile(userId).delete(FACTS_KEY)
        return []
      }
      return added.filter((t) => kept.some((f) => f.text === t))
    })
  }

  /** Forget one fact (matched case/punctuation-insensitively). Resolves `true` if it existed. */
  remove(userId: string, fact: string): Promise<boolean> {
    return this.locked(userId, async () => {
      const facts = await this.read(userId)
      const key = normalise(fact)
      const kept = facts.filter((f) => normalise(f.text) !== key)
      if (kept.length === facts.length) return false
      await this.write(userId, kept)
      return true
    })
  }

  /** Forget everything about `userId` (only this memory namespace); ends the current {@link epoch}. */
  clear(userId: string): Promise<void> {
    return this.locked(userId, () => this.profile(userId).clear())
  }
}
