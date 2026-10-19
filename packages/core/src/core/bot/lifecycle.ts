/**
 * Start / stop of one bot as an ordered list of steps, run one operation at a time.
 *
 * Start runs every step's `start()` in order; on failure the inbound gate closes and the
 * `rollback()` of every step already attempted runs in reverse order (rollback errors are
 * only logged), the connection state becomes `'closed'` and the error is rethrown.
 *
 * Stop: inbound off + broadcasts cancelled → the `stop()` of `quiesce` steps (reverse
 * order) → optional drain of in-flight sends → paced sends closed and conversations
 * aborted (checkpoints kept) → the `stop()` of the remaining steps in reverse order (the
 * first error wins and is rethrown at the end).
 *
 * Default steps (see `defaultLifecycleSteps`): `storage` → `restore` → `transport` → `jobs`.
 */
import { parseTimerDuration } from '../../utils/timers.js'
import type { BotKernel } from './kernel.js'

/** Options of `Bot.stop()`. */
export interface LifecycleStopOptions {
  drain?: boolean
  timeout?: string | number
}

export interface LifecycleStep {
  readonly name: string
  start(): Promise<void>
  /** Undo a started (or partly started) step when a LATER part of `start()` fails. Must not throw. */
  rollback?(): Promise<void>
  /** Tear down on `stop()`. May throw: the first error is rethrown once every step stopped. */
  stop?(): Promise<void>
  /** Stopped before the drain (stops producing new work), instead of after it. */
  readonly quiesce?: boolean
}

/** Today's start order: storage → restore → transport → jobs. */
export function defaultLifecycleSteps(k: BotKernel): LifecycleStep[] {
  return [
    {
      name: 'storage',
      start: () => k.store.start(),
      rollback: async () => {
        try { await k.store.stop() }
        catch (rollbackError) { k.logger.error({ err: rollbackError }, 'store start rollback failed') }
      },
      stop: () => k.store.stop(),
    },
    {
      name: 'restore',
      start: async () => {
        k.runtime.open()
        await k.runtime.loadDormant()
        await k.handoffs.load()   // never rejects: restore failures go to 'error'
        // A handed-off chat must not resume a checkpoint loadDormant() just brought back:
        // the handoff may predate start() (or have happened while stopped), or its clear
        // failed / never ran before a crash.
        for (const { chatId } of k.handoffs.list()) k.runtime.abortChat(chatId)
      },
      // No stop(): the runtime is closed by the lifecycle itself, right after the drain and
      // before the transport stops (see Lifecycle.stopOnce).
    },
    {
      name: 'transport',
      start: () => k.provider.start(),
      rollback: async () => {
        try { await k.provider.stop() }
        catch (rollbackError) { k.logger.error({ err: rollbackError }, 'provider start rollback failed') }
      },
      stop: () => k.provider.stop(),
    },
    {
      name: 'jobs',
      start: async () => { k.scheduler.start(k.logger.child({ module: 'scheduler' })) },
      rollback: async () => { k.scheduler.stop() },
      stop: async () => { k.scheduler.stop() },
      quiesce: true,
    },
  ]
}

export class Lifecycle {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly k: BotKernel, private readonly steps: LifecycleStep[]) {}

  start(): Promise<void> {
    return this.enqueue(() => this.startOnce())
  }

  stop(opts?: LifecycleStopOptions): Promise<void> {
    return this.enqueue(() => this.stopOnce(opts))
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async startOnce(): Promise<void> {
    const { state } = this.k
    if (state.isStarted) return
    const attempted: LifecycleStep[] = []
    try {
      for (const step of this.steps) {
        attempted.push(step)
        await step.start()
      }
      if (state.lifecycleAbort.signal.aborted) state.lifecycleAbort = new AbortController()
      if (state.sendsAbort.signal.aborted) state.sendsAbort = new AbortController()
      state.isStarted = true
      state.acceptingInbound = true
      state.pacedSendsOpen = true
      this.k.counters.markStarted()
      this.k.events.emit('started')
    } catch (error) {
      state.acceptingInbound = false
      // The last step first: `jobs` (scheduler.stop) is undone whenever it was reached.
      const undo = [...attempted].reverse()
      // Steps that were never reached but still have to be quiesced (e.g. a scheduler
      // that must never run while the bot failed to start) are rolled back as well.
      for (const step of this.steps) if (step.quiesce && !attempted.includes(step)) undo.unshift(step)
      for (const step of undo) if (step.rollback) await step.rollback()
      state.connState = 'closed'
      throw error
    }
  }

  private async stopOnce(opts?: LifecycleStopOptions): Promise<void> {
    const { state } = this.k
    // Validate before tearing anything down, so a bad duration leaves the bot running.
    const drainTimeout = parseTimerDuration(opts?.timeout ?? 10_000, 'stop() timeout')
    if (!state.isStarted) return
    state.acceptingInbound = false
    // Running broadcasts start no new send from here on; their in-flight sends are
    // in `inflightSends`, so `drain` still waits for them.
    state.lifecycleAbort.abort()
    const reversed = [...this.steps].reverse()
    let stopError: unknown
    const stopStep = async (step: LifecycleStep) => {
      if (!step.stop) return
      try { await step.stop() }
      catch (error) { stopError ??= error }
    }
    for (const step of reversed) if (step.quiesce) await stopStep(step)
    const inflight = this.k.inflightSends
    if (opts?.drain && inflight.size > 0) {
      const timeout = drainTimeout
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, timeout) }),
        ])
      } finally {
        // Drained before the deadline: the deadline timer must not keep the process alive.
        if (timer) clearTimeout(timer)
      }
    }
    state.pacedSendsOpen = false
    state.sendsAbort.abort()
    // Abort every conversation (checkpoints kept) and refuse new ones until start().
    this.k.runtime.close()
    for (const step of reversed) if (!step.quiesce) await stopStep(step)
    state.isStarted = false
    state.connState = 'closed'
    this.k.counters.markStopped()
    this.k.events.emit('stopped')
    if (stopError) throw stopError
  }
}
