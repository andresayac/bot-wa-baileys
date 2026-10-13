import {
  ConversationCancelled, ConversationEnded, ConversationGoto,
  ConversationTimeout, RetriesExceeded,
} from './errors.js'
import type { CompiledFlow } from '../flows/FlowBuilder.js'
import { flowToConversation, runSteps } from './interpreter.js'
import type { ConversationControls } from './controls.js'
import type { FlowCheckpoint } from '../store/IStore.js'

export interface RuntimeMessage {
  from: string; sender: string; body: string; type: string; isGroup: boolean
  reply(text: string): Promise<unknown>
}

export interface ResolvedWaitOptions {
  timeoutMs?: number
  filter?: (ctx: RuntimeMessage) => boolean
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
}

interface PendingWait {
  resolve(ctx: RuntimeMessage): void
  reject(err: Error): void
  filter?: (ctx: RuntimeMessage) => boolean
  timer?: NodeJS.Timeout
}

interface ActiveConversation extends ConversationHandle {
  state: Record<string, unknown>
  inbox: RuntimeMessage[]
  pending?: PendingWait
  cancelled?: ConversationCancelled
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
}

export class ConversationRuntime {
  private registry = new Map<string, ConversationFn>()
  private active = new Map<string, ActiveConversation>()
  private compiled = new Map<string, CompiledFlow>()
  private store?: CheckpointStore
  private dormant = new Map<string, FlowCheckpoint>()
  /** Keys whose persistent checkpoint must NOT be cleared on unwind (shutdown teardown). */
  private preserveOnAbort = new Set<string>()

  constructor(private cfg: RuntimeConfig = {}) {}

  register(name: string, fn: ConversationFn): void { this.registry.set(name, fn) }
  has(name: string): boolean { return this.registry.has(name) }

  /** Wires a checkpoint-capable store; required for `persistent()` flows to actually persist. */
  attachStore(store: CheckpointStore): void { this.store = store }

  /** Registers a compiled DSL flow by its `flow.id`, wrapping it with checkpoint support when persistent. */
  registerCompiled(flow: CompiledFlow): void {
    this.compiled.set(flow.id, flow)
    this.register(flow.id, this.wrapCompiled(flow))
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
    void this.enter(resumed, ctx).catch((e) => {
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

  /** Snapshot of the live conversation on `key`, or `undefined` when none is active. Never mutates it. */
  inspect(key: string): ConversationSnapshot | undefined {
    const entry = this.active.get(key)
    if (!entry) return undefined
    return { key, state: { ...entry.state }, waiting: entry.pending !== undefined, queued: entry.inbox.length }
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

  async enter(nameOrFn: string | ConversationFn, ctx: RuntimeMessage): Promise<void> {
    const fn = typeof nameOrFn === 'string' ? this.registry.get(nameOrFn) : nameOrFn
    if (!fn) throw new Error(`Conversation "${String(nameOrFn)}" is not registered`)

    const key = this.keyFor(ctx)
    // A fresh conversation on this key must not inherit a stale shutdown-preserve flag
    // (relevant when the runtime is reused across a stop()/start() cycle).
    this.preserveOnAbort.delete(key)
    if (this.active.has(key)) this.abort(key)

    const entry: ActiveConversation = { key, state: {}, inbox: [] }
    this.active.set(key, entry)

    const controls = (this.cfg.controlsFactory ?? defaultControlsFactory)(this, entry, ctx)

    let goto: ConversationGoto | undefined
    try {
      await fn(controls as never, ctx)
    } catch (e) {
      if (entry.cancelled) {
        // Conversación reemplazada/abortada: muere en silencio, sin efectos visibles.
      } else if (e instanceof ConversationEnded) {
        if (e.farewell) await this.safeReply(ctx, e.farewell)
      } else if (e instanceof ConversationGoto) {
        goto = e
      } else if (e instanceof ConversationTimeout) {
        await this.safeReply(ctx, this.cfg.timeoutMessage ?? '⏰ La conversación expiró por inactividad.')
      } else if (e instanceof ConversationCancelled) {
        if (!e.silent && this.cfg.cancelledMessage) await this.safeReply(ctx, this.cfg.cancelledMessage)
      } else if (e instanceof RetriesExceeded) {
        await this.safeReply(ctx, this.cfg.retriesMessage ?? '❌ Demasiados intentos. Conversación terminada.')
      } else {
        this.cfg.onError?.(e, ctx)
        this.cfg.logger?.error?.('conversation error', e)
        await this.safeReply(ctx, this.cfg.errorMessage ?? '⚠️ Ocurrió un error. La conversación terminó.')
      }
    } finally {
      this.cleanup(entry)
    }
    if (goto && !entry.cancelled) await this.enter(goto.target, ctx)
  }

  deliver(ctx: RuntimeMessage): boolean {
    const entry = this.active.get(this.keyFor(ctx))
    if (!entry) return false
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

  /** Usado por controls. */
  wait(handle: ConversationHandle, opts: ResolvedWaitOptions = {}): Promise<RuntimeMessage> {
    const entry = handle as ActiveConversation
    if (this.active.get(entry.key) !== entry || entry.cancelled) {
      return Promise.reject(entry.cancelled ?? new ConversationCancelled(true))
    }
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
      const timer = timeoutMs > 0
        ? setTimeout(() => { entry.pending = undefined; reject(new ConversationTimeout()) }, timeoutMs)
        : undefined
      entry.pending = {
        filter: opts.filter,
        resolve: (ctx) => { if (timer) clearTimeout(timer); entry.pending = undefined; resolve(ctx) },
        reject: (err) => { if (timer) clearTimeout(timer); entry.pending = undefined; reject(err) },
        timer,
      }
    })
  }

  getState(handle: ConversationHandle): Record<string, unknown> {
    return (handle as ActiveConversation).state
  }

  /**
   * Throws if `handle` is no longer the live entry for its key (aborted/replaced).
   * Controls call this before emitting any output, so a cancelled conversation
   * cannot produce further side effects — it unwinds silently instead.
   */
  assertAlive(handle: ConversationHandle): void {
    const entry = handle as ActiveConversation
    if (this.active.get(entry.key) !== entry || entry.cancelled) {
      throw entry.cancelled ?? new ConversationCancelled(true)
    }
  }

  private cleanup(entry: ActiveConversation): void {
    if (entry.pending?.timer) clearTimeout(entry.pending.timer)
    if (this.active.get(entry.key) === entry) this.active.delete(entry.key)
  }

  private async safeReply(ctx: RuntimeMessage, text: string): Promise<void> {
    try { await ctx.reply(text) } catch (e) { this.cfg.logger?.warn?.('reply failed', e) }
  }
}

function defaultControlsFactory(rt: ConversationRuntime, handle: ConversationHandle, ctx: RuntimeMessage): ConversationControlsBase {
  return {
    waitAny: (opts) => rt.wait(handle, opts ?? {}),
    say: async (text) => { await ctx.reply(text) },
    state: rt.getState(handle),
    end: (farewell) => { throw new ConversationEnded(farewell) },
  }
}
