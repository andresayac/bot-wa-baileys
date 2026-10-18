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
  /** Keys whose persistent checkpoint must NOT be cleared on unwind (shutdown teardown). */
  private preserveOnAbort = new Set<string>()
  /** Registration history for introspection — see {@link listRegistrations}. */
  private registrations: ConversationRegistration[] = []

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

  private wrapCompiled(flow: CompiledFlow, startAt = 0): ConversationFn {
    if (!flow.opts.persistent || !this.store) {
      return startAt === 0
        ? flowToConversation(flow)
        : async (c, ctx) => { await runSteps(flow, ctx, c as ConversationControls, startAt) }
    }
    return async (c, ctx) => {
      const key = this.keyFor(ctx)
      try {
        await runSteps(flow, ctx, c as ConversationControls, startAt, async (stepIndex) => {
          await this.store!.setCheckpoint(key, {
            flowId: flow.id,
            step: stepIndex + 1,
            state: { ...(c as ConversationControls).state },
            updatedAt: Date.now(),
          })
        })
      } finally {
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

  /** Loads all persisted checkpoints into the dormant map; call once at startup (Bot.start()). */
  async loadDormant(): Promise<void> {
    if (!this.store) return
    for (const [key, cp] of await this.store.listCheckpoints()) this.dormant.set(key, cp)
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
    const flow = this.compiled.get(cp.flowId)
    if (!flow) { await this.store?.clearCheckpoint(key).catch(() => {}); return false }
    const resumed: ConversationFn = async (c, rctx) => {
      Object.assign((c as ConversationControlsBase).state, cp.state)
      await this.wrapCompiled(flow, cp.step)(c, rctx)
    }
    // enter() is fire-and-forget (it only resolves when the resumed flow ends); a rejection
    // here (e.g. a bad goto target) would otherwise become an unhandled rejection → crash.
    void this.enter(resumed, ctx, { name: cp.flowId }).catch((e) => {
      this.cfg.onError?.(e, ctx)
      this.cfg.logger?.error?.('resume failed', e)
    })
    return true
  }

  keyFor(ctx: Pick<RuntimeMessage, 'from' | 'sender' | 'isGroup'>): string {
    const scope = this.cfg.scope ?? 'participant'
    return ctx.isGroup && scope === 'participant' ? `${ctx.from}:${ctx.sender}` : ctx.from
  }

  hasActive(key: string): boolean { return this.active.has(key) }

  /** Drop `key`'s dormant checkpoint (memory + store). Returns whether one existed. */
  discardDormant(key: string): boolean {
    if (!this.dormant.delete(key)) return false
    void this.store?.clearCheckpoint(key).catch(() => {})
    return true
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

    const key = this.keyFor(ctx)
    // A fresh conversation on this key must not inherit a stale shutdown-preserve flag
    // (relevant when the runtime is reused across a stop()/start() cycle).
    this.preserveOnAbort.delete(key)
    if (this.active.has(key)) this.abort(key)

    const entry: ActiveConversation = { key, state: opts.state ? { ...opts.state } : {}, inbox: [], ...(latest ? { latest } : {}) }
    this.active.set(key, entry)
    const startInfo: ConversationStartInfo = { id: randomId('conv'), name, key, ctx }
    entry.life = { info: startInfo, startedAt: Date.now(), ended: false }
    this.notifyLifecycle(() => this.cfg.onConversationStart?.(startInfo))

    const controls = (this.cfg.controlsFactory ?? defaultControlsFactory)(this, entry, ctx)

    let goto: ConversationGoto | undefined
    let outcome: ConversationOutcome = 'completed'
    try {
      await fn(controls as never, ctx)
    } catch (e) {
      if (entry.cancelled) {
        // Conversación reemplazada/abortada: muere en silencio, sin efectos visibles.
        outcome = 'cancelled'
      } else if (e instanceof ConversationEnded) {
        outcome = e.guarded ? 'guarded' : 'ended'
        if (e.farewell) await this.safeReply(ctx, e.farewell)
      } else if (e instanceof ConversationGoto) {
        if (e.guarded) outcome = 'guarded'
        goto = e
      } else if (e instanceof ConversationTimeout) {
        outcome = 'timedOut'
        await this.safeReply(ctx, this.cfg.timeoutMessage ?? translateFor(entry.latest ?? ctx, CORE_MESSAGES.timeout))
      } else if (e instanceof ConversationCancelled) {
        outcome = 'cancelled'
        if (!e.silent && this.cfg.cancelledMessage) await this.safeReply(ctx, this.cfg.cancelledMessage)
      } else if (e instanceof RetriesExceeded) {
        outcome = 'retriesExceeded'
        await this.safeReply(ctx, this.cfg.retriesMessage ?? translateFor(entry.latest ?? ctx, CORE_MESSAGES.retries))
      } else {
        outcome = 'error'
        this.cfg.onError?.(e, ctx)
        this.cfg.logger?.error?.('conversation error', e)
        await this.safeReply(ctx, this.cfg.errorMessage ?? translateFor(entry.latest ?? ctx, CORE_MESSAGES.error))
      }
    } finally {
      this.cleanup(entry)
      // An aborted conversation already reported its end (as cancelled) from abort().
      this.reportEnd(entry, entry.cancelled ? 'cancelled' : outcome, entry.cancelled ? undefined : goto?.target)
    }
    if (goto && !entry.cancelled) await this.run(goto.target, ctx, {}, entry.latest)
  }

  deliver(ctx: RuntimeMessage): boolean {
    const entry = this.active.get(this.keyFor(ctx))
    if (!entry) return false
    entry.latest = ctx
    if (entry.observers) for (const o of [...entry.observers]) { try { o.inbound?.(ctx) } catch { /* observers must not break delivery */ } }
    if (entry.pending) {
      if (entry.pending.filter && !entry.pending.filter(ctx)) return false
      entry.pending.resolve(ctx)
      return true
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
   * Silently abort every active conversation in `chatId` — under `participant` scope that
   * is every participant's conversation in a group — and drop the chat's dormant
   * checkpoints (memory + store). Used by human handoff. Matching is by the runtime's own
   * key grammar (`chatId` or `chatId:sender`); the ids themselves are never parsed.
   * Returns the number of active conversations aborted.
   */
  abortChat(chatId: string): number {
    const inChat = (key: string) => key === chatId || key.startsWith(`${chatId}:`)
    let n = 0
    for (const key of [...this.active.keys()]) {
      if (inChat(key) && this.abort(key)) n++
    }
    for (const key of [...this.dormant.keys()]) {
      if (!inChat(key)) continue
      this.dormant.delete(key)
      void this.store?.clearCheckpoint(key).catch(() => {})
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
    if (queued) return Promise.resolve(queued)

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
        resolve: (ctx) => { release(); resolve(ctx) },
        reject: (err) => { release(); reject(err) },
      }
      if (timeoutMs > 0) pending.timer = setTimeout(() => pending.reject(new ConversationTimeout()), timeoutMs)
      entry.pending = pending
    })
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
    if (entry.pending) entry.pending.reject(error)
    else entry.interrupted = error
    return true
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

  private cleanup(entry: ActiveConversation): void {
    if (entry.pending?.timer) clearTimeout(entry.pending.timer)
    if (this.active.get(entry.key) === entry) this.active.delete(entry.key)
    this.notifyEnd(entry)
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
