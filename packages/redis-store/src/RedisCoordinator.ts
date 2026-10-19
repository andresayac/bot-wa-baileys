/**
 * RedisCoordinator — multi-replica {@link Coordinator} for `@bot-wa/core`, on one Redis.
 *
 * Every replica of a bot gets its own instance (distinct `replicaId`) pointing at the
 * same Redis and `prefix`, passed as `BotConfig.coordination.coordinator`:
 *
 * - **Chat turns**: a per-key ticket counter (`INCR`) gives each inbound message its
 *   place in the chat's cross-replica FIFO; a Lua compare-and-set hands the turn to the
 *   tickets in order. A turn is a `PX` lease renewed by a watchdog, and its fence is the
 *   ticket number. Tickets of a replica whose heartbeat expired are skipped.
 * - **Leadership** (provider sessions, singleton jobs): `SET`-if-absent with a `PX`
 *   lease plus an `INCR` term counter, so every new leader gets a strictly larger fence.
 *
 * The watchdog renews this replica's heartbeat, turns and leaderships every
 * `leaseMs / 3`. A renewal that finds the lease gone aborts the matching `signal`
 * (`'expired'`); when no renewal succeeded for 90% of `leaseMs` (Redis unreachable)
 * everything is aborted (`'coordinator-down'`) before the server-side lease can expire,
 * so a replica always gives up before another one can take over.
 *
 * Limits: one Redis primary (standalone or Sentinel). A failover that loses the last
 * writes can grant a lease twice; Redis Cluster is not supported (the scripts touch keys
 * of several hash slots).
 *
 * @example
 * ```ts
 * import { Bot } from '@bot-wa/core'
 * import { RedisStore, RedisCoordinator } from '@bot-wa/redis-store'
 *
 * const store = new RedisStore({ url: process.env.REDIS_URL, prefix: 'mybot' })
 * const bot = new Bot({
 *   provider,
 *   store,
 *   coordination: { coordinator: new RedisCoordinator({ url: process.env.REDIS_URL, prefix: 'mybot' }) },
 * })
 * ```
 */
import { randomUUID } from 'node:crypto'
import { createClient } from 'redis'
import {
  CoordinationUnavailableError,
  LeaseLostError,
  parseDuration,
  type AcquireTurnOptions,
  type ChatTurn,
  type Coordinator,
  type CoordinatorEvents,
  type Leadership,
  type LeaseLossReason,
  type Ticket,
} from '@bot-wa/core'
import type { NativeRedisClient, RedisLikeClient } from './RedisStore.js'
import {
  HEARTBEAT_SCRIPT,
  LEAD_RELEASE_SCRIPT,
  LEAD_SCRIPT,
  LEAVE_SCRIPT,
  RELEASE_TURN_SCRIPT,
  RENEW_SCRIPT,
  RESERVE_SCRIPT,
  TURN_SCRIPT,
} from './coordScripts.js'

/** The client surface the coordinator uses: EVAL (plus connect/quit for an own client). */
export type CoordinatorClient = Pick<RedisLikeClient, 'eval'> & Partial<Pick<RedisLikeClient, 'connect' | 'quit' | 'isOpen'>>

export interface RedisCoordinatorOptions {
  /** Redis URL for an own client (connected by `start()`, closed by `stop()`). Ignored with `client`. */
  url?: string
  /**
   * Share an existing client (e.g. the one your `RedisStore` uses, or a fake in tests).
   * The coordinator never connects or closes it.
   */
  client?: CoordinatorClient | NativeRedisClient
  /** Key prefix; use the same one on every replica of the bot. Default `'botwa'`. */
  prefix?: string
  /** This replica's id (unique among replicas). Default: a random UUID per process. */
  replicaId?: string
  /**
   * Lease length of turns, leaderships and the heartbeat: a duration (`'15s'`) or ms.
   * A dead replica's work is taken over after about this long. Default `'15s'`.
   */
  leaseMs?: string | number
  /** How long a key's counters live after its last turn (a duration or ms). Default `'1d'`. */
  idleTtlMs?: string | number
  /** Longest pause between two polls while waiting for a turn or a leadership (ms). Default 100. */
  maxPollMs?: number
  /** Receives backend errors of the watchdog. */
  logger?: { warn?: (obj: object, msg?: string) => void }
}

interface HeldTurn { key: string; seq: number; value: string; ownerKey: string; ac: AbortController; released?: boolean }
interface HeldLead { name: string; term: number; value: string; leadKey: string; ac: AbortController; released?: boolean }

type Listener = (payload: never) => void

const DEFAULT_LEASE_MS = 15_000
const DEFAULT_IDLE_MS = 24 * 60 * 60 * 1000

function positiveMs(value: string | number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const ms = typeof value === 'number' ? value : parseDuration(value)
  if (!(ms > 0) || !Number.isFinite(ms)) throw new RangeError(`RedisCoordinator: ${name} must be a positive duration, got ${String(value)}`)
  return Math.ceil(ms)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export class RedisCoordinator implements Coordinator {
  readonly replicaId: string
  /** Lease length in ms. */
  readonly leaseMs: number
  private readonly client: CoordinatorClient
  private readonly ownsClient: boolean
  private readonly base: string
  private readonly idleMs: number
  private readonly maxPollMs: number
  private readonly logger?: RedisCoordinatorOptions['logger']
  private readonly turns = new Set<HeldTurn>()
  private readonly leads = new Set<HeldLead>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private running = false
  private timer?: ReturnType<typeof setInterval>
  /** Fires 90% of a lease after the last confirmed renewal: give every lease up locally. */
  private deadline?: ReturnType<typeof setTimeout>
  private renewing = false
  /** performance.now() at which the last fully successful renewal round was SENT. */
  private lastRenewOk = 0

  constructor(opts: RedisCoordinatorOptions = {}) {
    this.replicaId = opts.replicaId ?? randomUUID()
    if (this.replicaId === '' || this.replicaId.includes('|')) throw new RangeError('RedisCoordinator: replicaId must be non-empty and must not contain "|"')
    this.leaseMs = positiveMs(opts.leaseMs, DEFAULT_LEASE_MS, 'leaseMs')
    this.idleMs = positiveMs(opts.idleTtlMs, DEFAULT_IDLE_MS, 'idleTtlMs')
    this.maxPollMs = opts.maxPollMs ?? 100
    this.base = `${opts.prefix ?? 'botwa'}:co`
    this.logger = opts.logger
    this.ownsClient = !opts.client
    this.client = (opts.client ?? createClient({ url: opts.url ?? 'redis://localhost:6379' })) as CoordinatorClient
  }

  /* keys ------------------------------------------------------------------ */

  private repKey(id: string): string { return `${this.base}:rep:${id}` }
  private turnKeys(key: string) {
    const k = `${this.base}:t:${key}`
    return { seq: `${k}:seq`, tix: `${k}:tix`, serving: `${k}:serving`, owner: `${k}:owner`, last: `${k}:last` }
  }
  private leadKey(name: string): string { return `${this.base}:lead:${name}` }

  private run(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
    return this.client.eval(script, { keys, arguments: args.map(String) })
  }

  /* lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.running) return
    if (this.ownsClient && this.client.isOpen !== true) await this.client.connect?.()
    await this.run(HEARTBEAT_SCRIPT, [this.repKey(this.replicaId)], [this.leaseMs])
    this.lastRenewOk = performance.now()
    this.armDeadline()
    this.running = true
    this.timer = setInterval(() => { void this.tick() }, Math.max(10, Math.floor(this.leaseMs / 3)))
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.deadline) clearTimeout(this.deadline)
    const releases: Array<Promise<unknown>> = []
    for (const t of [...this.turns]) {
      this.drop(t, 'stopped', false)
      releases.push(this.releaseTurn(t).catch(() => {}))
    }
    for (const l of [...this.leads]) {
      this.dropLead(l, 'stopped', false)
      releases.push(this.releaseLead(l).catch(() => {}))
    }
    await Promise.all(releases)
    await this.run(LEAVE_SCRIPT, [this.repKey(this.replicaId)], []).catch(() => {})
    if (this.ownsClient) await this.client.quit?.().catch(() => {})
  }

  /**
   * Test/chaos helper: behave like a replica that died — stop renewing WITHOUT releasing
   * anything (other replicas take over once the leases expire) and abort every local
   * signal with `'expired'`.
   */
  simulateCrash(): void {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.deadline) clearTimeout(this.deadline)
    for (const t of [...this.turns]) this.drop(t, 'expired', true)
    for (const l of [...this.leads]) this.dropLead(l, 'expired', true)
  }

  /* turns ------------------------------------------------------------------ */

  async reserve(key: string): Promise<Ticket> {
    this.assertRunning(key)
    const k = this.turnKeys(key)
    let seq: number
    try {
      seq = Number(await this.run(RESERVE_SCRIPT, [k.seq, k.tix, k.serving, k.last], [this.replicaId]))
    } catch (error) {
      throw new CoordinationUnavailableError(key, 'unavailable', { cause: error })
    }
    let cancelled = false
    return {
      key,
      seq,
      cancel: async () => {
        if (cancelled) return
        cancelled = true
        await this.run(RELEASE_TURN_SCRIPT, [k.serving, k.owner, k.tix, k.last, k.seq], [seq, this.replicaId, this.idleMs])
      },
    }
  }

  async acquireTurn(ticket: Ticket, opts: AcquireTurnOptions = {}): Promise<ChatTurn> {
    const k = this.turnKeys(ticket.key)
    const deadline = opts.maxWaitMs !== undefined ? performance.now() + opts.maxWaitMs : undefined
    let pause = 5
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason
      if (!this.running) throw new LeaseLostError(ticket.key, ticket.seq, 'stopped')
      const sentAt = performance.now()
      let reply: [number, string]
      try {
        reply = (await this.run(TURN_SCRIPT, [k.serving, k.owner, k.tix, k.last], [ticket.seq, this.replicaId, this.leaseMs, `${this.base}:rep:`])) as [number, string]
      } catch (error) {
        throw new CoordinationUnavailableError(ticket.key, 'unavailable', { cause: error })
      }
      const status = Number(reply[0])
      if (status === 1) {
        const value = `${ticket.seq}|${this.replicaId}`
        const held: HeldTurn = { key: ticket.key, seq: ticket.seq, value, ownerKey: k.owner, ac: new AbortController() }
        if (!this.running) {
          await this.releaseTurn(held).catch(() => {})
          throw new LeaseLostError(ticket.key, ticket.seq, 'stopped')
        }
        this.turns.add(held)
        // A turn granted by a reply that took longer than the lease is already unsafe.
        if (performance.now() - sentAt > this.leaseMs * 0.9) this.drop(held, 'expired', true)
        return this.turnOf(held, reply[1] ? String(reply[1]) : null)
      }
      if (status === -1) throw new LeaseLostError(ticket.key, ticket.seq, 'superseded')
      const now = performance.now()
      if (deadline !== undefined && now >= deadline) {
        await ticket.cancel().catch(() => {})
        throw new CoordinationUnavailableError(ticket.key, 'timeout')
      }
      const wait = deadline !== undefined ? Math.min(pause, deadline - now) : pause
      await sleep(wait, opts.signal)
      pause = Math.min(this.maxPollMs, pause * 2)
    }
  }

  private turnOf(held: HeldTurn, previousHolder: string | null): ChatTurn {
    const signal = held.ac.signal
    return {
      key: held.key,
      fence: held.seq,
      previousHolder,
      signal,
      assertHeld: () => {
        // The watchdog may not have run yet (a long synchronous stretch): check the deadline here too.
        if (!signal.aborted && performance.now() - this.lastRenewOk > this.leaseMs * 0.9) this.drop(held, 'expired', true)
        if (signal.aborted) throw signal.reason
      },
      // Released even after a local loss: the compare-and-set only acts while it is still ours.
      release: async () => {
        this.turns.delete(held)
        await this.releaseTurn(held)
      },
    }
  }

  private async releaseTurn(held: HeldTurn): Promise<unknown> {
    if (held.released) return
    held.released = true
    const k = this.turnKeys(held.key)
    return this.run(RELEASE_TURN_SCRIPT, [k.serving, k.owner, k.tix, k.last, k.seq], [held.seq, this.replicaId, this.idleMs])
  }

  /* leadership ------------------------------------------------------------- */

  async lead(name: string, opts: { signal?: AbortSignal } = {}): Promise<Leadership> {
    let pause = 5
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason
      const won = await this.tryLead(name)
      if (won) return won
      await sleep(pause, opts.signal)
      pause = Math.min(Math.max(this.maxPollMs, Math.floor(this.leaseMs / 3)), pause * 2)
    }
  }

  async tryLead(name: string): Promise<Leadership | null> {
    this.assertRunning(name)
    const leadKey = this.leadKey(name)
    let term: number
    try {
      term = Number(await this.run(LEAD_SCRIPT, [leadKey, `${leadKey}:term`], [this.replicaId, this.leaseMs]))
    } catch (error) {
      throw new CoordinationUnavailableError(name, 'unavailable', { cause: error })
    }
    if (!term) {
      this.emit('follower', { name })
      return null
    }
    let held = [...this.leads].find((l) => l.name === name && l.term === term)
    if (!held) {
      held = { name, term, value: `${term}|${this.replicaId}`, leadKey, ac: new AbortController() }
      this.leads.add(held)
      this.emit('leader', { name, fence: term })
    }
    const entry = held
    return {
      name,
      fence: term,
      signal: entry.ac.signal,
      release: async () => {
        this.leads.delete(entry)
        await this.releaseLead(entry)
      },
    }
  }

  private async releaseLead(held: HeldLead): Promise<unknown> {
    if (held.released) return
    held.released = true
    return this.run(LEAD_RELEASE_SCRIPT, [held.leadKey], [held.value])
  }

  /* events ----------------------------------------------------------------- */

  on<E extends keyof CoordinatorEvents>(event: E, listener: (payload: CoordinatorEvents[E]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(listener as Listener)
    return () => { set!.delete(listener as Listener) }
  }

  private emit<E extends keyof CoordinatorEvents>(event: E, payload: CoordinatorEvents[E]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) {
      try { (l as (p: CoordinatorEvents[E]) => void)(payload) } catch { /* listeners must not break coordination */ }
    }
  }

  /* watchdog --------------------------------------------------------------- */

  /**
   * If Redis has not confirmed our leases for 90% of a lease, give them all up locally,
   * BEFORE the server-side PX can expire and hand them to another replica.
   */
  private armDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline)
    const due = this.lastRenewOk + this.leaseMs * 0.9 - performance.now()
    this.deadline = setTimeout(() => this.giveUpIfStale(), Math.max(0, due))
    this.deadline.unref?.()
  }

  private giveUpIfStale(): void {
    if (performance.now() - this.lastRenewOk < this.leaseMs * 0.9) return this.armDeadline()
    for (const t of [...this.turns]) this.drop(t, 'coordinator-down', true)
    for (const l of [...this.leads]) this.dropLead(l, 'coordinator-down', true)
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    if (performance.now() - this.lastRenewOk > this.leaseMs * 0.9) this.giveUpIfStale()
    if (this.renewing) return
    this.renewing = true
    const sentAt = performance.now()
    try {
      const turns = [...this.turns]
      const leads = [...this.leads]
      const results = await Promise.all([
        this.run(HEARTBEAT_SCRIPT, [this.repKey(this.replicaId)], [this.leaseMs]),
        ...turns.map((t) => this.run(RENEW_SCRIPT, [t.ownerKey], [t.value, this.leaseMs])),
        ...leads.map((l) => this.run(RENEW_SCRIPT, [l.leadKey], [l.value, this.leaseMs])),
      ])
      turns.forEach((t, i) => { if (Number(results[i + 1]) !== 1 && this.turns.has(t)) this.drop(t, 'expired', true) })
      leads.forEach((l, i) => { if (Number(results[i + 1 + turns.length]) !== 1 && this.leads.has(l)) this.dropLead(l, 'expired', true) })
      this.lastRenewOk = sentAt
      if (this.running) this.armDeadline()
    } catch (error) {
      this.logger?.warn?.({ err: error }, 'RedisCoordinator: lease renewal failed')
    } finally {
      this.renewing = false
    }
  }

  private drop(t: HeldTurn, reason: LeaseLossReason, report: boolean): void {
    this.turns.delete(t)
    if (t.ac.signal.aborted) return
    t.ac.abort(new LeaseLostError(t.key, t.seq, reason))
    if (report) this.emit('lease-lost', { key: t.key, holder: this.replicaId, fence: t.seq, reason })
  }

  private dropLead(l: HeldLead, reason: LeaseLossReason, report: boolean): void {
    this.leads.delete(l)
    if (l.ac.signal.aborted) return
    l.ac.abort(new LeaseLostError(l.name, l.term, reason))
    if (report) this.emit('lease-lost', { key: l.name, holder: this.replicaId, fence: l.term, reason })
  }

  private assertRunning(key: string): void {
    if (!this.running) throw new CoordinationUnavailableError(key, 'unavailable', { cause: new Error('RedisCoordinator not started') })
  }
}
