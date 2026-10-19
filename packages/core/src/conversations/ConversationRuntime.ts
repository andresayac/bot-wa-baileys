/**
 * The conversation engine: registers conversations (async functions and compiled DSL
 * flows), runs at most one per key, feeds it the messages routed to that key and
 * resolves its waits (`ask`, `choose`, timeouts, retries, `goto`/`end`). Every live
 * entry is bound to its own {@link ConversationHandle}, so a stale teardown never
 * touches a newer entry. Persistent flows checkpoint through a {@link CheckpointStore}
 * and resume dormant after a restart; with multi-replica coordination it also writes
 * the hand-over stubs another replica resumes from. Tracing and durability (causation)
 * hook in through {@link RuntimeConfig}; with neither configured they cost nothing.
 */
import {
  ConcurrentWaitError, ConversationCancelled, ConversationEnded, ConversationGoto,
  ConversationTimeout, RetriesExceeded,
} from './errors.js'
import type { CompiledFlow } from '../flows/FlowBuilder.js'
import { flowToConversation, runSteps } from './interpreter.js'
import type { ConversationControls } from './controls.js'
import type { FlowCheckpoint } from '../store/IStore.js'
import type { UserData } from '../user/types.js'
import type { ReplyOptions } from '../core/messaging.js'
import { randomId } from '../utils/timers.js'
import { translateFor } from '../i18n/I18n.js'
import { CORE_MESSAGES } from '../i18n/builtins.js'
import type { TranslateParams } from '../i18n/types.js'
import type { CheckpointAnswer, InboundLocation } from '../core/provider.js'
import type { CheckpointTrace } from '../telemetry/w3c.js'
import {
  adoptCause, currentCause, forkCause, hasCause, replayCauseRef, restoreCause, trackSettle,
  type CauseBox, type CauseRef, type SettleOutcome,
} from '../durability/causation.js'
import { LeaseLostError } from '../coordination/types.js'
import {
  flowShape, isPlainJson,
  type AnswerCodec, type HandoverOutcome, type InterruptedConversation, type RuntimeHandover,
} from './handover.js'

export interface RuntimeMessage {
  from: string; sender: string; body: string; type: string; isGroup: boolean
  /** `opts` is honored by bot contexts (pacing, `cancelIf`); other implementations may ignore it. */
  reply(text: string, opts?: ReplyOptions): Promise<unknown>
  /** Sender profile when the message came through a Bot (`userOf(ctx)` gives a non-optional handle). */
  user?: UserData
  /** Resolved language when the message came through a Bot (see `MessageContext.lang`). */
  lang?: string
  /** Bound translator when the message came through a Bot (see `MessageContext.t`). */
  t?(key: string, params?: TranslateParams): string
  /** Normalized shared location, when the message is one (see `MessageContext.sharedLocation`). */
  sharedLocation?: InboundLocation
}

/**
 * What a pending wait takes as an answer (diagnostics / plugins, see
 * {@link ConversationSnapshot.accepts}): `'text'` (`ask`, `waitText`), a list of
 * message types (`waitMedia`), or `'any'` (`choose`, which reads `body`, and `waitAny`).
 */
export type WaitAccepts = 'text' | 'any' | readonly string[]

export interface ResolvedWaitOptions {
  timeoutMs?: number
  filter?: (ctx: RuntimeMessage) => boolean
  /** What this wait takes as an answer; surfaced by {@link ConversationRuntime.inspect}. */
  accepts?: WaitAccepts
}

/** Opaque identity of a live conversation; keeps a stale teardown from touching a newer entry. */
export interface ConversationHandle { readonly key: string }

/** Minimal controls surface; `controls.ts` extends it with ask/waitText/choose/... */
export interface ConversationControlsBase {
  waitAny(opts?: ResolvedWaitOptions): Promise<RuntimeMessage>
  say(text: string): Promise<void>
  state: Record<string, unknown>
  end(farewell?: string): never
}

export type ConversationFn<C extends ConversationControlsBase = ConversationControlsBase> =
  (c: C, ctx: RuntimeMessage) => Promise<void>

/**
 * One `register()` / `registerCompiled()` call, as recorded by {@link ConversationRuntime.listRegistrations}.
 * Exactly one of `flow` / `fn` is set.
 */
export interface ConversationRegistration {
  /** Conversation name (the `CompiledFlow.id` for DSL flows). */
  readonly name: string
  /** The DSL flow, when registered through `registerCompiled()` — fully introspectable. */
  readonly flow?: CompiledFlow
  /** The async function, when registered through `register()` — opaque to introspection. */
  readonly fn?: ConversationFn
}

/** Minimal checkpoint persistence surface the runtime needs (Task 5). Implemented by IStore. */
export interface CheckpointStore {
  getCheckpoint(key: string): Promise<FlowCheckpoint | undefined>
  setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void>
  clearCheckpoint(key: string): Promise<void>
  listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>>
}

/** Opaque trace state of one live conversation (see {@link ConversationTraceHooks}). */
export interface ConversationTurnTrace { readonly conversation: true }

/**
 * Tracing seam of the runtime (`RuntimeConfig.tracing`): conversation turns as spans.
 * The Bot injects its implementation when `BotConfig.telemetry` is set.
 */
export interface ConversationTraceHooks {
  /**
   * `from`: the trace context a resumed checkpoint (or a hand-over stub restarted) carried
   * from the process that wrote it (`FlowCheckpoint.trace`): the first turn links to it.
   */
  begin(info: { id: string; name: string }, reason: 'start' | 'goto' | 'dormant', from?: CheckpointTrace): ConversationTurnTrace
  run<T>(trace: ConversationTurnTrace, fn: () => T): T
  resume(trace: ConversationTurnTrace, reason: 'reply' | 'timeout' | 'idle' | 'end'): void
  park(trace: ConversationTurnTrace): void
  end(trace: ConversationTurnTrace, outcome: string, goto?: string): void
  /**
   * Optional: the W3C trace context of the conversation's current (or last parked) turn,
   * stored in its checkpoints and hand-over stubs (`FlowCheckpoint.trace`).
   */
  carry?(trace: ConversationTurnTrace): CheckpointTrace | undefined
}

export interface RuntimeConfig {
  defaultTimeoutMs?: number
  timeoutMessage?: string
  cancelledMessage?: string
  retriesMessage?: string
  errorMessage?: string
  scope?: 'participant' | 'chat'
  logger?: { debug?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void }
  onError?: (error: unknown, ctx: RuntimeMessage) => void
  /** Factory of the full controls (`controls.ts`); defaults to the base controls. */
  controlsFactory?: (rt: ConversationRuntime, handle: ConversationHandle, ctx: RuntimeMessage) => ConversationControlsBase
  /** A conversation was entered (metrics / `'conversation:started'`). Must not throw. */
  onConversationStart?: (info: ConversationStartInfo) => void
  /** A conversation ended, whatever the reason (metrics / `'conversation:ended'`). Must not throw. */
  onConversationEnd?: (info: ConversationEndInfo) => void
  /**
   * Multi-replica coordination: run a conversation's timer-driven work (a wait timeout, a
   * `c.idle()` callback) under the chat's turn instead of directly. `fire` must run only
   * once the turn is held (it re-checks that the conversation is still live). Omitted:
   * timers fire directly (single process).
   */
  timerGate?: (key: string, ctx: RuntimeMessage, fire: () => unknown) => void
  /**
   * Multi-replica coordination: keep {@link FlowCheckpoint.parked} accurate on persistent
   * flows (one extra checkpoint write when a step parks on its first wait, one when that
   * wait is answered), so another replica resuming the flow knows whether the waking
   * message answers that wait. Off (default): checkpoints are written once per step.
   */
  trackParked?: boolean
  /**
   * Multi-replica coordination: throws (`LeaseLostError`) when `key`'s chat turn is known
   * lost. Called right before every checkpoint write or clear, so a replica known to have lost
   * the chat (a GC pause, a frozen VM) does not overwrite the checkpoint of the replica that
   * took it. A local check, not a conditional write; an aborted conversation's step never
   * writes nor clears its checkpoint anyway (see `wrapCompiled`).
   */
  fence?: (key: string) => void
  /**
   * Multi-replica coordination: records the answer of a flow step's FIRST wait in its
   * checkpoint ({@link FlowCheckpoint.answer}) and reads it back on the replica that resumes it.
   */
  answers?: AnswerCodec
  /** Multi-replica coordination: the conversation hand-over policy (`coordination.handover`). */
  handover?: RuntimeHandover
  /**
   * Tracing (`BotConfig.telemetry`): each stretch of a conversation between two waits is
   * a `bot.conversation.turn` span (see telemetry/conversation.ts). Omitted: no span code runs.
   */
  tracing?: ConversationTraceHooks
}

/**
 * How a conversation ended:
 * - `completed` — the function returned or it `c.goto()`-ed elsewhere;
 * - `ended` — `c.end()` was called;
 * - `guarded` — a `.guard()` failed (whether it ended the flow or redirected it);
 * - `cancelled` — aborted (`/reset`, handoff, replaced by a new conversation, `stop()`) or `ConversationCancelled`;
 * - `timedOut` — a wait expired;
 * - `retriesExceeded` — `c.retry()` ran out of attempts;
 * - `error` — the conversation threw anything else.
 */
export type ConversationOutcome = 'completed' | 'ended' | 'guarded' | 'cancelled' | 'timedOut' | 'retriesExceeded' | 'error'

/** Options of {@link ConversationRuntime.enter}. */
export interface EnterOptions {
  /** Initial `c.state` (shallow-copied). Used by `bot.trigger(name, { data })`. */
  state?: Record<string, unknown>
  /** Name reported to lifecycle observers when `enter()` receives a function (e.g. a resumed flow). */
  name?: string
}

export interface ConversationStartInfo {
  /** Unique per conversation instance: pairs a start with its end (several can share `key`/`name`). */
  id: string
  name: string
  key: string
  ctx: RuntimeMessage
}

export interface ConversationEndInfo extends ConversationStartInfo {
  outcome: ConversationOutcome
  durationMs: number
  /** Target of the `c.goto()` that ended it, when it ended that way. */
  goto?: string
}

interface PendingWait {
  resolve(ctx: RuntimeMessage): void
  reject(err: Error): void
  filter?: (ctx: RuntimeMessage) => boolean
  accepts?: WaitAccepts
  timer?: NodeJS.Timeout
}

/**
 * Lifecycle observer of ONE live conversation (see {@link ConversationRuntime.observe}).
 * Used by `c.idle()` watchdogs; callbacks must be cheap and must not throw.
 */
export interface ConversationObserver {
  /** Any inbound message routed to the conversation's key — even one its pending wait filters out. */
  inbound?(ctx: RuntimeMessage): void
  /** The conversation ended or was aborted/replaced. Fires at most once. */
  end?(): void
}

interface ActiveConversation extends ConversationHandle {
  state: Record<string, unknown>
  inbox: RuntimeMessage[]
  pending?: PendingWait
  cancelled?: ConversationCancelled
  /** Control error injected from outside the conversation's call stack; thrown at its next wait. */
  interrupted?: Error
  observers?: Set<ConversationObserver>
  /** Lifecycle bookkeeping for start/end observers; `ended` makes the end report fire once. */
  life?: { info: ConversationStartInfo; startedAt: number; ended: boolean }
  /** Most recent inbound message routed to this conversation (drives c.t / built-in messages). */
  latest?: RuntimeMessage
  /** Resolves once the conversation function has fully unwound (see {@link ConversationRuntime.suspend}). */
  unwound?: Promise<void>
  /** Multi-replica handover: the first wait skips its prompt (see {@link ConversationRuntime.refreshDormant}). */
  handover?: boolean
  /** Persistent flows: the checkpoint as last written by (or resumed into) this conversation. */
  cp?: FlowCheckpoint
  /** Waits started since {@link cp} was written (`trackParked`). */
  waits?: number
  /** Checkpoint marker write in flight (`trackParked`); later writes and the final clear wait for it. */
  parking?: Promise<void>
  /** Durability: the causation box this conversation runs in (see durability/causation.ts). */
  cause?: CauseBox
  /** Durability: settles of the steps fed to it, resolved when it next blocks on a wait or ends. */
  idle?: Array<(outcome: SettleOutcome) => void>
  /** The last checkpoint (marker or stub) write of this conversation failed (`trackParked`). */
  cpDirty?: boolean
  /** Aborted keeping its stored state (shutdown, suspension): no checkpoint/stub clear on unwind. */
  preserved?: boolean
  /** `handover.fallback`: this conversation cannot be forwarded; it keeps a stub while it waits. */
  wantsStub?: boolean
  /** The stub last written for it (see {@link ConversationRuntime.writeStub}). */
  stub?: FlowCheckpoint
  /** A stub write was started (cleared again on unwind). */
  stubbed?: boolean
  /** Initial `c.state` when plain JSON (`handover`): recorded in stubs/ephemeral checkpoints. */
  startState?: Record<string, unknown>
  /** Tracing: the conversation's turn spans (see {@link RuntimeConfig.tracing}). */
  trace?: ConversationTurnTrace
  /** Tracing: the wait an idle turn was opened for (see {@link ConversationRuntime.runIdle}). */
  idleTurn?: PendingWait
}

/** Marks a conversation function that keeps its own checkpoint (no hand-over stub needed). */
const CHECKPOINTS = Symbol('botwa.checkpoints')
type Marked = ConversationFn & { [CHECKPOINTS]?: true }
const isMarked = (fn: ConversationFn): boolean => (fn as Marked)[CHECKPOINTS] === true
function mark(fn: ConversationFn): ConversationFn { (fn as Marked)[CHECKPOINTS] = true; return fn }

const INBOX_CAP = 10

/** Read-only view of a live conversation (diagnostics / dev tooling). */
export interface ConversationSnapshot {
  /** Conversation key (`keyFor`): the chat id, or `${chatId}:${senderId}` per group participant. */
  key: string
  /** Shallow copy of the conversation's `c.state` (captured `ask` answers, ...). */
  state: Record<string, unknown>
  /** True while the conversation is blocked waiting for the user's next message. */
  waiting: boolean
  /** Messages buffered for the conversation that it has not consumed yet. */
  queued: number
  /**
   * What the pending wait takes as an answer (`'text'`, a list of message types,
   * or `'any'`); `undefined` when not waiting or the wait did not declare it.
   */
  accepts?: WaitAccepts
}

export class ConversationRuntime {
  private registry = new Map<string, ConversationFn>()
  private active = new Map<string, ActiveConversation>()
  private compiled = new Map<string, CompiledFlow>()
  private store?: CheckpointStore
  private dormant = new Map<string, FlowCheckpoint>()
  /** Store clears of discarded dormant checkpoints still in flight, by key. */
  private pendingClears = new Map<string, Promise<void>>()
  /** Keys whose persistent checkpoint must NOT be cleared on unwind (shutdown teardown). */
  private preserveOnAbort = new Set<string>()
  /** Registration history for introspection — see {@link listRegistrations}. */
  private registrations: ConversationRegistration[] = []
  /** Set by {@link close} (bot stopped): no conversation starts until {@link open}. */
  private closed = false
  /** Callers of {@link whenSettled}, per key. */
  private settleWaiters = new Map<string, Set<() => void>>()
  /** Keys whose dormant checkpoint was handed over by another replica (see {@link refreshDormant}). */
  private handovers = new Set<string>()
  /** Waking message(s) of a handover resume, consumed by the entry {@link run} creates next for its key. */
  private handoverAnswers = new Map<string, RuntimeMessage[]>()
  /** Durability: the cause of each buffered (not yet consumed) message. */
  private bufferedCauses = new WeakMap<RuntimeMessage, CauseRef>()
  /** Tracing: keys whose next {@link run} resumes a dormant checkpoint (consumed synchronously). */
  private tracedResumes = new Set<string>()
  /** Tracing: the stored trace context the next {@link run} for a key links its first turn to (consumed synchronously). */
  private tracedFrom = new Map<string, CheckpointTrace>()

  constructor(private cfg: RuntimeConfig = {}) {}

  register(name: string, fn: ConversationFn): void { this.define({ name, fn }, fn) }
  has(name: string): boolean { return this.registry.has(name) }

  /** The live conversation function registered under `name` (dynamic flow registry). */
  lookup(name: string): ConversationFn | undefined { return this.registry.get(name) }

  /**
   * Forget the registration `name`. Running conversations keep the function they entered
   * with; new `enter(name)` calls fail. Its history is dropped from {@link listRegistrations}.
   */
  unregister(name: string): boolean {
    if (!this.registry.delete(name)) return false
    this.compiled.delete(name)
    this.registrations = this.registrations.filter((r) => r.name !== name)
    return true
  }

  /** Snapshots of every live conversation (diagnostics / manager API). */
  listActive(): ConversationSnapshot[] {
    return [...this.active.keys()].map((key) => this.inspect(key)!)
  }

  /**
   * Every `register`/`registerCompiled` call so far, oldest first. A name registered twice
   * appears twice; the LAST entry for a name is the live one. Read by `Bot.describe()`/`Bot.lint()`.
   */
  listRegistrations(): ConversationRegistration[] { return [...this.registrations] }

  private define(registration: ConversationRegistration, fn: ConversationFn): void {
    this.registry.set(registration.name, fn)
    this.registrations.push(registration)
  }

  /** Wires a checkpoint-capable store; required for `persistent()` flows to actually persist. */
  attachStore(store: CheckpointStore): void { this.store = store }

  /** Registers a compiled DSL flow by its `flow.id`, wrapping it with checkpoint support when persistent. */
  registerCompiled(flow: CompiledFlow): void {
    this.compiled.set(flow.id, flow)
    this.define({ name: flow.id, flow }, this.wrapCompiled(flow))
  }

  private wrapCompiled(flow: CompiledFlow, startAt = 0, resumedFrom?: FlowCheckpoint): ConversationFn {
    // Multi-replica hand-over (`handover.flows: 'forward'`): a flow WITHOUT .persistent() is
    // checkpointed too ("ephemeral", TTL-bound) so the replica that takes its chat continues it.
    const forward = !flow.opts.persistent && this.cfg.handover?.flows === 'forward'
    if ((!flow.opts.persistent && !forward) || !this.store) {
      if (startAt === 0 && !resumedFrom) return flowToConversation(flow)
      return async (c, ctx) => {
        // A checkpoint resumed by a replica that does not checkpoint this flow (an ephemeral
        // one written by a replica with `handover.flows: 'forward'`, mixed configuration):
        // nothing here will ever advance or clear it, so drop it now. Left in place, a
        // replica taking the chat later would resume this (finished) flow at a stale step.
        if (resumedFrom) this.queueClear(this.keyFor(ctx), undefined, true)
        await runSteps(flow, ctx, c as ConversationControls, startAt)
      }
    }
    const shape = forward ? flowShape(flow) : undefined
    return mark(async (c, ctx) => {
      const key = this.keyFor(ctx)
      const entry = this.active.get(key)
      if (entry && resumedFrom) { entry.cp = resumedFrom; entry.waits = 0 }
      /** A forwarded flow that can no longer be checkpointed (non-JSON state, store down). */
      let degraded = false
      const save = async (step: number) => {
        // A clear of the checkpoint this conversation replaced may still be in flight:
        // let it land first, or it would wipe this conversation's fresh checkpoint.
        await this.pendingClears.get(key)
        await entry?.parking
        // Aborted (suspended, replaced, stopped) while the step ran: whatever this step still
        // does belongs to no live conversation. A newer one (possibly on this same replica,
        // which re-acquired the chat's turn) owns the key's checkpoint now: stop here.
        if (entry?.cancelled) throw entry.cancelled
        if (degraded) return
        const state = { ...(c as ConversationControls).state }
        if (forward && !isPlainJson(state)) {
          degraded = true
          this.degradeForward(key, entry, 'its state is not plain JSON')
          return
        }
        const cause = currentCause()
        const now = Date.now()
        const cp: FlowCheckpoint = {
          flowId: flow.id,
          step,
          state,
          updatedAt: now,
          // Durability: the inbound record whose effects this checkpoint captures (the message
          // that entered the flow or that the step consumed — a replay of it is skipped) and
          // where the next step's send keys continue (a re-run step re-derives the same keys).
          ...(cause ? { inboundId: cause.id, cause: { id: cause.id, seq: cause.seq } } : {}),
          ...(forward ? { handover: this.ephemeralMeta(entry, flow.id, shape!, now) } : {}),
          ...this.traceField(entry, entry?.cp?.trace),
        }
        // Coordination: a replica known to have lost the chat does not overwrite the new owner's checkpoint.
        this.cfg.fence?.(key)
        if (!forward) {
          await this.store!.setCheckpoint(key, cp)
        } else {
          try {
            await this.store!.setCheckpoint(key, cp)
          } catch (error) {
            // Best effort: the flow goes on in memory, and no stale step is left to hand over.
            this.cfg.logger?.warn?.('hand-over checkpoint write failed; the flow continues without it', error)
            degraded = true
            this.degradeForward(key, entry)
            return
          }
        }
        if (entry) { entry.cp = cp; entry.waits = 0; entry.cpDirty = false }
      }
      try {
        // Durability: checkpoint the entry too, so a crash before the first step completes
        // can resume the flow when the answer that was in flight is replayed. Coordination:
        // likewise, so a flow suspended in its first step can be handed over.
        if (startAt === 0 && (hasCause() || this.cfg.trackParked)) await save(0)
        await runSteps(flow, ctx, c as ConversationControls, startAt, (stepIndex) => save(stepIndex + 1))
      } finally {
        await entry?.parking
        // On a graceful shutdown (abortAll) or a suspension we KEEP the checkpoint so a restart
        // (or the replica that takes the chat) can resume it. Every other exit (completion,
        // error, timeout, user /reset) clears it. Decided per conversation, not per key: a
        // suspended step that unwinds only after a newer conversation took the key (and
        // consumed the key's flag) must still leave that conversation's checkpoint alone.
        const preserved = entry ? entry.preserved === true : this.preserveOnAbort.delete(key)
        if (preserved) {
          // preserved — leave the persisted checkpoint intact for resume-on-restart
        } else if (this.mayWrite(key)) {
          await this.store!.clearCheckpoint(key).catch(() => {})
          if (entry) entry.stubbed = false
        }
      }
    })
  }

  /**
   * A checkpointed conversation cut short mid-step consumed an answer its stored checkpoint
   * does not hold: the answer of a later wait of the step (only the first wait's answer is
   * recorded), or a first-wait answer that could not be recorded (too large, unknown origin).
   */
  private answerUnheld(entry: ActiveConversation): boolean {
    const cp = entry.cp
    if (!cp || !this.cfg.trackParked) return false
    const waits = entry.waits ?? 0
    return waits > 1 || (waits === 1 && cp.answer === undefined)
  }

  /** `true` unless the coordination fence refuses writes for `key` (its chat turn was lost). */
  private mayWrite(key: string): boolean {
    try { this.cfg.fence?.(key); return true } catch { return false }
  }

  /** Hand-over metadata of an ephemeral checkpoint (forwarded flow without `.persistent()`). */
  private ephemeralMeta(entry: ActiveConversation | undefined, name: string, shape: string, now: number): NonNullable<FlowCheckpoint['handover']> {
    return {
      kind: 'ephemeral',
      expiresAt: now + this.cfg.handover!.ttlMs,
      shape,
      name,
      ...(entry?.life ? { startedAt: entry.life.startedAt } : {}),
      ...(entry?.startState ? { startState: entry.startState } : {}),
    }
  }

  /**
   * A forwarded flow can no longer be checkpointed: drop its ephemeral checkpoint and, with a
   * hand-over fallback, keep a stub for it instead (written at its next wait).
   */
  private degradeForward(key: string, entry: ActiveConversation | undefined, why?: string): void {
    if (why) this.cfg.logger?.debug?.(`flow not forwarded for hand-over: ${why}`, { key })
    if (entry) {
      entry.cp = undefined
      entry.wantsStub = this.cfg.handover !== undefined && this.cfg.handover.fallback !== 'drop'
    }
    this.queueClear(key, entry?.parking, true)
  }

  /**
   * Loads all persisted checkpoints into the dormant map (Bot.start()). The map is replaced,
   * not merged: across a stop()/start() cycle the store is the source of truth, so a
   * checkpoint cleared meanwhile (erasure, another replica) never resumes from memory.
   */
  async loadDormant(): Promise<void> {
    if (!this.store) return
    const checkpoints = await this.store.listCheckpoints()
    this.dormant.clear()
    this.handovers.clear()
    const now = Date.now()
    for (const [key, cp] of checkpoints) {
      // An expired hand-over entry (ephemeral checkpoint / stub) is not resumable: drop it.
      if (cp.handover && cp.handover.expiresAt <= now) { this.queueClear(key); continue }
      this.dormant.set(key, cp)
    }
  }

  /**
   * If an incoming message's key has a dormant checkpoint, consumes it and resumes the flow
   * at the checkpointed step with state restored. The waking message only wakes the flow —
   * the pending step (e.g. an `ask`) re-runs and re-prompts. Returns false if there was nothing
   * to resume (caller should fall through to normal trigger matching).
   */
  async resumeDormant(ctx: RuntimeMessage): Promise<boolean> {
    const key = this.keyFor(ctx)
    const cp = this.dormant.get(key)
    if (!cp) return false
    this.dormant.delete(key)
    const handover = this.handovers.delete(key)
    const meta = cp.handover
    if (meta) {
      // Multi-replica hand-over entries (`coordination.handover`).
      const name = meta.name ?? cp.flowId
      if (meta.expiresAt <= Date.now()) {
        this.queueClear(key, undefined, true)
        this.reportHandover(key, name, 'expired')
        return false
      }
      if (meta.kind === 'stub') {
        this.queueClear(key, undefined, true)
        return this.interrupted(ctx, interruptedOf(key, name, 'unforwardable', meta, cp.trace))
      }
    }
    const flow = this.compiled.get(cp.flowId)
    if (!flow) { await this.store?.clearCheckpoint(key).catch(() => {}); return false }
    if (meta?.kind === 'ephemeral' && meta.shape !== undefined && meta.shape !== flowShape(flow)) {
      // The flow changed on this replica (rolling deploy): its step index means something else.
      this.queueClear(key, undefined, true)
      return this.interrupted(ctx, interruptedOf(key, cp.flowId, 'changed', meta, cp.trace))
    }
    // Durability (a cause is active and the checkpoint recorded one): the pending step re-runs
    // under the causation it had, so its prompt — already sent before the restart — is answered
    // from the outbox instead of being repeated, and the waking message is its answer.
    const cause = hasCause() ? cp.cause : undefined
    const inner = this.wrapCompiled(flow, cp.step, cp)
    const resumed: ConversationFn = async (c, rctx) => {
      if (cause) restoreCause(cause)
      Object.assign((c as ConversationControlsBase).state, cp.state)
      await inner(c, rctx)
    }
    if (isMarked(inner)) mark(resumed)
    // Durability: a replay of the message this checkpoint already captured is not an answer.
    const replayOfCaptured = cause !== undefined && cp.inboundId === currentCause()?.id
    // Coordination: the step was cut short after its first wait consumed an answer — feed it
    // that answer again (and keep the waking message for the next wait).
    const answers = cp.answer ? await this.answersFor(cp.answer, ctx, replayOfCaptured) : undefined
    if (answers) this.handoverAnswers.set(key, answers)
    else if (handover && !replayOfCaptured) this.handoverAnswers.set(key, [ctx])
    // enter() is fire-and-forget (it only resolves when the resumed flow ends); a rejection
    // here (e.g. a bad goto target) would otherwise become an unhandled rejection → crash.
    // Tracing: the resumed conversation's first turn ('dormant') runs under the waking
    // message's dispatch and LINKS to the turn that wrote the checkpoint (`cp.trace`, the
    // W3C context carried from the replica or process that ran it before), so the trace of
    // the waking message stays whole and the earlier trace is one click away.
    if (this.cfg.tracing) {
      this.tracedResumes.add(key)
      if (cp.trace) this.tracedFrom.set(key, cp.trace)
    }
    void this.enter(resumed, ctx, { name: cp.flowId }).catch((e) => {
      this.cfg.onError?.(e, ctx)
      this.cfg.logger?.error?.('resume failed', e)
    })
    this.handoverAnswers.delete(key)   // consumed synchronously by run(); never left behind
    if (meta?.kind === 'ephemeral') this.reportHandover(key, cp.flowId, 'resumed')
    if (this.cfg.tracing) { this.tracedResumes.delete(key); this.tracedFrom.delete(key) }
    // Durability: the waking message answers the re-run step (a handover already queued it as
    // the parked wait's answer) — unless the checkpoint already captured this very message (a
    // replay after the step that consumed it): the flow then only re-runs its pending steps.
    if (cause && !handover && !answers && !replayOfCaptured) this.deliver(ctx)
    return true
  }

  /**
   * The messages a resumed step consumes first, from a checkpoint's recorded answer: the
   * answer itself (rehydrated, or the waking event when it IS that answer being replayed),
   * then the waking message. `undefined` when the answer is no longer available.
   */
  private async answersFor(answer: CheckpointAnswer, ctx: RuntimeMessage, replayOfCaptured: boolean): Promise<RuntimeMessage[] | undefined> {
    const current = currentCause()
    if (answer.inboundId !== undefined && current?.id === answer.inboundId) {
      // A replay of the answer itself (the previous replica stopped before acknowledging it).
      const ref = answer.cause ? replayCauseRef(answer.cause) : undefined
      if (ref) this.bufferedCauses.set(ctx, ref)
      return [ctx]
    }
    const codec = this.cfg.answers
    if (!codec) return undefined
    let rehydrated: RuntimeMessage | undefined
    try {
      rehydrated = await codec.rehydrate(answer)
    } catch (error) {
      this.cfg.logger?.warn?.('hand-over answer could not be read back; the step re-runs', error)
    }
    if (!rehydrated) return undefined
    const ref = answer.cause ? replayCauseRef(answer.cause) : undefined
    if (ref) this.bufferedCauses.set(rehydrated, ref)
    if (replayOfCaptured) return [rehydrated]
    if (current) this.bufferedCauses.set(ctx, current)
    return [rehydrated, ctx]
  }

  /**
   * A conversation another replica ran cannot be continued here (a stub, or a forwarded
   * flow that changed): apply `handover.fallback`. `true` when the waking message was consumed.
   */
  private async interrupted(ctx: RuntimeMessage, info: InterruptedConversation): Promise<boolean> {
    const h = this.cfg.handover
    const policy = h?.fallback ?? 'drop'
    let outcome: HandoverOutcome = info.reason === 'changed' ? 'changed' : 'dropped'
    let consumed = false
    if (typeof policy === 'function') {
      try {
        consumed = (await policy(info, ctx)) === true
      } catch (error) {
        this.reportError(error, ctx)
      }
      if (consumed) outcome = 'migrated'
    } else if (policy === 'restart' && this.registry.has(info.name)) {
      // Tracing: the restarted conversation's first turn links to the stub's last turn.
      if (this.cfg.tracing && info.trace) this.tracedFrom.set(info.key, info.trace)
      void this.enter(info.name, ctx, info.startState ? { state: info.startState } : {}).catch((e) => {
        this.cfg.onError?.(e, ctx)
        this.cfg.logger?.error?.('hand-over restart failed', e)
      })
      this.tracedFrom.delete(info.key)
      consumed = true
      outcome = 'restarted'
    } else if (policy === 'notify' || policy === 'restart') {
      await this.safeReply(ctx, h?.notifyMessage ?? translateFor(ctx, CORE_MESSAGES.conversationInterrupted))
      consumed = true
      outcome = 'notified'
    }
    this.reportHandover(info.key, info.name, outcome)
    return consumed
  }

  private reportHandover(key: string, name: string, outcome: HandoverOutcome): void {
    const report = this.cfg.handover?.onHandover
    if (report) this.notifyLifecycle(() => report({ key, name, outcome }))
  }

  keyFor(ctx: Pick<RuntimeMessage, 'from' | 'sender' | 'isGroup'>): string {
    const scope = this.cfg.scope ?? 'participant'
    return ctx.isGroup && scope === 'participant' ? `${ctx.from}:${ctx.sender}` : ctx.from
  }

  hasActive(key: string): boolean { return this.active.has(key) }

  /** Drop `key`'s dormant checkpoint (memory + store). Returns whether one existed. */
  discardDormant(key: string): boolean {
    this.handovers.delete(key)
    if (!this.dormant.delete(key)) return false
    this.queueClear(key)
    return true
  }

  /**
   * Clear `key`'s stored checkpoint after `after` (and after any clear already queued).
   * Tracked per key so a conversation entered right after this waits for the clear before
   * writing its own checkpoint (async stores do not order the two writes). `fenced`: skipped
   * when this replica lost the chat's turn (coordination).
   */
  private queueClear(key: string, after?: Promise<unknown>, fenced = false): void {
    const store = this.store
    if (!store) return
    const clear: Promise<void> = Promise.all([this.pendingClears.get(key), after])
      .then(() => (fenced && !this.mayWrite(key) ? undefined : store.clearCheckpoint(key)))
      .catch(() => {})
      .finally(() => { if (this.pendingClears.get(key) === clear) this.pendingClears.delete(key) })
    this.pendingClears.set(key, clear)
  }

  /**
   * Multi-replica: re-read `key`'s checkpoint from the store into the dormant map (or
   * drop the dormant entry when the store has none). Another replica may have advanced
   * or finished the flow since this one loaded it.
   */
  async refreshDormant(key: string): Promise<void> {
    this.handovers.delete(key)
    if (!this.store) return
    await this.pendingClears.get(key)
    const cp = await this.store.getCheckpoint(key)
    if (cp) {
      this.dormant.set(key, cp)
      // Parked on the step's first wait with its prompt sent (`trackParked`): the waking
      // message is that wait's ANSWER. Otherwise (parked on a later wait of the step, a
      // step cut short, a crash before the prompt went out) the step re-runs from its start.
      if (cp.parked === true) this.handovers.add(key)
    } else {
      this.dormant.delete(key)
    }
  }

  /** Consume the handover flag of `handle`'s conversation: its first wait then skips its prompt (once). */
  takeHandover(handle: ConversationHandle): boolean {
    const entry = handle as ActiveConversation
    if (!entry.handover) return false
    entry.handover = false
    return true
  }

  /**
   * Multi-replica: silently abort `key`'s live conversation KEEPING its persistent
   * checkpoint (like a shutdown), because another replica now owns the key and resumes
   * it from the store. Resolves once the aborted conversation has unwound (bounded by
   * `maxWaitMs`), so its cleanup cannot clear a checkpoint written afterwards.
   */
  async suspend(key: string, maxWaitMs = 5_000): Promise<boolean> {
    const entry = this.active.get(key)
    if (!entry) return false
    this.preserveOnAbort.add(key)
    if (!this.abort(key)) { this.preserveOnAbort.delete(key); return false }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      entry.unwound ?? Promise.resolve(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs) }),
    ])
    if (timer) clearTimeout(timer)
    return true
  }

  /**
   * Resolves when `key` has no running conversation step: no live conversation, or the
   * live one is blocked waiting for the next message. Multi-replica coordination holds
   * the chat's turn until then, so no other replica processes the chat mid-step.
   */
  whenSettled(key: string): Promise<void> {
    const entry = this.active.get(key)
    if (!entry || (entry.pending && !entry.parking)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let set = this.settleWaiters.get(key)
      if (!set) this.settleWaiters.set(key, (set = new Set()))
      set.add(resolve)
    })
  }

  private notifySettled(key: string): void {
    const set = this.settleWaiters.get(key)
    if (!set) return
    const entry = this.active.get(key)
    if (entry && (!entry.pending || entry.parking)) return
    this.settleWaiters.delete(key)
    for (const resolve of set) resolve()
  }

  /** Number of live conversations (every key). */
  activeCount(): number { return this.active.size }

  /** True while `key` has a persisted checkpoint waiting to be resumed by its next message. */
  hasDormant(key: string): boolean { return this.dormant.has(key) }

  /** Snapshot of the live conversation on `key`, or `undefined` when none is active. Never mutates it. */
  inspect(key: string): ConversationSnapshot | undefined {
    const entry = this.active.get(key)
    if (!entry) return undefined
    const accepts = entry.pending?.accepts
    return {
      key,
      state: { ...entry.state },
      waiting: entry.pending !== undefined,
      queued: entry.inbox.length,
      ...(accepts !== undefined ? { accepts: typeof accepts === 'string' ? accepts : [...accepts] } : {}),
    }
  }

  /**
   * True while some live conversation is executing a step: it is active and NOT
   * blocked waiting for the user's next message (every control waits through
   * {@link wait}, which sets `pending`).
   */
  hasRunning(): boolean {
    for (const entry of this.active.values()) if (!entry.pending) return true
    return false
  }

  async enter(nameOrFn: string | ConversationFn, ctx: RuntimeMessage, opts: EnterOptions = {}): Promise<void> {
    return this.run(nameOrFn, ctx, opts)
  }

  /**
   * `latest` seeds the new entry's latest message: on `c.goto()` the target inherits the
   * newest message of the conversation it replaces, so `c.t`/`c.lang` and the built-in
   * messages keep the language the user switched to mid-conversation.
   */
  private async run(nameOrFn: string | ConversationFn, ctx: RuntimeMessage, opts: EnterOptions = {}, latest?: RuntimeMessage): Promise<void> {
    const fn = typeof nameOrFn === 'string' ? this.registry.get(nameOrFn) : nameOrFn
    if (!fn) throw new Error(`Conversation "${String(nameOrFn)}" is not registered`)
    const name = typeof nameOrFn === 'string' ? nameOrFn : (opts.name ?? (fn.name || '(anonymous)'))

    // A stopped bot starts nothing: a message queued before stop() (or a goto, or a
    // detached handler) must not open a conversation — and arm its wait timers — afterwards.
    if (this.closed) return

    const key = this.keyFor(ctx)
    // A fresh conversation on this key must not inherit a stale shutdown-preserve flag
    // (relevant when the runtime is reused across a stop()/start() cycle).
    this.preserveOnAbort.delete(key)
    if (this.active.has(key)) this.abort(key)
    // The new conversation replaces a dormant one too: left in place, the stale checkpoint
    // would wake (and hijack) the subject's first message after this conversation ends.
    // A resumed flow consumed its own checkpoint before entering, so this is a no-op there.
    this.discardDormant(key)

    const entry: ActiveConversation = { key, state: opts.state ? { ...opts.state } : {}, inbox: [], ...(latest ? { latest } : {}) }
    let markUnwound!: () => void
    entry.unwound = new Promise<void>((resolve) => { markUnwound = resolve })
    const answers = this.handoverAnswers.get(key)
    if (answers) {
      // Multi-replica handover resume: the waking message (or the step's recorded answer,
      // then the waking message) answers the parked wait.
      this.handoverAnswers.delete(key)
      entry.handover = true
      entry.inbox.push(...answers)
      entry.latest = answers[answers.length - 1]
    }
    const h = this.cfg.handover
    if (h) {
      if (opts.state && isPlainJson(opts.state)) entry.startState = { ...opts.state }
      // A conversation that keeps no checkpoint of its own leaves a stub while it waits, so
      // the replica that takes the chat can apply `handover.fallback`.
      entry.wantsStub = h.fallback !== 'drop' && this.store !== undefined && !isMarked(fn)
    }
    this.active.set(key, entry)
    this.trackIdle(entry)
    const startInfo: ConversationStartInfo = { id: randomId('conv'), name, key, ctx }
    entry.life = { info: startInfo, startedAt: Date.now(), ended: false }
    this.notifyLifecycle(() => this.cfg.onConversationStart?.(startInfo))
    const tracing = this.cfg.tracing
    if (tracing) {
      const reason = latest ? 'goto' : this.tracedResumes.delete(key) ? 'dormant' : 'start'
      const from = latest ? undefined : this.tracedFrom.get(key)
      this.tracedFrom.delete(key)
      entry.trace = tracing.begin({ id: startInfo.id, name }, reason, from)
    }

    const controls = (this.cfg.controlsFactory ?? defaultControlsFactory)(this, entry, ctx)

    let goto: ConversationGoto | undefined
    let outcome: ConversationOutcome = 'completed'
    try {
      const forked = entry.trace
        ? tracing!.run(entry.trace, () => forkCause(() => fn(controls as never, ctx)))
        : forkCause(() => fn(controls as never, ctx))
      entry.cause = forked.box
      await forked.result
    } catch (e) {
      if (entry.cancelled) {
        // Conversation replaced/aborted: it dies silently, with no visible effects.
        outcome = 'cancelled'
      } else if (e instanceof ConversationEnded) {
        outcome = e.guarded ? 'guarded' : 'ended'
        if (e.farewell) await this.endReply(entry, ctx, e.farewell)
      } else if (e instanceof ConversationGoto) {
        if (e.guarded) outcome = 'guarded'
        goto = e
      } else if (e instanceof ConversationTimeout) {
        outcome = 'timedOut'
        await this.endReply(entry, ctx, this.cfg.timeoutMessage ?? translateFor(entry.latest ?? ctx, CORE_MESSAGES.timeout))
      } else if (e instanceof ConversationCancelled) {
        outcome = 'cancelled'
        if (!e.silent && this.cfg.cancelledMessage) await this.endReply(entry, ctx, this.cfg.cancelledMessage)
      } else if (e instanceof RetriesExceeded) {
        outcome = 'retriesExceeded'
        await this.endReply(entry, ctx, this.cfg.retriesMessage ?? translateFor(entry.latest ?? ctx, CORE_MESSAGES.retries))
      } else if (e instanceof LeaseLostError) {
        // Coordination fence: this replica lost the chat (a checkpoint write was refused);
        // another replica owns the conversation now — end silently, nothing can be sent anyway.
        outcome = 'cancelled'
        this.cfg.logger?.debug?.('conversation stopped: chat turn lost', { key })
      } else {
        outcome = 'error'
        // Traced: reported from the conversation's own box, so the error lands on the turn that failed.
        this.inBox(entry, () => {
          this.cfg.onError?.(e, ctx)
          this.cfg.logger?.error?.('conversation error', e)
        })
        await this.endReply(entry, ctx, this.cfg.errorMessage ?? translateFor(entry.latest ?? ctx, CORE_MESSAGES.error))
      }
    } finally {
      // A goto hands the key straight to its target: not settled until the target is.
      this.cleanup(entry, !(goto && !entry.cancelled))
      markUnwound()
      // An aborted conversation already reported its end (as cancelled) from abort().
      this.reportEnd(entry, entry.cancelled ? 'cancelled' : outcome, entry.cancelled ? undefined : goto?.target)
    }
    if (goto && !entry.cancelled) {
      try {
        // Traced: the target's first turn starts under the turn that ran the goto (not
        // under the handler that entered this conversation, possibly long gone).
        await this.inBox(entry, () => this.run(goto.target, ctx, {}, entry.latest))
      } finally {
        // The target could not start (closed, unknown name) or has ended.
        if (this.settleWaiters.size > 0) this.notifySettled(key)
      }
    }
  }

  deliver(ctx: RuntimeMessage): boolean {
    const entry = this.active.get(this.keyFor(ctx))
    if (!entry) return false
    entry.latest = ctx
    if (entry.observers) for (const o of [...entry.observers]) { try { o.inbound?.(ctx) } catch { /* observers must not break delivery */ } }
    if (entry.pending) {
      if (entry.pending.filter && !entry.pending.filter(ctx)) return false
      if (entry.trace) this.cfg.tracing!.resume(entry.trace, 'reply')
      adoptCause(entry.cause)
      this.trackIdle(entry)
      entry.pending.resolve(ctx)
      return true
    }
    const cause = currentCause()
    if (cause) {
      this.bufferedCauses.set(ctx, cause)
      this.trackIdle(entry)
    }
    entry.inbox.push(ctx)
    if (entry.inbox.length > INBOX_CAP) entry.inbox.shift()
    return true
  }

  abort(key: string): boolean {
    const entry = this.active.get(key)
    if (!entry) return false
    const cancel = new ConversationCancelled(true)
    entry.cancelled = cancel
    // Shutdown / suspension: the stored checkpoint (or stub) is kept for whoever resumes it.
    const preserved = this.preserveOnAbort.has(key)
    if (preserved) entry.preserved = true
    const running = entry.pending === undefined
    if (entry.pending) entry.pending.reject(cancel)
    // A step still running is never resumed: its fed events settle now (as 'aborted' on stop()).
    // Coordination: only once the checkpoint marker in flight landed — the inbox record is
    // acknowledged as handed over when the stored checkpoint holds its effect, and released
    // (replayed) when that write failed or when no checkpoint holds the answer the step consumed.
    const closed = this.closed
    this.settleAfter(this.detachIdle(entry), entry.parking,
      () => (closed || (preserved && (entry.cpDirty || (running && this.answerUnheld(entry)))) ? 'aborted' : 'settled'))
    if (!preserved) this.dropStub(entry)
    this.active.delete(key)
    this.notifyEnd(entry)
    // Report the end now, synchronously: a replacing conversation's start must come
    // AFTER the replaced one's end, or per-key trackers would see the key as idle.
    this.reportEnd(entry, 'cancelled')
    return true
  }

  /**
   * Abort every active conversation — used by `Bot.stop()` so pending wait timers
   * don't keep the event loop alive after shutdown. Unlike a user `/reset`, this is a
   * teardown: any persistent checkpoint is PRESERVED so the flow resumes on restart.
   * Returns the number aborted.
   */
  abortAll(): number {
    let n = 0
    for (const key of [...this.active.keys()]) {
      this.preserveOnAbort.add(key)   // consumed by wrapCompiled's finally (deleted there)
      if (this.abort(key)) n++
      else this.preserveOnAbort.delete(key)
    }
    return n
  }

  /**
   * Teardown for `Bot.stop()`: {@link abortAll} (checkpoints preserved) and refuse new
   * conversations until {@link open} — `enter()` then resolves at once without running.
   * Returns the number aborted.
   */
  close(): number {
    this.closed = true
    return this.abortAll()
  }

  /** Accept conversations again (`Bot.start()`). */
  open(): void {
    this.closed = false
  }

  /** True between {@link close} and {@link open}. */
  isClosed(): boolean { return this.closed }

  /**
   * Silently abort every active conversation in `chatId` — under `participant` scope that
   * is every participant's conversation in a group — and drop the chat's dormant
   * checkpoints (memory + store). Used by human handoff. Matching is by the runtime's own
   * key grammar (`chatId` or `chatId:sender`); the ids themselves are never parsed.
   * Returns the number of active conversations aborted.
   */
  abortChat(chatId: string): number {
    return this.abortWhere((key) => key === chatId || key.startsWith(`${chatId}:`))
  }

  /**
   * Silently abort every active conversation whose key satisfies `match` and drop the
   * matching dormant checkpoints (memory + store). Used by handoff ({@link abortChat})
   * and subject erasure. Returns the number of active conversations aborted.
   */
  abortWhere(match: (key: string) => boolean): number {
    let n = 0
    for (const key of [...this.active.keys()]) {
      if (match(key) && this.abort(key)) n++
    }
    for (const key of [...this.dormant.keys()]) {
      if (match(key)) this.discardDormant(key)
    }
    return n
  }

  /**
   * Wait for the conversation's next inbound message (used by controls). A conversation has a
   * single pending-wait slot: a wait started while another is pending (an un-awaited `c.ask()`
   * or `c.retry()`…) is refused with {@link ConcurrentWaitError} — the pending wait keeps it.
   */
  wait(handle: ConversationHandle, opts: ResolvedWaitOptions = {}): Promise<RuntimeMessage> {
    const entry = handle as ActiveConversation
    if (this.active.get(entry.key) !== entry || entry.cancelled) {
      return Promise.reject(entry.cancelled ?? new ConversationCancelled(true))
    }
    if (entry.pending) return Promise.reject(new ConcurrentWaitError())
    const interrupted = takeInterrupt(entry)
    if (interrupted) return Promise.reject(interrupted)
    // A handover prompt-skip applies to the first wait only, whichever control started it.
    entry.handover = false
    if (entry.cp) entry.waits = (entry.waits ?? 0) + 1
    // A buffered message that already satisfies the filter must be consumed —
    // previously a filtered wait skipped the inbox entirely and only looked at
    // FUTURE messages, silently dropping an in-flight answer. With no filter it
    // stays FIFO (shift the oldest).
    let queued: RuntimeMessage | undefined
    if (opts.filter) {
      const idx = entry.inbox.findIndex((m) => opts.filter!(m))
      if (idx >= 0) queued = entry.inbox.splice(idx, 1)[0]
    } else {
      queued = entry.inbox.shift()
    }
    if (queued) {
      const cause = this.bufferedCauses.get(queued)
      if (cause && entry.cause) entry.cause.ref = cause
      const marked = this.markParked(entry, false, queued)
      return marked ? marked.then(() => queued) : Promise.resolve(queued)
    }
    // The step fed by these events reached its wait: they settle (their inbox records are
    // acknowledged) — with coordination, only once the parked marker / stub below landed, so
    // a crash in between replays them instead of losing the marker.
    const idle = this.detachIdle(entry)

    return new Promise<RuntimeMessage>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.cfg.defaultTimeoutMs ?? 300_000
      // Settling (answer, timeout, abort, interrupt) frees the slot only while it still holds
      // THIS wait, so a stale timer can never clear a newer wait.
      const release = () => {
        if (pending.timer) clearTimeout(pending.timer)
        if (entry.pending === pending) entry.pending = undefined
      }
      const pending: PendingWait = {
        filter: opts.filter,
        accepts: opts.accepts,
        resolve: (ctx) => {
          release()
          // The answered wait no longer parks the flow: its marker must not outlive it. The
          // first wait of a step records its answer, in case the step is cut short.
          const marked = this.markParked(entry, false, ctx)
          if (marked) void marked.then(() => resolve(ctx))
          else resolve(ctx)
        },
        reject: (err) => { release(); reject(err) },
      }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.runTimer(entry, () => {
            if (entry.pending !== pending) return
            if (entry.trace) this.cfg.tracing!.resume(entry.trace, 'timeout')
            pending.reject(new ConversationTimeout())
          })
        }, timeoutMs)
      }
      entry.pending = pending
      if (entry.trace) this.cfg.tracing!.park(entry.trace)
      const parking = { timeoutMs: opts.timeoutMs }
      const marked = this.markParked(entry, entry.waits === 1, undefined, parking) ?? this.writeStub(entry, parking.timeoutMs)
      this.settleAfter(idle, marked, () => 'settled')
      if (this.settleWaiters.size > 0) this.notifySettled(entry.key)
    })
  }

  /**
   * Run timer-driven work of `handle`'s conversation (a wait timeout, a `c.idle()`
   * callback): directly, or under the chat's turn with {@link RuntimeConfig.timerGate}.
   * `fire` is skipped when the conversation is no longer live by then.
   */
  runTimer(handle: ConversationHandle, fire: () => unknown): void {
    const entry = handle as ActiveConversation
    const gate = this.cfg.timerGate
    if (!gate) { void fire(); return }
    const ctx = entry.latest ?? entry.life?.info.ctx
    if (!ctx) { void fire(); return }
    gate(entry.key, ctx, () => (this.isAlive(entry) ? fire() : undefined))
  }

  /**
   * `trackParked`: keep the stored checkpoint's {@link FlowCheckpoint.parked} marker equal to
   * `parked`, and its {@link FlowCheckpoint.answer} equal to the answer of the step's FIRST
   * wait (`answerOf`, when that wait was just satisfied); a later wait of the step drops the
   * answer (the step then re-runs from its start on another replica). Writes of one
   * conversation are chained, and the turn is not released (see {@link whenSettled}) until
   * they landed. Resolves when this one did; `undefined` when nothing had to be written.
   *
   * `parking`: the step is parking on a wait (with its explicit timeout, if any). An
   * ephemeral checkpoint (`handover.flows: 'forward'`) then stays resumable at least as long
   * as that wait (`max(ttl, timeout)` from now), refreshed at every wait that would outlive
   * it: a validation-retry loop writes nothing else.
   */
  private markParked(
    entry: ActiveConversation, parked: boolean, answerOf?: RuntimeMessage, parking?: { timeoutMs?: number },
  ): Promise<void> | undefined {
    const store = this.store
    const current = entry.cp
    if (!this.cfg.trackParked || !store || !current) return undefined
    const answer = answerOf && entry.waits === 1 ? this.captureAnswer(entry, answerOf) : undefined
    const dropAnswer = current.answer !== undefined && answer === undefined && entry.waits !== 1
    const h = this.cfg.handover
    const meta = current.handover?.kind === 'ephemeral' && h ? current.handover : undefined
    const now = Date.now()
    const lifeMs = h ? Math.max(h.ttlMs, parking?.timeoutMs ?? 0) : 0
    const refresh = meta !== undefined && parking !== undefined && meta.expiresAt - now < lifeMs
    if (answer === undefined && !dropAnswer && !refresh && (current.parked === true) === parked) return undefined
    const cp: FlowCheckpoint = { ...current, parked, ...this.traceField(entry) }
    if (answer) cp.answer = answer
    else if (dropAnswer) delete cp.answer
    if (meta && h) cp.handover = { ...meta, expiresAt: now + (parking ? lifeMs : h.ttlMs) }
    entry.cp = cp
    return this.chainWrite(entry, () => store.setCheckpoint(entry.key, cp), 'checkpoint marker write failed')
  }

  /** The answer `ctx` of `entry`'s current step's first wait, as recorded in its checkpoint. */
  private captureAnswer(entry: ActiveConversation, ctx: RuntimeMessage): CheckpointAnswer | undefined {
    const codec = this.cfg.answers
    if (!codec) return undefined
    const ref = entry.cause?.ref
    let captured: Omit<CheckpointAnswer, 'cause' | 'at'> | undefined
    try {
      captured = codec.capture(ctx, ref?.id)
    } catch (error) {
      this.cfg.logger?.debug?.('hand-over answer not recorded', error)
    }
    if (!captured) return undefined
    return { ...captured, ...(ref ? { cause: { id: ref.id, seq: ref.seq } } : {}), at: Date.now() }
  }

  /**
   * Tracing: `{ trace }` — the W3C context of `entry`'s current (or last parked) turn — to
   * spread into a checkpoint or stub it writes. When that turn has no carriable context
   * (a tracer without W3C ids, a throwing `carry`), `previous` (the trace the stored
   * checkpoint or stub already holds) is kept rather than dropped; `{}` if neither.
   */
  private traceField(entry: ActiveConversation | undefined, previous?: CheckpointTrace): { trace?: CheckpointTrace } {
    const hooks = this.cfg.tracing
    let trace: CheckpointTrace | undefined
    if (hooks?.carry && entry?.trace) {
      try { trace = hooks.carry(entry.trace) } catch { /* telemetry never breaks a checkpoint */ }
    }
    trace ??= previous
    return trace ? { trace } : {}
  }

  /**
   * `handover.fallback`: write (or refresh) the stub of a conversation that keeps no
   * checkpoint, when it parks on a wait. A stub lives twice `max(ttl, the wait's explicit
   * timeout)` and is refreshed once less than one such period is left, so it always
   * outlives the wait it parks on.
   */
  private writeStub(entry: ActiveConversation, waitTimeoutMs?: number): Promise<void> | undefined {
    const h = this.cfg.handover
    const store = this.store
    const life = entry.life
    if (!entry.wantsStub || !h || !store || !life) return undefined
    const now = Date.now()
    const lifeMs = Math.max(h.ttlMs, waitTimeoutMs ?? 0)
    // Tracing: the stub carries the context of the LAST turn that parked, so a still-fresh
    // stub is rewritten when that context changed (never without tracing).
    const carried = this.traceField(entry, entry.stub?.trace)
    const sameTrace = entry.stub?.trace?.traceparent === carried.trace?.traceparent
      && entry.stub?.trace?.tracestate === carried.trace?.tracestate
    if (entry.stub && entry.stub.handover!.expiresAt - now > lifeMs && sameTrace) return undefined
    const stub: FlowCheckpoint = {
      flowId: life.info.name,
      step: -1,
      state: {},
      updatedAt: now,
      handover: {
        kind: 'stub',
        expiresAt: now + 2 * lifeMs,
        name: life.info.name,
        startedAt: life.startedAt,
        ...(entry.startState ? { startState: entry.startState } : {}),
      },
      ...carried,
    }
    entry.stub = stub
    entry.stubbed = true
    return this.chainWrite(entry, () => store.setCheckpoint(entry.key, stub), 'hand-over stub write failed', () => {
      if (entry.stub === stub) entry.stub = undefined
    })
  }

  /** Clear `entry`'s stub (if one was written), after any write of it still in flight. */
  private dropStub(entry: ActiveConversation): void {
    if (!entry.stubbed) return
    entry.stubbed = false
    entry.stub = undefined
    this.queueClear(entry.key, entry.parking, true)
  }

  /**
   * Chain one checkpoint write of `entry` after its previous ones (and after a clear of its
   * key still in flight). Fenced (coordination). Never rejects: a failure is logged and marks
   * the entry dirty (a suspension then releases the inbox records it fed instead of
   * acknowledging them).
   */
  private chainWrite(entry: ActiveConversation, write: () => Promise<void>, failure: string, onFail?: () => void): Promise<void> {
    const key = entry.key
    const done: Promise<void> = Promise.all([entry.parking, this.pendingClears.get(key)])
      .then(() => { this.cfg.fence?.(key); return write() })
      .then(
        () => { entry.cpDirty = false },
        (error: unknown) => {
          entry.cpDirty = true
          onFail?.()
          if (error instanceof LeaseLostError) this.cfg.logger?.debug?.(`${failure}: chat turn lost`, { key })
          else this.cfg.logger?.warn?.(failure, error)
        },
      )
      .finally(() => {
        if (entry.parking !== done) return
        entry.parking = undefined
        if (this.settleWaiters.size > 0) this.notifySettled(key)
      })
    entry.parking = done
    return done
  }

  /**
   * The most recent inbound message routed to the conversation of `handle` (the one that
   * entered it until another arrives), or `undefined` when none was delivered yet. Used
   * by `c.t` so a language switch mid-conversation is honoured.
   */
  latestMessage(handle: ConversationHandle): RuntimeMessage | undefined {
    return (handle as ActiveConversation).latest
  }

  getState(handle: ConversationHandle): Record<string, unknown> {
    return (handle as ActiveConversation).state
  }

  /**
   * Throws if `handle` is no longer the live entry for its key (aborted/replaced).
   * Controls call this before emitting any output, so a cancelled conversation
   * cannot produce further side effects — it unwinds silently instead.
   */
  /** `true` while `handle` is the live, non-cancelled entry for its key (no side effects). */
  isAlive(handle: ConversationHandle): boolean {
    const entry = handle as ActiveConversation
    return this.active.get(entry.key) === entry && !entry.cancelled
  }

  assertAlive(handle: ConversationHandle): void {
    const entry = handle as ActiveConversation
    if (this.active.get(entry.key) !== entry || entry.cancelled) {
      throw entry.cancelled ?? new ConversationCancelled(true)
    }
    const interrupted = takeInterrupt(entry)
    if (interrupted) throw interrupted
  }

  /**
   * Observe one live conversation (inbound activity + end). Returns an unsubscribe; a
   * handle that is no longer live gets a no-op subscription. `end` fires exactly once,
   * on completion, error, abort or replacement — so observers never outlive the entry.
   */
  observe(handle: ConversationHandle, observer: ConversationObserver): () => void {
    const entry = handle as ActiveConversation
    if (this.active.get(entry.key) !== entry || entry.cancelled) return () => {}
    const observers = (entry.observers ??= new Set())
    observers.add(observer)
    return () => { observers.delete(observer) }
  }

  /**
   * Steer a live conversation from OUTSIDE its call stack (e.g. an idle callback calling
   * `c.end()`/`c.goto()`): `error` rejects the pending wait, or — if the conversation is busy —
   * is thrown at its next wait/`say`. It then unwinds through the normal ending path
   * (farewell, goto, timeout/retries messages). Returns false if the handle is not live.
   */
  interrupt(handle: ConversationHandle, error: Error): boolean {
    const entry = handle as ActiveConversation
    if (this.active.get(entry.key) !== entry || entry.cancelled) return false
    if (entry.pending) {
      // An idle callback already runs in its own turn (runIdle): the conversation unwinds in it.
      if (entry.trace && entry.idleTurn !== entry.pending) this.cfg.tracing!.resume(entry.trace, 'idle')
      entry.pending.reject(error)
    } else entry.interrupted = error
    return true
  }

  /**
   * Run out-of-band work of `handle`'s conversation (a `c.idle()` callback). Traced, it
   * runs inside the conversation's box: while the conversation is parked on a wait it gets
   * its own ROOT turn (`reason: idle`, linked to the first one), parked again afterwards
   * unless the callback ended/redirected the conversation or a reply resumed it; while
   * the conversation is busy, its work lands under the running turn. Untraced: `fn()`.
   */
  runIdle(handle: ConversationHandle, fn: () => Promise<void>): Promise<void> {
    const entry = handle as ActiveConversation
    const tracing = this.cfg.tracing
    const trace = entry.trace
    if (!tracing || !trace) return fn()
    const pending = entry.pending
    if (!pending || !this.isAlive(entry)) return tracing.run(trace, fn)
    tracing.resume(trace, 'idle')
    entry.idleTurn = pending
    return tracing.run(trace, fn).finally(() => {
      if (entry.idleTurn === pending) entry.idleTurn = undefined
      // Still parked on the same wait (the callback only replied or re-prompted): park the idle turn.
      if (entry.pending === pending && this.isAlive(entry)) tracing.park(trace)
    })
  }

  /** Report an error raised outside a conversation's own flow (idle callbacks) via `onError`. */
  reportError(error: unknown, ctx: RuntimeMessage): void {
    this.cfg.onError?.(error, ctx)
    this.cfg.logger?.error?.('conversation error', error)
  }

  /** Report `entry`'s end to the lifecycle observer exactly once. */
  private reportEnd(entry: ActiveConversation, outcome: ConversationOutcome, goto?: string): void {
    const life = entry.life
    if (!life || life.ended) return
    life.ended = true
    if (entry.trace) this.cfg.tracing!.end(entry.trace, outcome, goto)
    const info: ConversationEndInfo = { ...life.info, outcome, durationMs: Date.now() - life.startedAt }
    if (goto !== undefined) info.goto = goto
    this.notifyLifecycle(() => this.cfg.onConversationEnd?.(info))
  }

  private notifyLifecycle(fn: () => void): void {
    try { fn() } catch (e) { this.cfg.logger?.warn?.('conversation lifecycle observer failed', e) }
  }

  private notifyEnd(entry: ActiveConversation): void {
    const observers = entry.observers
    entry.observers = undefined
    for (const o of observers ?? []) { try { o.end?.() } catch { /* observers must not break teardown */ } }
  }

  /** Durability: the step now starting (entry or delivery) settles when the conversation next blocks or ends. */
  private trackIdle(entry: ActiveConversation): void {
    if (!hasCause()) return
    trackSettle(new Promise<SettleOutcome>((resolve) => { (entry.idle ??= []).push(resolve) }))
  }

  private settleIdle(entry: ActiveConversation, outcome: SettleOutcome): void {
    this.settleAfter(this.detachIdle(entry), undefined, () => outcome)
  }

  /** Take the pending settles of `entry` (later deliveries register new ones). */
  private detachIdle(entry: ActiveConversation): Array<(outcome: SettleOutcome) => void> | undefined {
    const idle = entry.idle
    entry.idle = undefined
    return idle
  }

  /** Resolve `idle` with `outcome()` — at once, or once `after` (a checkpoint write) settled. */
  private settleAfter(
    idle: Array<(outcome: SettleOutcome) => void> | undefined,
    after: Promise<void> | undefined,
    outcome: () => SettleOutcome,
  ): void {
    if (!idle) return
    const resolveAll = () => { const o = outcome(); for (const resolve of idle) resolve(o) }
    if (after) void after.then(resolveAll)
    else resolveAll()
  }

  private cleanup(entry: ActiveConversation, settled = true): void {
    // Torn down by stop(): the step did not complete — its inbound must be replayed, not acknowledged.
    this.settleIdle(entry, this.closed ? 'aborted' : 'settled')
    // Hand-over stub: dropped when the conversation is over, kept when it was suspended/stopped.
    if (!entry.preserved) this.dropStub(entry)
    if (entry.pending?.timer) clearTimeout(entry.pending.timer)
    if (this.active.get(entry.key) === entry) this.active.delete(entry.key)
    // A shutdown-preserve flag is consumed by a persistent flow's own unwind (wrapCompiled);
    // any other conversation never reads it, so drop it here unless a newer conversation
    // already owns the key (one started after the abort deleted the flag itself anyway).
    if (!this.active.has(entry.key)) this.preserveOnAbort.delete(entry.key)
    this.notifyEnd(entry)
    if (settled && this.settleWaiters.size > 0) this.notifySettled(entry.key)
  }

  /**
   * A built-in end-of-conversation reply (farewell, timeout, retries, error). Traced:
   * sent from the conversation's own box, so it lands under its last turn. Not `async`:
   * untraced, it returns {@link safeReply}'s own promise.
   */
  private endReply(entry: ActiveConversation, ctx: RuntimeMessage, text: string): Promise<void> {
    return this.inBox(entry, () => this.safeReply(ctx, text))
  }

  /** Traced: run `fn` inside `entry`'s conversation box (its current turn); untraced: `fn()`. */
  private inBox<T>(entry: ActiveConversation, fn: () => T): T {
    return entry.trace ? this.cfg.tracing!.run(entry.trace, fn) : fn()
  }

  private async safeReply(ctx: RuntimeMessage, text: string): Promise<void> {
    try { await ctx.reply(text) } catch (e) { this.cfg.logger?.warn?.('reply failed', e) }
  }
}

function takeInterrupt(entry: ActiveConversation): Error | undefined {
  const e = entry.interrupted
  entry.interrupted = undefined
  return e
}

function interruptedOf(
  key: string, name: string, reason: InterruptedConversation['reason'], meta: NonNullable<FlowCheckpoint['handover']>,
  trace?: CheckpointTrace,
): InterruptedConversation {
  return {
    name,
    key,
    reason,
    ...(meta.startedAt !== undefined ? { startedAt: meta.startedAt } : {}),
    ...(meta.startState ? { startState: { ...meta.startState } } : {}),
    ...(trace ? { trace: { ...trace } } : {}),
  }
}

function defaultControlsFactory(rt: ConversationRuntime, handle: ConversationHandle, ctx: RuntimeMessage): ConversationControlsBase {
  return {
    waitAny: (opts) => rt.wait(handle, { accepts: 'any', ...opts }),
    say: async (text) => { await ctx.reply(text) },
    state: rt.getState(handle),
    end: (farewell) => { throw new ConversationEnded(farewell) },
  }
}
