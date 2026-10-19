/**
 * Causation context (internal) — which inbound event (or job) the code currently
 * running is handling, carried across awaits with AsyncLocalStorage.
 *
 * It gives durable sends deterministic idempotency keys: the n-th send made while
 * handling inbound record `id` is keyed `${id}:${n}`, so replaying that record after
 * a crash re-derives the same keys and the outbox recognises the sends that already
 * went out. It also collects the "settled" promises of the conversations the event
 * started or fed, so the inbox acknowledges the event only once its effects landed.
 *
 * Nothing here is active unless durability is on: without a cause every helper is a
 * cheap no-op, so the default code path is unchanged.
 *
 * Conversations: ALS follows the awaiter, not the resolver — a conversation started by
 * message 1 keeps seeing message 1's context after `c.ask()` is answered by message 2.
 * So each conversation runs in its own mutable {@link CauseBox} ({@link forkCause}),
 * and delivering message N to it re-points the box at message N's cause
 * ({@link adoptCause}).
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** How a conversation step settled: reached its next wait / ended, or was torn down by `stop()`. */
export type SettleOutcome = 'settled' | 'aborted'

/** The conversation steps one handled event started or fed (shared by every ref of that event). */
export interface SettleTracker {
  /** Steps not settled yet. */
  readonly pending: Set<Promise<SettleOutcome>>
  /** Set once any of them was torn down by `stop()` instead of settling. */
  aborted: boolean
}

/** One inbound event (or job) being handled. Shared by every box that points at it. */
export interface CauseRef {
  readonly id: string
  /** Next send sequence number. */
  seq: number
  /** True while replaying a journaled record (restart recovery, background retry). */
  readonly replay: boolean
  readonly settles: SettleTracker
}

/** A mutable pointer at the cause the current async chain works for. */
export interface CauseBox { ref: CauseRef }

const als = new AsyncLocalStorage<CauseBox>()

/** Run `fn` while handling `id`; sends made inside get keys `${id}:0`, `${id}:1`, … */
export function runWithCause<T>(id: string, fn: () => T, opts: { replay?: boolean } = {}): { ref: CauseRef; result: T } {
  const ref: CauseRef = { id, seq: 0, replay: opts.replay === true, settles: { pending: new Set(), aborted: false } }
  return { ref, result: als.run({ ref }, fn) }
}

/** The cause of the current async chain, if any. */
export function currentCause(): CauseRef | undefined { return als.getStore()?.ref }

/** The next deterministic send key of the current cause, or `undefined` outside one. */
export function nextSendKey(): string | undefined {
  const ref = als.getStore()?.ref
  if (!ref) return undefined
  return `${ref.id}:${ref.seq++}`
}

/**
 * Run `fn` in a box of its own pointing at the current cause (a conversation). Returns the
 * box so later deliveries can re-point it. Outside a cause, `fn` runs as-is and the box is `undefined`.
 */
export function forkCause<T>(fn: () => T): { box: CauseBox | undefined; result: T } {
  const current = als.getStore()
  if (!current) return { box: undefined, result: fn() }
  const box: CauseBox = { ref: current.ref }
  return { box, result: als.run(box, fn) }
}

/** Re-point `box` (a conversation's) at the cause of the current async chain (the message delivered to it). */
export function adoptCause(box: CauseBox | undefined): void {
  const ref = als.getStore()?.ref
  if (box && ref) box.ref = ref
}

/** Track a conversation step under the current cause; no-op outside one. */
export function trackSettle(settled: Promise<SettleOutcome>): void {
  const tracker = als.getStore()?.ref.settles
  if (!tracker) return
  tracker.pending.add(settled)
  void settled.then((outcome) => {
    if (outcome === 'aborted') tracker.aborted = true
    tracker.pending.delete(settled)
  }, () => tracker.pending.delete(settled))
}

/**
 * Point the current box at a cause recorded earlier (a checkpoint's `cause`), so a step
 * re-run on replay derives the same send keys as its first run and the outbox
 * recognises the sends that already went out. Settles still go to the current event.
 */
export function restoreCause(cause: { id: string; seq: number }): void {
  const box = als.getStore()
  if (!box) return
  box.ref = { id: cause.id, seq: cause.seq, replay: true, settles: box.ref.settles }
}

/** True when a cause is active (lets callers skip allocating a settle promise otherwise). */
export function hasCause(): boolean { return als.getStore() !== undefined }

/**
 * Wait until every step tracked on `ref` settled — including steps tracked while waiting
 * (a `c.goto()` target). Resolves `'aborted'` when any was torn down by `stop()`.
 */
export async function settled(ref: CauseRef): Promise<SettleOutcome> {
  const tracker = ref.settles
  for (;;) {
    const pending = [...tracker.pending]
    if (pending.length === 0) {
      // A goto target registers on the tick after its predecessor settled.
      await new Promise<void>((r) => setImmediate(r))
      if (tracker.pending.size === 0) return tracker.aborted ? 'aborted' : 'settled'
      continue
    }
    await Promise.all(pending.map((p) => p.catch(() => undefined)))
    // trackSettle's own continuation (which records 'aborted') runs before this one.
    await Promise.resolve()
  }
}
