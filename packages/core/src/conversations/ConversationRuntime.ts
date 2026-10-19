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
import type { InboundLocation } from '../core/provider.js'
import {
  adoptCause, currentCause, forkCause, hasCause, restoreCause, trackSettle, type CauseBox, type CauseRef, type SettleOutcome,
} from '../durability/causation.js'

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

/** Identidad opaca de una conversación activa; impide que un teardown viejo toque la entry nueva. */
export interface ConversationHandle { readonly key: string }

/** Interfaz mínima; controls.ts (Task 3) la extiende con ask/waitText/choose/... */
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
  begin(info: { id: string; name: string }, reason: 'start' | 'goto' | 'dormant'): ConversationTurnTrace
  run<T>(trace: ConversationTurnTrace, fn: () => T): T
  resume(trace: ConversationTurnTrace, reason: 'reply' | 'timeout' | 'idle' | 'end'): void
  park(trace: ConversationTurnTrace): void
  end(trace: ConversationTurnTrace, outcome: string, goto?: string): void
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
  /** Task 3 inyecta la factory completa de controls; default = base. */
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
  /** Tracing: the conversation's turn spans (see {@link RuntimeConfig.tracing}). */
  trace?: ConversationTurnTrace
  /** Tracing: the wait an idle turn was opened for (see {@link ConversationRuntime.runIdle}). */
  idleTurn?: PendingWait
}

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
  /** Waking message of a handover resume, consumed by the entry {@link run} creates next for its key. */
  private handoverAnswers = new Map<string, RuntimeMessage>()
  /** Durability: the cause of each buffered (not yet consumed) message. */
  private bufferedCauses = new WeakMap<RuntimeMessage, CauseRef>()
  /** Tracing: keys whose next {@link run} resumes a dormant checkpoint (consumed synchronously). */
  private tracedResumes = new Set<string>()

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
    if (!flow.opts.persistent || !this.store) {
      return startAt === 0
        ? flowToConversation(flow)
        : async (c, ctx) => { await runSteps(flow, ctx, c as ConversationControls, startAt) }
    }
    return async (c, ctx) => {
      const key = this.keyFor(ctx)
      const entry = this.active.get(key)
      if (entry && resumedFrom) { entry.cp = resumedFrom; entry.waits = 0 }
      const save = async (step: number) => {
        // A clear of the checkpoint this conversation replaced may still be in flight:
        // let it land first, or it would wipe this conversation's fresh checkpoint.
        await this.pendingClears.get(key)
        await entry?.parking
        const cause = currentCause()
        const cp: FlowCheckpoint = {
          flowId: flow.id,
          step,
          state: { ...(c as ConversationControls).state },
          updatedAt: Date.now(),
          // Durability: the inbound record whose effects this checkpoint captures (the message
          // that entered the flow or that the step consumed — a replay of it is skipped) and
          // where the next step's send keys continue (a re-run step re-derives the same keys).
          ...(cause ? { inboundId: cause.id, cause: { id: cause.id, seq: cause.seq } } : {}),
        }
        await this.store!.setCheckpoint(key, cp)
        if (entry) { entry.cp = cp; entry.waits = 0 }
      }
      try {
        // Durability: checkpoint the entry too, so a crash before the first step completes
        // can resume the flow when the answer that was in flight is replayed.
        if (startAt === 0 && hasCause()) await save(0)
        await runSteps(flow, ctx, c as ConversationControls, startAt, (stepIndex) => save(stepIndex + 1))
      } finally {
        await entry?.parking
        // On a graceful shutdown (abortAll) we KEEP the checkpoint so a restart can resume it.
        // Every other exit (completion, error, timeout, user /reset) clears it.
        if (this.preserveOnAbort.delete(key)) {
          // preserved — leave the persisted checkpoint intact for resume-on-restart
        } else {
          await this.store!.clearCheckpoint(key).catch(() => {})
        }
      }
    }
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
    for (const [key, cp] of checkpoints) this.dormant.set(key, cp)
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
    const flow = this.compiled.get(cp.flowId)
    if (!flow) { await this.store?.clearCheckpoint(key).catch(() => {}); return false }
    // Durability (a cause is active and the checkpoint recorded one): the pending step re-runs
    // under the causation it had, so its prompt — already sent before the restart — is answered
    // from the outbox instead of being repeated, and the waking message is its answer.
    const cause = hasCause() ? cp.cause : undefined
    const resumed: ConversationFn = async (c, rctx) => {
      if (cause) restoreCause(cause)
      Object.assign((c as ConversationControlsBase).state, cp.state)
      await this.wrapCompiled(flow, cp.step, cp)(c, rctx)
    }
    // Durability: a replay of the message this checkpoint already captured is not an answer.
    const replayOfCaptured = cause !== undefined && cp.inboundId === currentCause()?.id
    if (handover && !replayOfCaptured) this.handoverAnswers.set(key, ctx)
    // enter() is fire-and-forget (it only resolves when the resumed flow ends); a rejection
    // here (e.g. a bad goto target) would otherwise become an unhandled rejection → crash.
    if (this.cfg.tracing) this.tracedResumes.add(key)
    void this.enter(resumed, ctx, { name: cp.flowId }).catch((e) => {
      this.cfg.onError?.(e, ctx)
      this.cfg.logger?.error?.('resume failed', e)
    })
    this.handoverAnswers.delete(key)   // consumed synchronously by run(); never left behind
    if (this.cfg.tracing) this.tracedResumes.delete(key)
    // Durability: the waking message answers the re-run step (a handover already queued it as
    // the parked wait's answer) — unless the checkpoint already captured this very message (a
    // replay after the step that consumed it): the flow then only re-runs its pending steps.
    if (cause && !handover && !replayOfCaptured) this.deliver(ctx)
    return true
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
    if (this.store) {
      // Tracked per key so a persistent flow entered right after this waits for the clear
      // before writing its own checkpoint (async stores do not order the two writes).
      const clear: Promise<void> = Promise.resolve(this.pendingClears.get(key))
        .then(() => this.store?.clearCheckpoint(key))
        .catch(() => {})
        .finally(() => { if (this.pendingClears.get(key) === clear) this.pendingClears.delete(key) })
      this.pendingClears.set(key, clear)
    }
    return true
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
    const answer = this.handoverAnswers.get(key)
    if (answer) {
      // Multi-replica handover resume: the waking message answers the parked wait.
      this.handoverAnswers.delete(key)
      entry.handover = true
      entry.inbox.push(answer)
      entry.latest = answer
    }
    this.active.set(key, entry)
    this.trackIdle(entry)
    const startInfo: ConversationStartInfo = { id: randomId('conv'), name, key, ctx }
    entry.life = { info: startInfo, startedAt: Date.now(), ended: false }
    this.notifyLifecycle(() => this.cfg.onConversationStart?.(startInfo))
    const tracing = this.cfg.tracing
    if (tracing) {
      const reason = latest ? 'goto' : this.tracedResumes.delete(key) ? 'dormant' : 'start'
      entry.trace = tracing.begin({ id: startInfo.id, name }, reason)
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
        // Conversación reemplazada/abortada: muere en silencio, sin efectos visibles.
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
    if (entry.pending) entry.pending.reject(cancel)
    // A step still running is never resumed: its fed events settle now (as 'aborted' on stop()).
    this.settleIdle(entry, this.closed ? 'aborted' : 'settled')
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
      const marked = this.markParked(entry, false)
      return marked ? marked.then(() => queued) : Promise.resolve(queued)
    }
    this.settleIdle(entry, 'settled')

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
          // The answered wait no longer parks the flow: its marker must not outlive it.
          const marked = this.markParked(entry, false)
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
      this.markParked(entry, entry.waits === 1)
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
   * `trackParked`: write {@link FlowCheckpoint.parked} = `parked` when it differs from the
   * stored checkpoint. Writes of one conversation are chained, and the turn is not
   * released (see {@link whenSettled}) until they landed. Resolves when this one did.
   */
  private markParked(entry: ActiveConversation, parked: boolean): Promise<void> | undefined {
    const store = this.store
    if (!this.cfg.trackParked || !store || !entry.cp) return undefined
    if ((entry.cp.parked === true) === parked) return undefined
    const cp: FlowCheckpoint = { ...entry.cp, parked }
    entry.cp = cp
    const write: Promise<void> = Promise.resolve(entry.parking)
      .then(() => store.setCheckpoint(entry.key, cp))
      .catch((error: unknown) => { this.cfg.logger?.warn?.('checkpoint marker write failed', error) })
      .finally(() => {
        if (entry.parking !== write) return
        entry.parking = undefined
        if (this.settleWaiters.size > 0) this.notifySettled(entry.key)
      })
    entry.parking = write
    return write
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
    const idle = entry.idle
    if (!idle) return
    entry.idle = undefined
    for (const resolve of idle) resolve(outcome)
  }

  private cleanup(entry: ActiveConversation, settled = true): void {
    // Torn down by stop(): the step did not complete — its inbound must be replayed, not acknowledged.
    this.settleIdle(entry, this.closed ? 'aborted' : 'settled')
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

function defaultControlsFactory(rt: ConversationRuntime, handle: ConversationHandle, ctx: RuntimeMessage): ConversationControlsBase {
  return {
    waitAny: (opts) => rt.wait(handle, { accepts: 'any', ...opts }),
    say: async (text) => { await ctx.reply(text) },
    state: rt.getState(handle),
    end: (farewell) => { throw new ConversationEnded(farewell) },
  }
}
