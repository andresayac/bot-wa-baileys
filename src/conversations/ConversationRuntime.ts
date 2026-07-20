import {
  ConversationCancelled, ConversationEnded, ConversationGoto,
  ConversationTimeout, RetriesExceeded,
} from './errors.js'

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

export class ConversationRuntime {
  private registry = new Map<string, ConversationFn>()
  private active = new Map<string, ActiveConversation>()

  constructor(private cfg: RuntimeConfig = {}) {}

  register(name: string, fn: ConversationFn): void { this.registry.set(name, fn) }
  has(name: string): boolean { return this.registry.has(name) }

  keyFor(ctx: Pick<RuntimeMessage, 'from' | 'sender' | 'isGroup'>): string {
    const scope = this.cfg.scope ?? 'participant'
    return ctx.isGroup && scope === 'participant' ? `${ctx.from}:${ctx.sender}` : ctx.from
  }

  hasActive(key: string): boolean { return this.active.has(key) }

  async enter(nameOrFn: string | ConversationFn, ctx: RuntimeMessage): Promise<void> {
    const fn = typeof nameOrFn === 'string' ? this.registry.get(nameOrFn) : nameOrFn
    if (!fn) throw new Error(`Conversation "${String(nameOrFn)}" is not registered`)

    const key = this.keyFor(ctx)
    if (this.active.has(key)) this.abort(key)

    const entry: ActiveConversation = { key, state: {}, inbox: [] }
    this.active.set(key, entry)

    const controls = (this.cfg.controlsFactory ?? defaultControlsFactory)(this, entry, ctx)

    let goto: ConversationGoto | undefined
    try {
      await fn(controls as never, ctx)
    } catch (e) {
      if (e instanceof ConversationEnded) {
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
    if (goto) await this.enter(goto.target, ctx)
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

  /** Usado por controls. */
  wait(handle: ConversationHandle, opts: ResolvedWaitOptions = {}): Promise<RuntimeMessage> {
    const entry = handle as ActiveConversation
    if (this.active.get(entry.key) !== entry || entry.cancelled) {
      return Promise.reject(entry.cancelled ?? new ConversationCancelled(true))
    }
    const queued = opts.filter ? undefined : entry.inbox.shift()
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
