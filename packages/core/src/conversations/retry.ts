/**
 * `c.retry()` support — wait book-keeping, flow rewinds and their control signal.
 *
 * Every wait made through the conversation controls (`ask`, `waitText`, `waitMedia`,
 * `choose`, `waitAny`) is recorded by a per-controls {@link WaitTracker}, so `c.retry()`
 * can re-run "the most recent wait" with its original options and retry budget:
 *
 * - **In place** (async `bot.conversation()` handlers, or a wait made inside the current
 *   `flow().do()` step): `await c.retry(message?)` re-sends the prompt — or `message`
 *   instead — waits again and resolves with the new value.
 * - **Rewind** (inside a flow step whose most recent wait belonged to an EARLIER step,
 *   e.g. `.ask(…).do((ctx, c) => c.retry('…'))`): `c.retry()` throws a
 *   {@link ConversationRetry} signal; the interpreter replays the flow from the step that
 *   owns that wait, so the `.do()` runs again on the fresh answer.
 *
 * Manual retries share the wait's `retries` budget with `validate` failures.
 */

import type { CompiledFlow } from '../flows/FlowBuilder.js'
import { ConversationError, RetriesExceeded } from './errors.js'

/** Default invalid-answer budget of a wait (`WaitOptions.retries`). */
export const DEFAULT_RETRIES = 3

/**
 * Control signal thrown by `c.retry()` inside a flow step (`flow().do()`, a `.choose()`
 * `then` action) when the retried wait belongs to an earlier step. The flow interpreter
 * catches it and replays the flow from that step; code after `c.retry()` in the step does
 * not run (like `c.end()` / `c.goto()`). If you wrap a step body in `try/catch`, rethrow
 * every {@link ConversationError}.
 */
export class ConversationRetry extends ConversationError {
  /**
   * @param prompt  Message sent instead of the step's prompt when it is re-run (undefined: re-send the prompt).
   * @param flow    Flow that owns the target step (internal).
   * @param index   Step index the flow rewinds to (internal).
   * @param attempts Invalid attempts carried into the re-run wait (internal).
   */
  constructor(
    readonly prompt: string | undefined,
    readonly flow: object,
    readonly index: number,
    readonly attempts: number,
  ) {
    super('conversation retry')
  }
}

/**
 * `c.retry()` had nothing to re-run: no wait happened yet in this conversation (or, in a
 * flow, no earlier `.ask()`/`.choose()` step exists). It is a programming error — the
 * conversation ends through the error path (`onError` / bot `'error'` event + `errorMessage`).
 */
export class RetryUnavailableError extends ConversationError {
  constructor() {
    super('c.retry() needs a previous wait (ask/waitText/waitMedia/choose/waitAny) to re-run')
  }
}

/** One accepted-or-rejected inbound message, as judged by a wait. */
export type WaitVerdict<T> = { ok: true; value: T } | { ok: false; message: string }

/** A flow step execution phase, as marked by the interpreter. */
interface StepRef { readonly flow: CompiledFlow; readonly index: number; readonly phase: number }

/** Book-keeping for one wait so `c.retry()` can re-run it. */
interface WaitRecord {
  readonly retries: number
  /** Invalid attempts so far: rejected answers + manual retries. */
  attempts: number
  readonly step?: StepRef
  /** Text to (re-)send before waiting, given an optional retry message. */
  readonly promptFor: (message?: string) => string | undefined
  /** The wait loop; re-invoked by an in-place retry (attempts carried). */
  readonly loop: () => Promise<unknown>
  /** Promise of the loop run currently in flight (the conversation is parked on it). */
  inFlight?: Promise<unknown>
}

/** Collaborators of the tracker (bound to one conversation by the controls factory). */
export interface WaitTrackerDeps {
  assertAlive(): void
  reply(text: string): Promise<unknown>
}

/** Rewind carried from a caught {@link ConversationRetry} into the target step's first wait. */
interface Rewind { readonly flow: CompiledFlow; readonly index: number; readonly prompt?: string; readonly attempts: number }

/** Per-conversation wait tracker behind `c.retry()`. Internal — created by `createControls`. */
export class WaitTracker {
  private last?: WaitRecord
  private current?: StepRef
  private phase = 0
  private rewind?: Rewind
  private frames: CompiledFlow[] = []

  constructor(private deps: WaitTrackerDeps) {}

  /** Interpreter hook: a flow step (or a new phase of it, e.g. a choose's `then`) starts. */
  mark(flow: CompiledFlow, index: number): void {
    this.current = { flow, index, phase: ++this.phase }
    // A carried rewind is only valid for the step it targets.
    if (this.rewind && (this.rewind.flow !== flow || this.rewind.index !== index)) this.rewind = undefined
  }

  /** Interpreter hook: a flow frame is running (rewinds may target it). Returns the pop. */
  enter(flow: CompiledFlow): () => void {
    this.frames.push(flow)
    return () => {
      const i = this.frames.lastIndexOf(flow)
      if (i >= 0) this.frames.splice(i, 1)
    }
  }

  /** Interpreter hook: a rewind signal was caught; the target step's first wait consumes it. */
  arm(signal: ConversationRetry): void {
    this.rewind = { flow: signal.flow as CompiledFlow, index: signal.index, prompt: signal.prompt, attempts: signal.attempts }
  }

  /**
   * Run one tracked wait: send its prompt (or a carried rewind's message instead), then loop
   * `next()` until a message is accepted. Rejections count against `retries`; each rejection
   * message is sent before waiting again.
   */
  async wait<T>(retries: number, promptFor: (message?: string) => string | undefined, next: () => Promise<WaitVerdict<T>>): Promise<T> {
    this.deps.assertAlive()
    const rewind = this.takeRewind()
    const text = promptFor(rewind?.prompt)
    if (text) await this.deps.reply(text)
    const rec: WaitRecord = {
      retries,
      attempts: rewind?.attempts ?? 0,
      step: this.current,
      promptFor,
      loop: async () => {
        for (;;) {
          const r = await next()
          if (r.ok) return r.value
          rec.attempts++
          if (rec.attempts >= rec.retries) throw new RetriesExceeded()
          await this.deps.reply(r.message)
        }
      },
    }
    this.last = rec
    return this.run(rec) as Promise<T>
  }

  /** `c.retry()` — see the module docs for the in-place vs rewind semantics. */
  retry<T>(message: string | undefined): Promise<T> {
    // Rewind: a SYNCHRONOUS throw, so `c.retry()` works un-awaited inside a step body.
    if (this.shouldRewind()) throw this.rewindSignal(message)
    const rec = this.last
    const p = (async () => {
      if (!rec) throw new RetryUnavailableError()
      this.deps.assertAlive()
      rec.attempts++
      if (rec.attempts >= rec.retries) throw new RetriesExceeded()
      const text = rec.promptFor(message)
      if (text) await this.deps.reply(text)
      // Still pending (e.g. called from an idle callback): the re-prompt joins that wait.
      return rec.inFlight ?? this.run(rec)
    })() as Promise<T>
    p.catch(() => {})   // never an unhandled rejection when the caller forgets to await
    return p
  }

  private run(rec: WaitRecord): Promise<unknown> {
    const p = rec.loop()
    rec.inFlight = p
    const settle = () => { if (rec.inFlight === p) rec.inFlight = undefined }
    p.then(settle, settle)
    return p
  }

  private takeRewind(): Rewind | undefined {
    const r = this.rewind
    const cur = this.current
    if (!r || !cur || r.flow !== cur.flow || r.index !== cur.index) return undefined
    this.rewind = undefined
    return r
  }

  private shouldRewind(): boolean {
    const cur = this.current
    if (!cur) return false                    // async conversation: no steps → in place
    const rec = this.last
    if (rec?.inFlight) return false           // a wait is pending (idle callback) → join it
    return !rec?.step || rec.step.phase !== cur.phase
  }

  private rewindSignal(message: string | undefined): Error {
    const cur = this.current!
    const rec = this.last
    if (rec?.step && this.frames.includes(rec.step.flow)) {
      const attempts = rec.attempts + 1
      if (attempts >= rec.retries) return new RetriesExceeded()
      return new ConversationRetry(message, rec.step.flow, rec.step.index, attempts)
    }
    // No usable record (e.g. a persistent flow resumed after a restart, or the wait lived in a
    // sub-flow that already returned): rewind to the nearest earlier prompt step of this flow.
    for (let i = cur.index; i >= 0; i--) {
      const step = cur.flow.steps[i]
      if (step.kind !== 'ask' && step.kind !== 'choose') continue
      const retries = step.opts?.retries ?? DEFAULT_RETRIES
      if (1 >= retries) return new RetriesExceeded()
      return new ConversationRetry(message, cur.flow, i, 1)
    }
    return new RetryUnavailableError()
  }
}

/* ---------------------------------------------------------------------------
 * Wiring between the controls object and the flow interpreter.
 * ------------------------------------------------------------------------ */

const trackers = new WeakMap<object, WaitTracker>()

/** Associate a controls object with its tracker (called by `createControls`). */
export function bindTracker(controls: object, tracker: WaitTracker): void {
  trackers.set(controls, tracker)
}

/** Interpreter hook: step `index` of `flow` (or a new phase of it) starts. No-op for foreign controls. */
export function markStep(controls: object, flow: CompiledFlow, index: number): void {
  trackers.get(controls)?.mark(flow, index)
}

/**
 * Run a flow from `startAt`, replaying it from the target step whenever a step throws a
 * {@link ConversationRetry} aimed at THIS flow. Signals for an outer flow (a sub-flow
 * retrying its parent's wait) and every other error propagate unchanged.
 */
export async function replayable(
  controls: object,
  flow: CompiledFlow,
  startAt: number,
  run: (from: number) => Promise<void>,
): Promise<void> {
  const tracker = trackers.get(controls)
  const leave = tracker?.enter(flow)
  try {
    for (let from = startAt; ;) {
      try {
        await run(from)
        return
      } catch (e) {
        if (!(e instanceof ConversationRetry) || e.flow !== flow) throw e
        tracker?.arm(e)
        from = e.index
      }
    }
  } finally {
    leave?.()
  }
}
