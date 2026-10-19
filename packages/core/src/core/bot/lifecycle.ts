/**
 * Start / stop of one bot as an ordered list of steps, run one operation at a time.
 *
 * Start runs every step's `start()` in order; on failure the inbound gate closes and the
 * `rollback()` of every step already attempted runs in reverse order, preceded by the
 * `rollback()` of never-reached steps that opted in with `alwaysRollback`. Each rollback is
 * isolated: a throwing one is logged and the rest still run. The connection state becomes
 * `'closed'` and the original start error is rethrown.
 *
 * Stop: inbound off + broadcasts cancelled → the `stop()` of `quiesce` steps and the
 * `pause()` of the others (reverse order) → optional drain of in-flight sends → paced sends closed and conversations
 * aborted (checkpoints kept) → the `stop()` of the remaining steps in reverse order (the
 * first error wins and is rethrown at the end).
 *
 * Default steps (see `defaultLifecycleSteps`): `storage` → (`coordination`, only with
 * `BotConfig.coordination`) → `restore` → (`durability`, only with `BotConfig.durability`)
 * → `transport` → `jobs`. A started bot runs every step's `afterStart()` before `'started'`.
 */
import { parseTimerDuration } from '../../utils/timers.js'
import type { BotCoordination } from '../../coordination/botCoordination.js'
import type { DurableEngine } from '../../durability/bind.js'
import type { BotKernel } from './kernel.js'

/** Options of `Bot.stop()`. */
export interface LifecycleStopOptions {
  drain?: boolean
  timeout?: string | number
}

export interface LifecycleStep {
  readonly name: string
  start(): Promise<void>
  /**
   * Undo a started (or partly started) step when `start()` fails. Should not throw; if it
   * does, the error is logged and the remaining rollbacks still run.
   */
  rollback?(): Promise<void>
  /**
   * Also run `rollback()` on a failed start when this step's `start()` was never reached.
   * Only for idempotent rollbacks that are safe without a prior start (e.g. stopping a
   * scheduler); never for steps that release something they acquire (leases, fencing).
   */
  readonly alwaysRollback?: boolean
  /** Tear down on `stop()`. May throw: the first error is rethrown once every step stopped. */
  stop?(): Promise<void>
  /** Stopped before the drain (stops producing new work), instead of after it. */
  readonly quiesce?: boolean
  /**
   * Runs once every step started and the bot accepts inbound (state flags set), right
   * before `'started'` is emitted. Synchronous; must not throw.
   */
  afterStart?(): void
  /**
   * For a non-`quiesce` step: stop producing new work before the drain (called in the
   * quiesce phase, in reverse step order); its `stop()` still runs after the drain.
   * Synchronous; must not throw.
   */
  pause?(): void
}

/** Start order: storage → [coordination] → restore → [durability] → transport → jobs (bracketed: opt-in). */
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
    // Multi-replica coordination (`BotConfig.coordination`) only: the coordinator starts
    // right after the store and stops right before it (after the transport).
    ...(k.coordination ? [coordinationStep(k.coordination, k)] : []),
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
    // Durable inbox/outbox (`BotConfig.durability`) only: recovers unfinished records once
    // the conversations are restored, before the transport delivers new events.
    ...(k.durable ? [durabilityStep(k.durable, k)] : []),
    {
      name: 'transport',
      // With coordination, the transport is started only on the elected replica (or shared).
      start: () => (k.coordination ? k.coordination.startProvider() : k.provider.start()),
      rollback: async () => {
        try { await (k.coordination ? k.coordination.stopProvider() : k.provider.stop()) }
        catch (rollbackError) { k.logger.error({ err: rollbackError }, 'provider start rollback failed') }
      },
      stop: () => (k.coordination ? k.coordination.stopProvider() : k.provider.stop()),
    },
    {
      name: 'jobs',
      start: async () => {
        const restoring = k.scheduler.start(k.logger.child({ module: 'scheduler' }))
        if (restoring) await restoring   // only with durable tasks: restores their schedules
      },
      // stop() returns a promise only with a scheduler lease (never rejects): it is released
      // before the store (and the coordinator) close.
      rollback: async () => { await k.scheduler.stop() },
      stop: async () => { await k.scheduler.stop() },
      quiesce: true,
      // Keeps the old unconditional scheduler.stop() on a failed start (idempotent).
      alwaysRollback: true,
    },
  ]
}

/** The `coordination` step: the multi-replica coordinator (heartbeat, turns, leadership). */
function coordinationStep(coordination: BotCoordination, k: BotKernel): LifecycleStep {
  return {
    name: 'coordination',
    start: () => coordination.start(),
    // Only when its start() was attempted (it releases leases): no alwaysRollback.
    rollback: async () => {
      try { await coordination.stop() }
      catch (rollbackError) { k.logger.error({ err: rollbackError }, 'coordination start rollback failed') }
    },
    stop: () => coordination.stop(),
  }
}

/**
 * The `durability` step: `recover()` on start (after `restore`, before `transport`);
 * `resume()` (replay + sweeper) once the bot accepts inbound; `pause()` before the drain;
 * `stop()` after the transport (in-flight sends stay journaled until then).
 */
function durabilityStep(durable: DurableEngine, k: BotKernel): LifecycleStep {
  return {
    name: 'durability',
    start: () => durable.recover(),
    afterStart: () => { durable.resume() },
    pause: () => { durable.pause() },
    rollback: async () => {
      durable.pause()
      try { await durable.stop() }
      catch (rollbackError) { k.logger.error({ err: rollbackError }, 'durability start rollback failed') }
    },
    stop: () => durable.stop(),
  }
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
      for (const step of this.steps) step.afterStart?.()
      this.k.counters.markStarted()
      this.k.events.emit('started')
    } catch (error) {
      state.acceptingInbound = false
      const undo = [...attempted].reverse()
      // Never-reached steps that opted in (idempotent rollbacks, e.g. the scheduler) first.
      for (const step of this.steps) if (step.alwaysRollback && !attempted.includes(step)) undo.unshift(step)
      for (const step of undo) {
        if (!step.rollback) continue
        try { await step.rollback() }
        catch (rollbackError) { this.k.logger.error({ err: rollbackError, step: step.name }, 'start rollback failed') }
      }
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
    for (const step of reversed) {
      if (step.quiesce) await stopStep(step)
      else step.pause?.()
    }
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
