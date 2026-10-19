/**
 * ChatTurnGate — the Dispatcher's seam to a {@link Coordinator} (internal).
 *
 * For every job the Dispatcher queues it reserves a ticket synchronously, in arrival
 * order (reservations of one key are chained so they reach the backend in that order),
 * and returns a runner the Dispatcher calls when the job's local turn comes. The runner
 * waits for the cross-replica turn, refreshes stale local state when another replica
 * held the key last, runs the job, keeps the turn until the conversation it fed has
 * settled, and releases it.
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
  /** Max time a turn stays held after the job, waiting for {@link settle}. */
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
}

/** A scheduled job's runner: rejects (job not run) when the turn could not be had. */
export type TurnRunner = (job: () => Promise<void>) => Promise<void>

export class ChatTurnGate {
  /** Tail of the reservation chain per key (keeps backend reservations in arrival order). */
  private reservations = new Map<string, Promise<unknown>>()
  /** Keys whose last turn on this replica was lost and not re-acquired since. */
  private lostKeys = new Map<string, LeaseLostError>()

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
        await this.settled(key, turn)
      } finally {
        turn.signal.removeEventListener('abort', onLost)
        await turn.release().catch(() => {})
      }
    }
  }

  /**
   * Throw when work for `key` must not reach the transport: this replica's turn on it
   * was lost and not re-acquired since. `undefined` (no chat context) never throws.
   */
  assertHeld(key: string | undefined): void {
    if (key === undefined) return
    const lost = this.lostKeys.get(key)
    if (lost) throw lost
  }

  private async settled(key: string, turn: ChatTurn): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        this.deps.settle(key),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.deps.settleMs) }),
        new Promise<void>((resolve) => { onAbort = resolve; turn.signal.addEventListener('abort', onAbort, { once: true }) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) turn.signal.removeEventListener('abort', onAbort)
    }
  }
}
