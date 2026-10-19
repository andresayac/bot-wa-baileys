/**
 * In-process {@link Coordinator}: the reference implementation of the contract.
 *
 * Replicas that share one {@link MemoryCoordinationHub} (several `Bot`s in one process,
 * typically tests) coordinate exactly like replicas sharing a Redis: per-key FIFO turns,
 * exclusive holders, leadership terms. Without a hub each coordinator gets its own, which
 * is a single-replica cluster. {@link MemoryCoordinator.crash} simulates a replica dying:
 * its tickets are skipped, its turns and leaderships freed, its signals aborted.
 */
import { randomUUID } from 'node:crypto'
import {
  CoordinationUnavailableError,
  LeaseLostError,
  type AcquireTurnOptions,
  type ChatTurn,
  type Coordinator,
  type CoordinatorEvents,
  type Fence,
  type Leadership,
  type LeaseLossReason,
  type Ticket,
} from './types.js'

interface KeyState {
  seq: number
  serving: number
  /** Reserved, not yet released tickets: seq → replica id. */
  tickets: Map<number, string>
  owner?: { seq: number; replica: string }
  last: string | null
}

interface LeadState {
  term: number
  holder?: string
}

/** Internal state of a {@link MemoryCoordinationHub}, kept off the public class. */
class HubState {
  readonly keys = new Map<string, KeyState>()
  readonly leads = new Map<string, LeadState>()
  readonly alive = new Set<string>()
  private waiters = new Set<() => void>()
  /** Bumped by every {@link notify}; lets a waiter detect a change it raced with. */
  version = 0

  /** Wake every waiter (a turn was released, a replica died, a leadership freed). */
  notify(): void {
    this.version++
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const w of waiters) w()
  }

  /** Resolve on the next {@link notify} (at once when one happened since version `since`). */
  changed(since: number): Promise<void> {
    if (this.version !== since) return Promise.resolve()
    return new Promise((resolve) => { this.waiters.add(resolve) })
  }

  state(key: string): KeyState {
    let s = this.keys.get(key)
    if (!s) {
      s = { seq: 0, serving: 1, tickets: new Map(), last: null }
      this.keys.set(key, s)
    }
    return s
  }
}

const hubStates = new WeakMap<MemoryCoordinationHub, HubState>()

/**
 * Shared state of the replicas of one in-process cluster: pass the same hub to every
 * {@link MemoryCoordinator} that should coordinate with the others.
 */
export class MemoryCoordinationHub {
  constructor() { hubStates.set(this, new HubState()) }
}

export interface MemoryCoordinatorOptions {
  /** Share state with other replicas of this process. Default: a private hub. */
  hub?: MemoryCoordinationHub
  /** This replica's id. Default: a random UUID. */
  replicaId?: string
}

type Listener = (payload: never) => void

export class MemoryCoordinator implements Coordinator {
  readonly replicaId: string
  private readonly hub: HubState
  private readonly turns = new Set<{ key: string; seq: number; ac: AbortController }>()
  private readonly leaderships = new Set<{ name: string; term: number; ac: AbortController }>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private running = false

  constructor(opts: MemoryCoordinatorOptions = {}) {
    this.hub = hubStates.get(opts.hub ?? new MemoryCoordinationHub())!
    this.replicaId = opts.replicaId ?? randomUUID()
  }

  async start(): Promise<void> {
    this.running = true
    this.hub.alive.add(this.replicaId)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    for (const t of [...this.turns]) this.releaseTurn(t.key, t.seq)
    for (const l of [...this.leaderships]) this.releaseLead(l.name, l.term, 'stopped')
    for (const s of this.hub.keys.values()) {
      for (const [seq, rid] of s.tickets) if (rid === this.replicaId && seq !== s.owner?.seq) s.tickets.delete(seq)
    }
    this.hub.alive.delete(this.replicaId)
    this.hub.notify()
  }

  /**
   * Simulate this replica dying without cleaning up: it stops counting as alive, so its
   * tickets are skipped and its turns and leaderships are handed over, and every signal
   * it holds aborts with `'expired'` (what its watchdog would do once the lease lapsed).
   */
  crash(): void {
    this.running = false
    this.hub.alive.delete(this.replicaId)
    for (const t of [...this.turns]) {
      this.turns.delete(t)
      t.ac.abort(new LeaseLostError(t.key, t.seq, 'expired'))
      this.emit('lease-lost', { key: t.key, holder: this.replicaId, fence: t.seq, reason: 'expired' })
    }
    for (const l of [...this.leaderships]) {
      this.leaderships.delete(l)
      const state = this.hub.leads.get(l.name)
      if (state?.holder === this.replicaId) state.holder = undefined
      l.ac.abort(new LeaseLostError(l.name, l.term, 'expired'))
    }
    this.hub.notify()
  }

  async reserve(key: string): Promise<Ticket> {
    this.assertRunning(key)
    const s = this.hub.state(key)
    const seq = ++s.seq
    s.tickets.set(seq, this.replicaId)
    return {
      key,
      seq,
      cancel: async () => { this.cancelTicket(key, seq) },
    }
  }

  async acquireTurn(ticket: Ticket, opts: AcquireTurnOptions = {}): Promise<ChatTurn> {
    const deadline = opts.maxWaitMs !== undefined ? Date.now() + opts.maxWaitMs : undefined
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason
      if (!this.running) throw new LeaseLostError(ticket.key, ticket.seq, 'stopped')
      const since = this.hub.version
      const s = this.hub.state(ticket.key)
      this.skipDead(s)
      if (s.serving > ticket.seq || s.tickets.get(ticket.seq) !== this.replicaId) {
        throw new LeaseLostError(ticket.key, ticket.seq, 'superseded')
      }
      if (s.serving === ticket.seq && !s.owner) {
        s.owner = { seq: ticket.seq, replica: this.replicaId }
        return this.grant(ticket.key, ticket.seq, s.last)
      }
      const remaining = deadline !== undefined ? deadline - Date.now() : undefined
      if (remaining !== undefined && remaining <= 0) {
        this.cancelTicket(ticket.key, ticket.seq)
        throw new CoordinationUnavailableError(ticket.key, 'timeout')
      }
      await this.waitChange(since, remaining, opts.signal)
    }
  }

  async lead(name: string, opts: { signal?: AbortSignal } = {}): Promise<Leadership> {
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason
      const since = this.hub.version
      const won = await this.tryLead(name)
      if (won) return won
      await this.waitChange(since, undefined, opts.signal)
    }
  }

  async tryLead(name: string): Promise<Leadership | null> {
    this.assertRunning(name)
    let state = this.hub.leads.get(name)
    if (!state) {
      state = { term: 0 }
      this.hub.leads.set(name, state)
    }
    if (state.holder !== undefined && state.holder !== this.replicaId && this.hub.alive.has(state.holder)) {
      this.emit('follower', { name })
      return null
    }
    if (state.holder === this.replicaId) {
      const held = [...this.leaderships].find((l) => l.name === name && l.term === state!.term)
      if (held) return this.leadershipOf(held)
    }
    state.term++
    state.holder = this.replicaId
    const entry = { name, term: state.term, ac: new AbortController() }
    this.leaderships.add(entry)
    this.emit('leader', { name, fence: entry.term })
    return this.leadershipOf(entry)
  }

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

  private assertRunning(key: string): void {
    if (!this.running) throw new CoordinationUnavailableError(key, 'unavailable', { cause: new Error('coordinator not started') })
  }

  /** Advance `serving` past tickets that were cancelled or belong to replicas that died. */
  private skipDead(s: KeyState): void {
    while (s.serving <= s.seq) {
      const holder = s.tickets.get(s.serving)
      if (holder !== undefined && this.hub.alive.has(holder)) return
      if (s.owner?.seq === s.serving) {
        if (this.hub.alive.has(s.owner.replica)) return
        s.owner = undefined
      }
      s.tickets.delete(s.serving)
      s.serving++
    }
  }

  private cancelTicket(key: string, seq: number): void {
    const s = this.hub.keys.get(key)
    if (!s || s.tickets.get(seq) !== this.replicaId) return
    if (s.owner?.seq === seq) return // a granted turn is released, not cancelled
    s.tickets.delete(seq)
    this.hub.notify()
  }

  private releaseTurn(key: string, seq: number): void {
    for (const t of this.turns) if (t.key === key && t.seq === seq) this.turns.delete(t)
    const s = this.hub.keys.get(key)
    if (!s || s.owner?.seq !== seq || s.owner.replica !== this.replicaId) return
    s.owner = undefined
    s.tickets.delete(seq)
    s.last = this.replicaId
    if (s.serving === seq) s.serving++
    this.hub.notify()
  }

  private releaseLead(name: string, term: number, reason?: LeaseLossReason): void {
    for (const l of this.leaderships) {
      if (l.name !== name || l.term !== term) continue
      this.leaderships.delete(l)
      if (reason) l.ac.abort(new LeaseLostError(name, term, reason))
    }
    const state = this.hub.leads.get(name)
    if (state?.holder === this.replicaId && state.term === term) state.holder = undefined
    this.hub.notify()
  }

  private grant(key: string, seq: Fence, previousHolder: string | null): ChatTurn {
    const entry = { key, seq, ac: new AbortController() }
    this.turns.add(entry)
    const signal = entry.ac.signal
    return {
      key,
      fence: seq,
      previousHolder,
      signal,
      assertHeld: () => { if (signal.aborted) throw signal.reason },
      release: async () => { this.releaseTurn(key, seq) },
    }
  }

  private leadershipOf(entry: { name: string; term: number; ac: AbortController }): Leadership {
    return {
      name: entry.name,
      fence: entry.term,
      signal: entry.ac.signal,
      release: async () => { this.releaseLead(entry.name, entry.term) },
    }
  }

  private async waitChange(since: number, maxMs: number | undefined, signal?: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const waits: Array<Promise<void>> = [this.hub.changed(since)]
    if (maxMs !== undefined) waits.push(new Promise((resolve) => { timer = setTimeout(resolve, maxMs) }))
    if (signal) waits.push(new Promise((resolve) => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }) }))
    try {
      await Promise.race(waits)
    } finally {
      if (timer) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}
