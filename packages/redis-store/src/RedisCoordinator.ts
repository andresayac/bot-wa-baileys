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
 * Each instance writes under its own **incarnation id** ({@link RedisCoordinator.incarnation}:
 * `replicaId` plus a random nonce), so a process restarted with the same fixed
 * `replicaId` (a pod name) never revives the tickets, turns or heartbeat of the
 * incarnation that died: those are skipped once its heartbeat lapses.
 *
 * A release, ticket cancel or reservation that fails on the wire (the server may have
 * applied it or not) is repaired by the watchdog, which withdraws every ticket of this
 * incarnation on that key that is no longer in use, so the chat is never left stalled
 * behind a live replica.
 *
 * The watchdog renews this replica's heartbeat, turns and leaderships every
 * `leaseMs / 3`. A renewal that finds the lease gone aborts the matching `signal`
 * (`'expired'`); when no renewal succeeded for 90% of `leaseMs` (Redis unreachable)
 * everything is aborted (`'coordinator-down'`) before the server-side lease can expire,
 * so a replica always gives up before another one can take over.
 *
 * Redis Cluster: pass a node-redis cluster client (or `cluster` options), or
 * `layout: 'cluster'`. Each chat's turn keys and each leadership's keys then share one
 * hash tag; a waiting turn probes another replica's heartbeat (another slot) with a
 * separate call before skipping its ticket.
 *
 * Limits: a failover that loses the last acknowledged writes (asynchronous replication,
 * Sentinel or Cluster alike) can grant a lease twice.
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
import { PROBE_EXISTS_SCRIPT, TURN_CLUSTER_SCRIPT } from './clusterScripts.js'
import { coordKeys, type CoordKeys, type RedisKeyLayout } from './layout.js'
import {
  createOwnRedisClient, resolveLayout, withClusterRetry,
  type NativeRedisClusterClient, type RedisClusterConnectOptions,
} from './client.js'
import {
  HEARTBEAT_SCRIPT,
  LEAD_RELEASE_SCRIPT,
  LEAD_SCRIPT,
  LEAVE_SCRIPT,
  RELEASE_TURN_SCRIPT,
  RENEW_SCRIPT,
  RESERVE_SCRIPT,
  SWEEP_SCRIPT,
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
  client?: CoordinatorClient | NativeRedisClient | NativeRedisClusterClient
  /** Create (and own) a Redis Cluster client (not combinable with `url`/`client`). Implies `layout: 'cluster'`. */
  cluster?: RedisClusterConnectOptions
  /**
   * Key layout (use the same on every replica). Default: `'cluster'` with a cluster client
   * or `cluster` options, else `'legacy'`. See `RedisStoreOptions.layout`.
   */
  layout?: RedisKeyLayout
  /** Key prefix; use the same one on every replica of the bot. Default `'botwa'`. */
  prefix?: string
  /**
   * This replica's id (unique among the live replicas). Default: a random UUID. A fixed
   * id (a pod or host name) is fine: every instance adds its own nonce in Redis
   * ({@link RedisCoordinator.incarnation}).
   */
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
  /**
   * Receives backend errors of the watchdog, and the client errors (connection drops,
   * failovers) of a coordinator-created client: an own client always has an `'error'`
   * listener, so a dropped connection is retried instead of crashing the process.
   */
  logger?: { warn?: (obj: object, msg?: string) => void }
}

interface HeldTurn { key: string; seq: number; value: string; ownerKey: string; ac: AbortController; released?: boolean }
interface HeldLead { name: string; term: number; value: string; leadKey: string; ac: AbortController; released?: boolean }

type Listener = (payload: never) => void

const DEFAULT_LEASE_MS = 15_000
/** Holders a single cluster-layout turn wait remembers as dead (oldest forgotten first). */
const MAX_DEAD_HOLDERS = 64
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
  /**
   * The id this instance writes to Redis (heartbeat, tickets, turns, leaderships):
   * `{replicaId}#{nonce}`, new for every instance. A `ChatTurn.previousHolder` of
   * another instance is reported as its incarnation, never as a bare `replicaId`.
   */
  readonly incarnation: string
  /** Lease length in ms. */
  readonly leaseMs: number
  private readonly client: CoordinatorClient
  private readonly ownsClient: boolean
  /** The key layout in use. */
  readonly layout: RedisKeyLayout
  private readonly keys: CoordKeys
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
  /** Tickets still in use per key (reserved and waiting, or granted and not released yet). */
  private readonly live = new Map<string, Set<number>>()
  /** Reservations in flight per key: a sweep then waits, or it would withdraw them. */
  private readonly reserving = new Map<string, number>()
  /** Keys where a release, cancel or reservation failed on the wire: swept by the watchdog. */
  private readonly dirty = new Set<string>()

  constructor(opts: RedisCoordinatorOptions = {}) {
    this.replicaId = opts.replicaId ?? randomUUID()
    if (this.replicaId === '' || this.replicaId.includes('|')) throw new RangeError('RedisCoordinator: replicaId must be non-empty and must not contain "|"')
    this.incarnation = `${this.replicaId}#${randomUUID().slice(0, 8)}`
    this.leaseMs = positiveMs(opts.leaseMs, DEFAULT_LEASE_MS, 'leaseMs')
    this.idleMs = positiveMs(opts.idleTtlMs, DEFAULT_IDLE_MS, 'idleTtlMs')
    this.maxPollMs = opts.maxPollMs ?? 100
    this.layout = resolveLayout('RedisCoordinator', opts)
    this.keys = coordKeys(opts.prefix ?? 'botwa', this.layout)
    this.logger = opts.logger
    this.ownsClient = !opts.client
    const raw = (opts.client ?? createOwnRedisClient({
      url: opts.url,
      cluster: opts.cluster,
      // node-redis re-throws an unheard 'error' event: a dropped node connection would crash the process.
      onError: (err: unknown) => this.logger?.warn?.({ err }, 'RedisCoordinator client error'),
    })) as CoordinatorClient
    // Cluster layout: TRYAGAIN/CLUSTERDOWN (replied before anything ran) are retried.
    this.client = this.layout === 'cluster' ? (withClusterRetry(raw as RedisLikeClient) as CoordinatorClient) : raw
  }

  /* keys ------------------------------------------------------------------ */

  private repKey(id: string): string { return this.keys.rep(id) }
  private turnKeys(key: string) { return this.keys.turn(key) }

  private run(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
    return this.client.eval(script, { keys, arguments: args.map(String) })
  }

  /* lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.running) return
    if (this.ownsClient && this.client.isOpen !== true) await this.client.connect?.()
    await this.run(HEARTBEAT_SCRIPT, [this.repKey(this.incarnation)], [this.leaseMs])
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
    // Withdraw the tickets still reserved (and anything a failed release left behind).
    const keys = new Set([...this.live.keys(), ...this.dirty])
    this.live.clear()
    this.dirty.clear()
    await Promise.all([...keys].map((key) => this.sweep(key).catch(() => {})))
    await this.run(LEAVE_SCRIPT, [this.repKey(this.incarnation)], []).catch(() => {})
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
    this.reserving.set(key, (this.reserving.get(key) ?? 0) + 1)
    try {
      seq = Number(await this.run(RESERVE_SCRIPT, [k.seq, k.tix, k.serving, k.last], [this.incarnation]))
      this.track(key, seq)
    } catch (error) {
      // The server may have reserved it anyway (lost reply): the watchdog withdraws it.
      this.dirty.add(key)
      throw new CoordinationUnavailableError(key, 'unavailable', { cause: error })
    } finally {
      const n = (this.reserving.get(key) ?? 1) - 1
      if (n > 0) this.reserving.set(key, n)
      else this.reserving.delete(key)
    }
    let cancelled = false
    return {
      key,
      seq,
      cancel: async () => {
        if (cancelled) return
        cancelled = true
        this.untrack(key, seq)
        try {
          await this.run(RELEASE_TURN_SCRIPT, [k.serving, k.owner, k.tix, k.last, k.seq], [seq, this.incarnation, this.idleMs])
        } catch (error) {
          this.dirty.add(key)
          throw error
        }
      },
    }
  }

  async acquireTurn(ticket: Ticket, opts: AcquireTurnOptions = {}): Promise<ChatTurn> {
    const k = this.turnKeys(ticket.key)
    const deadline = opts.maxWaitMs !== undefined ? performance.now() + opts.maxWaitMs : undefined
    // Cluster layout: holders seen without a heartbeat during this wait (see TURN_CLUSTER_SCRIPT).
    const dead = this.layout === 'cluster' ? new Set<string>() : undefined
    let pause = 5
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason
      if (!this.running) throw new LeaseLostError(ticket.key, ticket.seq, 'stopped')
      const sentAt = performance.now()
      let reply: [number, string]
      try {
        reply = (dead
          ? await this.run(TURN_CLUSTER_SCRIPT, [k.serving, k.owner, k.tix, k.last], [ticket.seq, this.incarnation, this.leaseMs, ...dead])
          : await this.run(TURN_SCRIPT, [k.serving, k.owner, k.tix, k.last], [ticket.seq, this.incarnation, this.leaseMs, this.keys.repPrefix])) as [number, string]
      } catch (error) {
        throw new CoordinationUnavailableError(ticket.key, 'unavailable', { cause: error })
      }
      const status = Number(reply[0])
      if (status === 2 && dead) {
        // An earlier ticket whose holder's liveness the script could not see (another slot).
        const holder = String(reply[1])
        if (holder !== this.incarnation && !(await this.alive(ticket.key, holder))) {
          if (dead.size >= MAX_DEAD_HOLDERS) dead.delete(dead.values().next().value!)
          dead.add(holder)
          continue
        }
      }
      if (status === 1) {
        const value = `${ticket.seq}|${this.incarnation}`
        const held: HeldTurn = { key: ticket.key, seq: ticket.seq, value, ownerKey: k.owner, ac: new AbortController() }
        if (!this.running) {
          await this.releaseTurn(held).catch(() => {})
          throw new LeaseLostError(ticket.key, ticket.seq, 'stopped')
        }
        this.turns.add(held)
        // A turn granted by a reply that took longer than the lease is already unsafe.
        if (performance.now() - sentAt > this.leaseMs * 0.9) this.drop(held, 'expired', true)
        const last = reply[1] ? String(reply[1]) : null
        return this.turnOf(held, last === this.incarnation ? this.replicaId : last)
      }
      if (status === -1) {
        this.untrack(ticket.key, ticket.seq)
        throw new LeaseLostError(ticket.key, ticket.seq, 'superseded')
      }
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

  /** Cluster layout: whether `holder`'s heartbeat exists right now (one-key probe in its own slot). */
  private async alive(key: string, holder: string): Promise<boolean> {
    try {
      return Number(await this.run(PROBE_EXISTS_SCRIPT, [this.repKey(holder)], [])) === 1
    } catch (error) {
      throw new CoordinationUnavailableError(key, 'unavailable', { cause: error })
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
    this.untrack(held.key, held.seq)
    const k = this.turnKeys(held.key)
    try {
      return await this.run(RELEASE_TURN_SCRIPT, [k.serving, k.owner, k.tix, k.last, k.seq], [held.seq, this.incarnation, this.idleMs])
    } catch (error) {
      // Not retried as such (it may have been applied): the watchdog sweeps the key instead.
      this.dirty.add(held.key)
      throw error
    }
  }

  private track(key: string, seq: number): void {
    let set = this.live.get(key)
    if (!set) this.live.set(key, (set = new Set()))
    set.add(seq)
  }

  private untrack(key: string, seq: number): void {
    const set = this.live.get(key)
    if (!set) return
    set.delete(seq)
    if (set.size === 0) this.live.delete(key)
  }

  /** Withdraw this incarnation's tickets on `key` that are no longer in use (see SWEEP_SCRIPT). */
  private async sweep(key: string): Promise<void> {
    const k = this.turnKeys(key)
    const kept = [...(this.live.get(key) ?? [])]
    await this.run(SWEEP_SCRIPT, [k.serving, k.owner, k.tix, k.last, k.seq], [this.incarnation, this.idleMs, ...kept])
  }

  /** Watchdog step: repair the keys where a release, cancel or reservation failed. */
  private async sweepDirty(): Promise<void> {
    for (const key of [...this.dirty]) {
      if (this.reserving.has(key)) continue        // its reply would race the sweep: next round
      this.dirty.delete(key)
      try {
        await this.sweep(key)
      } catch (error) {
        this.dirty.add(key)
        this.logger?.warn?.({ err: error, key }, 'RedisCoordinator: ticket repair failed; retrying')
      }
    }
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
    const { lease: leadKey, term: termKey } = this.keys.lead(name)
    let term: number
    try {
      term = Number(await this.run(LEAD_SCRIPT, [leadKey, termKey], [this.incarnation, this.leaseMs]))
    } catch (error) {
      throw new CoordinationUnavailableError(name, 'unavailable', { cause: error })
    }
    if (!term) {
      this.emit('follower', { name })
      return null
    }
    let held = [...this.leads].find((l) => l.name === name && l.term === term)
    if (!held) {
      held = { name, term, value: `${term}|${this.incarnation}`, leadKey, ac: new AbortController() }
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
        this.run(HEARTBEAT_SCRIPT, [this.repKey(this.incarnation)], [this.leaseMs]),
        ...turns.map((t) => this.run(RENEW_SCRIPT, [t.ownerKey], [t.value, this.leaseMs])),
        ...leads.map((l) => this.run(RENEW_SCRIPT, [l.leadKey], [l.value, this.leaseMs])),
      ])
      turns.forEach((t, i) => { if (Number(results[i + 1]) !== 1 && this.turns.has(t)) this.drop(t, 'expired', true) })
      leads.forEach((l, i) => { if (Number(results[i + 1 + turns.length]) !== 1 && this.leads.has(l)) this.dropLead(l, 'expired', true) })
      this.lastRenewOk = sentAt
      if (this.running) this.armDeadline()
      if (this.dirty.size > 0) await this.sweepDirty()
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
