/**
 * Route registration of one bot: matchers, conversations, commands, catch-all, type
 * handlers and hooks.
 *
 * Methods that register a trigger route take the `enter` callback instead of calling
 * {@link RouteRegistrar.enterMatcher} directly: the facade passes
 * `(t, id) => this.registerEnterMatcher(t, id)`, late-bound on the receiver, so a
 * plugin-scoped bot (which overrides `registerEnterMatcher`) tracks those routes and
 * removes them on unplug. `use()` takes the `plug` callback for the same reason.
 */
import { FlowBuilder, isCompiledFlow, type CompiledFlow } from '../../flows/FlowBuilder.js'
import type { ConversationFn } from '../../conversations/ConversationRuntime.js'
import type { ConversationHandler } from '../../conversations/handler.js'
import type { HookEvent, HookHandler, HookPhase, MessageContext, MessageType, Plugin, Trigger } from '../types.js'
import { asMessage, type BotKernel } from './kernel.js'

/** A user message handler — receives the full inbound {@link MessageContext}. */
export type RouteHandler = (ctx: MessageContext) => unknown | Promise<unknown>
/** A slash-command handler — receives the context plus the parsed argument list. */
export type RouteCommandHandler = (ctx: MessageContext, args: string[]) => unknown | Promise<unknown>
/** Registers the route that enters conversation/flow `target` when `trigger` matches. */
export type EnterMatcher = (trigger: Trigger, target: string) => () => void

export class RouteRegistrar {
  constructor(private readonly k: BotKernel) {}

  when(trigger: Trigger, handler: RouteHandler | FlowBuilder | CompiledFlow, enter: EnterMatcher): () => void {
    if (handler instanceof FlowBuilder) {
      const compiled = handler.compile()
      this.k.runtime.registerCompiled(compiled)
      return enter(trigger, compiled.id)
    }
    if (isCompiledFlow(handler)) {
      this.k.runtime.registerCompiled(handler)
      return enter(trigger, handler.id)
    }
    const fn = handler
    const unmatch = this.k.dispatcher.matcher(trigger, (ctx) => fn(asMessage(ctx)))
    const unroute = this.k.flowRoutes.add(trigger)
    const unsub = () => { unmatch(); unroute() }
    this.k.disposables.add(unsub)
    return unsub
  }

  conversation(name: string, fn: ConversationHandler, trigger: Trigger, enter: EnterMatcher): () => void {
    this.k.runtime.register(name, fn as ConversationFn)
    return enter(trigger, name)
  }

  use(
    items: Array<FlowBuilder | CompiledFlow | Plugin>,
    enter: EnterMatcher,
    plug: (plugin: Plugin) => unknown,
  ): void {
    for (const i of items) {
      if (i instanceof FlowBuilder) {
        const compiled = i.compile()
        this.k.runtime.registerCompiled(compiled)
        enter(compiled.trigger, compiled.id)
      } else if (isCompiledFlow(i)) {
        this.k.runtime.registerCompiled(i)
        enter(i.trigger, i.id)
      } else if (isPluginSpec(i)) {
        plug(i)
      } else {
        throw new Error('use() expects a FlowBuilder, CompiledFlow or Plugin')
      }
    }
  }

  /** The body of `Bot.registerEnterMatcher`. */
  enterMatcher(trigger: Trigger, target: string): () => void {
    const { dispatcher, runtime, events } = this.k
    // conversationMatcher: a projected event (a call) must never replace a conversation in progress.
    const unmatch = dispatcher.conversationMatcher(trigger, (ctx) => {
      void runtime.enter(target, ctx).catch((error) => events.error({ error, ctx: ctx as unknown as MessageContext }))
    }, { flow: target })
    const unroute = this.k.flowRoutes.add(trigger, target)
    const unsub = this.k.flowRegistry.track(target, () => { unmatch(); unroute() })
    this.k.disposables.add(unsub)
    return unsub
  }

  command(name: string, handler: RouteCommandHandler): () => void {
    const unsub = this.k.dispatcher.command(name, (ctx, args) => handler(asMessage(ctx), args))
    this.k.disposables.add(unsub)
    return unsub
  }

  onMessage(handler: RouteHandler): () => void {
    const unsub = this.k.dispatcher.catchAll((ctx) => handler(asMessage(ctx)))
    this.k.disposables.add(unsub)
    return unsub
  }

  onType(type: MessageType, handler: RouteHandler): () => void {
    const unsub = this.k.dispatcher.onType(type, (ctx) => handler(asMessage(ctx)))
    this.k.disposables.add(unsub)
    return unsub
  }

  hook(event: HookEvent, phase: HookPhase, handler: HookHandler, priority: number): void {
    this.k.disposables.add(this.k.hooks.register(event, phase, handler, priority))
  }
}

function isPluginSpec(x: unknown): x is Plugin {
  if (typeof x === 'function') return true
  return typeof x === 'object' && x !== null && 'name' in x && 'install' in x
}
