/**
 * ChatTurnGate — the Dispatcher's seam to a {@link Coordinator} (internal).
 *
 * For every job the Dispatcher queues it reserves a ticket synchronously, in arrival
 * order (reservations of one key are chained so they reach the backend in that order),
 * and returns a runner the Dispatcher calls when the job's local turn comes. The runner
 * waits for the cross-replica turn, refreshes stale local state when another replica
 * held the key last, runs the job, keeps the turn until the conversation it fed has
 * settled, and releases it. A conversation still running a step after `settleMs` is
 * suspended (checkpoint kept) and fenced before the turn is released, so it can never
 * run alongside the replica that takes the chat next.
 */
import {
  CoordinationUnavailableError,
  LeaseLostError,
  type ChatTurn,
  type Coordinator,
  type Ticket,
} from './types.js'

export interface ChatTurnGateDeps {
  coordinator: Coordinator
  /** Max wait for a turn (ms). */
  turnWaitMs: number
  /** Max time a turn stays held after the job, waiting for {@link settle}; then {@link expire} runs. */
  settleMs: number
  /**
   * Another replica held `key` last: drop local in-memory state for it (an active
   * conversation is aborted with its checkpoint kept) and re-read the checkpoint.
   */
  refresh: (key: string) => Promise<void>
  /** The key's turn was lost mid-work: abort local work for it (checkpoint kept). */
  lost: (key: string, error: LeaseLostError) => void
  /** Resolves when the key's conversation (if any) is waiting for input or has ended. */
  settle: (key: string) => Promise<void>
  /**
   * The key's conversation did not settle within `settleMs`: stop it (checkpoint kept, so
   * the next message resumes it from its last completed step) before the turn is released.
   */
  expire: (key: string) => Promise<void>
}

/** A scheduled job's runner: rejects (job not run) when the turn could not be had. */
export type TurnRunner = (job: () => Promise<void>) => Promise<void>

export class ChatTurnGate {
  /** Tail of the reservation chain per key (keeps backend reservations in arrival order). */
  private reservations = new Map<string, Promise<unknown>>()
  /** Keys whose last turn on this replica was lost and not re-acquired since. */
  private lostKeys = new Map<string, LeaseLostError>()
  /** Turns this replica currently holds, by key. */
  private held = new Map<string, ChatTurn>()

  constructor(private deps: ChatTurnGateDeps) {}

  /** Reserve now (arrival order) and return the runner for when the job's local turn comes. */
  schedule(key: string): TurnRunner {
    const { coordinator } = this.deps
    const previous = this.reservations.get(key) ?? Promise.resolve()
    const ticketP: Promise<Ticket> = previous.then(() => coordinator.reserve(key), () => coordinator.reserve(key))
    const tail = ticketP.catch(() => undefined)
    this.reservations.set(key, tail)
    void tail.finally(() => { if (this.reservations.get(key) === tail) this.reservations.delete(key) })

    return async (job) => {
      let ticket: Ticket
      try {
        ticket = await ticketP
      } catch (error) {
        throw new CoordinationUnavailableError(key, 'unavailable', { cause: error })
      }
      let turn: ChatTurn
      try {
        turn = await coordinator.acquireTurn(ticket, { maxWaitMs: this.deps.turnWaitMs })
      } catch (error) {
        void ticket.cancel().catch(() => {})
        if (error instanceof LeaseLostError || error instanceof CoordinationUnavailableError) throw error
        throw new CoordinationUnavailableError(key, 'unavailable', { cause: error })
      }
      this.lostKeys.delete(key)
      this.held.set(key, turn)
      const onLost = () => {
        const reason = turn.signal.reason
        const error = reason instanceof LeaseLostError ? reason : new LeaseLostError(key, turn.fence, 'expired')
        this.lostKeys.set(key, error)
        this.deps.lost(key, error)
      }
      turn.signal.addEventListener('abort', onLost, { once: true })
      if (turn.signal.aborted) onLost()
      try {
        if (turn.previousHolder !== coordinator.replicaId) await this.deps.refresh(key)
        turn.assertHeld()
        await job()
        if (await this.settled(key, turn) === 'timeout') {
          // Anything the cut-short step still tries to send is refused from now on.
          this.lostKeys.set(key, new LeaseLostError(key, turn.fence, 'expired'))
          await this.deps.expire(key)
        }
      } finally {
        turn.signal.removeEventListener('abort', onLost)
        if (this.held.get(key) === turn) this.held.delete(key)
        await turn.release().catch(() => {})
      }
    }
  }

  /**
   * A compare-and-set checkpoint write for `key` was refused: another replica wrote the
   * key since this one's turn was granted, so the turn is as good as lost. Recorded like a
   * lost turn (later sends for the key reject through {@link assertHeld}) and the local
   * work for the key is aborted with its checkpoint kept. No-op while nothing is held.
   */
  markLost(key: string): void {
    if (this.lostKeys.has(key)) return
    const error = new LeaseLostError(key, this.held.get(key)?.fence ?? 0, 'superseded')
    this.lostKeys.set(key, error)
    this.deps.lost(key, error)
  }

  /** The fence of the turn this replica holds on `key`, if any. */
  fenceOf(key: string): number | undefined {
    return this.held.get(key)?.fence
  }

  /**
   * Throw when work for `key` must not reach the transport: this replica's turn on it
   * was lost and not re-acquired since. `undefined` (no chat context) never throws.
   */
  assertHeld(key: string | undefined): void {
    if (key === undefined) return
    const lost = this.lostKeys.get(key)
    if (lost) throw lost
    this.held.get(key)?.assertHeld()
  }

  private async settled(key: string, turn: ChatTurn): Promise<'settled' | 'timeout' | 'lost'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    if (turn.signal.aborted) return 'lost'
    try {
      return await Promise.race([
        this.deps.settle(key).then(() => 'settled' as const),
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), this.deps.settleMs) }),
        new Promise<'lost'>((resolve) => { onAbort = () => resolve('lost'); turn.signal.addEventListener('abort', onAbort, { once: true }) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) turn.signal.removeEventListener('abort', onAbort)
    }
  }
}
