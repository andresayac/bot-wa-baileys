import type { Trigger } from './types.js'
import type { MessageType } from './provider.js'
import { matchTrigger, triggerSpecificity, normalizeText } from './matching.js'
import { isTypeTrigger, isWelcomeTrigger, typeTrigger } from './triggers.js'
import { WelcomeTracker } from './welcome.js'
import type { ConversationRuntime, RuntimeMessage } from '../conversations/ConversationRuntime.js'

export interface DispatchContext extends RuntimeMessage {
  pass(): void
  abort(): void
  _passed?: boolean
  _aborted?: boolean
}
export type MessageHandler = (ctx: DispatchContext) => unknown | Promise<unknown>
export type CommandHandler = (ctx: DispatchContext, args: string[]) => unknown | Promise<unknown>

export interface HooksLike {
  runBefore(event: string, ctx: unknown): Promise<boolean>
  runAfter(event: string, ctx: unknown): Promise<void>
  runError(event: string, ctx: unknown, err: unknown): Promise<void>
}

export interface DispatcherDeps {
  hooks: HooksLike
  runtime: ConversationRuntime
  commandPrefix?: string
  logger?: { debug?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void }
  /** Emit an event; returns `true` when the event had listeners (mirrors `EventEmitter.emit`). */
  emit: (event: string, payload: unknown) => boolean
  /**
   * Optional routing gate (human handoff). Evaluated AFTER `before('message')` hooks and
   * BEFORE any routing stage; returning `false` skips commands, the active conversation,
   * dormant resume, matchers and the catch-all, while after-hooks and the `'message'`
   * event still run.
   */
  gate?: (ctx: DispatchContext) => boolean
  /**
   * Decides whether a message is its subject's first contact, for `WELCOME` matchers.
   * Called only when a WELCOME matcher is reached, inside the per-chat FIFO. The Bot
   * wires a store-backed `WelcomeTracker`; when omitted, an in-memory one is used.
   */
  firstContact?: (ctx: DispatchContext) => Promise<boolean>
}

interface MatcherEntry {
  seq: number
  trigger: Trigger
  specificity: number
  handler: MessageHandler
  /** The handler starts a conversation (registered through {@link Dispatcher.conversationMatcher}). */
  startsConversation?: boolean
}

export class Dispatcher {
  private commands = new Map<string, CommandHandler>()
  private matchers: MatcherEntry[] = []
  private catchAlls: MessageHandler[] = []
  private queues = new Map<string, Promise<void>>()
  private seq = 0

  constructor(private deps: DispatcherDeps) {
    // An empty prefix would turn EVERY message into a command attempt (''.startsWith('') === true),
    // silently swallowing all normal text. Reject it loudly at construction time.
    if (deps.commandPrefix === '') {
      throw new Error('commandPrefix must not be an empty string — omit it to use the default "/"')
    }
  }

  command(name: string, handler: CommandHandler): () => void {
    const key = normalizeText(name)
    this.commands.set(key, handler)
    return () => { this.commands.delete(key) }
  }

  /** Is a command handler registered under `name` (compared normalized, without prefix)? */
  hasCommand(name: string): boolean {
    return this.commands.has(normalizeText(name))
  }

  matcher(trigger: Trigger, handler: MessageHandler, specificityOverride?: number): () => void {
    return this.addMatcher({
      seq: this.seq++,
      trigger,
      specificity: specificityOverride ?? triggerSpecificity(trigger),
      handler,
    })
  }

  /**
   * Same as {@link matcher}, for a handler that STARTS a conversation (a flow or a
   * `bot.conversation` trigger). Messages treat it like any matcher — they only reach
   * the matcher stage when the subject has no active/dormant conversation. A projected
   * event ({@link dispatchEvent}, e.g. a call) skips it while the subject has an active
   * conversation or a dormant checkpoint, so an event can never replace (and wipe the
   * checkpoint of) a conversation in progress; the next matching handler runs instead.
   */
  conversationMatcher(trigger: Trigger, handler: MessageHandler): () => void {
    return this.addMatcher({
      seq: this.seq++,
      trigger,
      specificity: triggerSpecificity(trigger),
      handler,
      startsConversation: true,
    })
  }

  private addMatcher(entry: MatcherEntry): () => void {
    this.matchers.push(entry)
    this.matchers.sort((a, b) => b.specificity - a.specificity || a.seq - b.seq)
    return () => { this.matchers = this.matchers.filter((m) => m !== entry) }
  }

  /** Same as `matcher(typeTrigger(type), handler)` — the single-kind type-trigger tier. */
  onType(type: string, handler: MessageHandler): () => void {
    return this.matcher(typeTrigger(type as MessageType), handler)
  }

  catchAll(handler: MessageHandler): () => void {
    this.catchAlls.push(handler)
    return () => { this.catchAlls = this.catchAlls.filter((h) => h !== handler) }
  }

  /** Serializa por chat-key: nunca dos mensajes del mismo chat en paralelo. */
  dispatch(ctx: DispatchContext): Promise<void> {
    return this.enqueue(ctx, () => this.run(ctx))
  }

  /**
   * Run `job` in `ctx`'s per-chat FIFO slot (after messages already queued for that
   * key, before later ones) and resolve/reject with its result. No hooks or routing
   * run — used by `bot.trigger()` to start a conversation in order with the chat.
   */
  runExclusive<T>(ctx: Pick<DispatchContext, 'from' | 'sender' | 'isGroup'>, job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      void this.enqueue(ctx as DispatchContext, async () => {
        try { resolve(await job()) } catch (error) { reject(error) }
      })
    })
  }

  private enqueue(ctx: DispatchContext, job: () => Promise<void>): Promise<void> {
    const key = this.deps.runtime.keyFor(ctx)
    const tail = this.queues.get(key) ?? Promise.resolve()
    const next = tail.then(job).catch(() => {})
    this.queues.set(key, next)
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key) })
    return next
  }

  /**
   * The message routing pipeline. Full inbound order, Bot + Dispatcher:
   *
   *  Bot.handleProviderEvent / handleInbound / processMessage (per event, before the queue)
   *   1. inbound dedupe — a redelivered message/interaction (same chatId + id) stops here
   *   2. blacklist / whitelist — dropped silently: not persisted, no hooks, no 'message'
   *   3. persistence — chat, contact and message upserts
   *   4. groupMode filter — a group message the bot must ignore stops here (still persisted)
   *  Dispatcher (per-chat FIFO queue, this method)
   *   5. before('message') hooks — may abort
   *   6. handoff gate — a handed-off chat skips 7–11 (except `handoff.allowCommands`)
   *   7. commands — always beat an active conversation (`/reset` escape)
   *   8. active conversation (`c.ask`/`c.retry`/… waits)
   *   9. dormant checkpoint resume (persistent flows after a restart)
   *  10. matchers by specificity: WELCOME (100, first contact only) → text (40…10)
   *      → function (5) → single-type IMAGE… (2) → multi-type MEDIA (1)
   *  11. catch-all (`onMessage`, aiPlugin)
   *  12. finish — after('message') hooks, then the 'message' event (onIdle re-arms here)
   *
   * Why: dedupe and the access lists run first so neither a retry nor a blocked sender
   * costs a store write or reaches hooks; a handed-off chat is still persisted, still
   * runs hooks and still emits 'message' (inbox/agents see it) but nothing routes it;
   * WELCOME sits after commands/conversations so those never spend the welcome. Call
   * events take a separate path (`dispatchEvent`): same access/handoff gates in the Bot,
   * then only CALL type triggers — no message hooks, commands or 'message' event.
   */
  private async run(ctx: DispatchContext): Promise<void> {
    const { hooks, runtime, emit } = this.deps
    const prefix = this.deps.commandPrefix ?? '/'
    try {
      if (!(await hooks.runBefore('message', ctx))) return

      // 0. routing gate (human handoff): skip every routing stage, still finish()
      if (this.deps.gate && !this.deps.gate(ctx)) return this.finish(ctx)

      // 1. comandos — SIEMPRE antes que la conversación activa
      if (ctx.body?.startsWith(prefix)) {
        const [raw, ...args] = ctx.body.slice(prefix.length).trim().split(/\s+/)
        const handler = this.commands.get(normalizeText(raw ?? ''))
        if (handler) {
          await handler(ctx, args)
          return this.finish(ctx)
        }
        // Only emit 'command:unknown' when there is no active conversation for this chat-key.
        // If a conversation IS active, the emit must not fire at all — otherwise a real
        // 'command:unknown' listener (e.g. slashCommandsPlugin) would reply "Comando
        // desconocido" AND the conversation would ALSO consume "/xyz" as its answer below
        // (double behavior). Falling through here lets step 2 (runtime.deliver) consume it.
        if (!runtime.hasActive(runtime.keyFor(ctx))) {
          const handled = emit('command:unknown', { ctx, command: raw })
          if (handled) return this.finish(ctx)
        }
        // continúa: una conversación puede consumir "/xyz" como texto
      }

      // 2. conversación activa
      if (runtime.deliver(ctx)) return this.finish(ctx)

      // 3. checkpoint dormido
      if (await runtime.resumeDormant(ctx)) return this.finish(ctx)

      // 4. matchers por especificidad
      for (const m of this.matchers) {
        if (!matchTrigger(m.trigger, ctx)) continue
        if (isWelcomeTrigger(m.trigger) && !(await this.isFirstContact(ctx))) continue
        ctx._passed = false
        await m.handler(ctx)
        if (ctx._aborted) return this.finish(ctx)
        if (!ctx._passed) return this.finish(ctx)
      }

      // 5. catch-all
      for (const h of this.catchAlls) {
        ctx._passed = false
        await h(ctx)
        if (ctx._aborted || !ctx._passed) break
      }
      return this.finish(ctx)
    } catch (error) {
      this.deps.logger?.error?.('dispatch error', error)
      // runError() rethrows when no onError('message') hook is registered; that must not
      // swallow the error before it reaches the bot's 'error' event (it used to vanish
      // into the per-chat queue's catch — e.g. a RateLimitedError from ctx.reply()).
      try { await hooks.runError('message', ctx, error) } catch { /* no error hook: surfaced below */ }
      emit('error', { error, ctx })
    }
  }

  private async finish(ctx: DispatchContext): Promise<void> {
    await this.deps.hooks.runAfter('message', ctx)
    this.deps.emit('message', ctx)
  }

  /* -------------------------------------------------------------------------
   * Special triggers (WELCOME / type triggers / projected events such as calls)
   * ---------------------------------------------------------------------- */

  private fallbackWelcome?: WelcomeTracker

  private isFirstContact(ctx: DispatchContext): Promise<boolean> {
    if (this.deps.firstContact) return this.deps.firstContact(ctx)
    this.fallbackWelcome ??= new WelcomeTracker()
    return this.fallbackWelcome.isFirstContact(ctx)
  }

  /** True when a type trigger accepting `type` is registered (e.g. `CALL` for `'call'`). */
  hasTypeMatcher(type: string): boolean {
    return this.matchers.some((m) => isTypeTrigger(m.trigger) && m.trigger.types.includes(type as MessageType))
  }

  /**
   * Dispatch a projected non-message event (a call, `ctx.type === 'call'`) through the
   * same per-chat FIFO, running ONLY the type-trigger matchers that accept `ctx.type`
   * (by specificity; `ctx.pass()` cascades). Message hooks, commands, conversations,
   * text/function triggers and catch-alls are skipped and `'message'` is not emitted.
   * A matcher that starts a conversation is skipped while the subject already has an
   * active conversation or a dormant checkpoint (see {@link conversationMatcher}).
   * A handler error goes to the `error` hooks of `ctx.type` and to the `'error'` event.
   */
  dispatchEvent(ctx: DispatchContext): Promise<void> {
    return this.enqueue(ctx, () => this.runEvent(ctx))
  }

  private async runEvent(ctx: DispatchContext): Promise<void> {
    const { runtime } = this.deps
    const key = runtime.keyFor(ctx)
    try {
      for (const m of this.matchers) {
        if (!isTypeTrigger(m.trigger) || !matchTrigger(m.trigger, ctx)) continue
        // Never let an event replace a conversation in progress: enter() would abort it and
        // its persistent checkpoint would be cleared. Re-checked per matcher (a plain handler
        // earlier in the cascade may itself have started one).
        if (m.startsConversation && (runtime.hasActive(key) || runtime.hasDormant(key))) continue
        ctx._passed = false
        await m.handler(ctx)
        if (ctx._aborted || !ctx._passed) return
      }
    } catch (error) {
      this.deps.logger?.error?.('event dispatch error', error)
      try { await this.deps.hooks.runError(ctx.type, ctx, error) } catch { /* no error hook registered */ }
      this.deps.emit('error', { error, ctx })
    }
  }
}
