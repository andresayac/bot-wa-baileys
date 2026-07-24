import type { Trigger } from './types.js'
import { matchTrigger, triggerSpecificity, normalizeText } from './matching.js'
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
}

interface MatcherEntry { seq: number; trigger: Trigger; specificity: number; handler: MessageHandler }

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

  matcher(trigger: Trigger, handler: MessageHandler, specificityOverride?: number): () => void {
    const entry: MatcherEntry = {
      seq: this.seq++,
      trigger,
      specificity: specificityOverride ?? triggerSpecificity(trigger),
      handler,
    }
    this.matchers.push(entry)
    this.matchers.sort((a, b) => b.specificity - a.specificity || a.seq - b.seq)
    return () => { this.matchers = this.matchers.filter((m) => m !== entry) }
  }

  onType(type: string, handler: MessageHandler): () => void {
    return this.matcher((c) => (c as unknown as DispatchContext).type === type, handler, 1)
  }

  catchAll(handler: MessageHandler): () => void {
    this.catchAlls.push(handler)
    return () => { this.catchAlls = this.catchAlls.filter((h) => h !== handler) }
  }

  /** Serializa por chat-key: nunca dos mensajes del mismo chat en paralelo. */
  dispatch(ctx: DispatchContext): Promise<void> {
    const key = this.deps.runtime.keyFor(ctx)
    const tail = this.queues.get(key) ?? Promise.resolve()
    const next = tail.then(() => this.run(ctx)).catch(() => {})
    this.queues.set(key, next)
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key) })
    return next
  }

  private async run(ctx: DispatchContext): Promise<void> {
    const { hooks, runtime, emit } = this.deps
    const prefix = this.deps.commandPrefix ?? '/'
    try {
      if (!(await hooks.runBefore('message', ctx))) return

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
      await hooks.runError('message', ctx, error)
      emit('error', { error, ctx })
    }
  }

  private async finish(ctx: DispatchContext): Promise<void> {
    await this.deps.hooks.runAfter('message', ctx)
    this.deps.emit('message', ctx)
  }
}
