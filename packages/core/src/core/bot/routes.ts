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
import type { CommandHandler, MessageHandler } from '../Bot.js'
import type { AnyHookHandler, HookEvent, HookPhase, MessageContext, MessageType, Plugin, Trigger } from '../types.js'
import { asMessage, type BotKernel } from './kernel.js'

/** Registers the route that enters conversation/flow `target` when `trigger` matches. */
export type EnterMatcher = (trigger: Trigger, target: string) => () => void

export class RouteRegistrar {
  constructor(private readonly k: BotKernel) {}

  when(trigger: Trigger, handler: MessageHandler | FlowBuilder | CompiledFlow, enter: EnterMatcher): () => void {
    if (handler instanceof FlowBuilder || isCompiledFlow(handler)) return enter(trigger, this.registerFlowItem(handler).id)
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
      if (i instanceof FlowBuilder || isCompiledFlow(i)) {
        const compiled = this.registerFlowItem(i)
        enter(compiled.trigger, compiled.id)
      } else if (isPluginSpec(i)) {
        plug(i)
      } else {
        throw new Error('use() expects a FlowBuilder, CompiledFlow or Plugin')
      }
    }
  }

  /** Compile (a builder) and register a flow with the runtime; its route is registered by the caller. */
  private registerFlowItem(item: FlowBuilder | CompiledFlow): CompiledFlow {
    const compiled = item instanceof FlowBuilder ? item.compile() : item
    this.k.runtime.registerCompiled(compiled)
    return compiled
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

  command(name: string, handler: CommandHandler): () => void {
    const unsub = this.k.dispatcher.command(name, (ctx, args) => handler(asMessage(ctx), args))
    this.k.disposables.add(unsub)
    return unsub
  }

  onMessage(handler: MessageHandler): () => void {
    const unsub = this.k.dispatcher.catchAll((ctx) => handler(asMessage(ctx)))
    this.k.disposables.add(unsub)
    return unsub
  }

  onType(type: MessageType, handler: MessageHandler): () => void {
    const unsub = this.k.dispatcher.onType(type, (ctx) => handler(asMessage(ctx)))
    this.k.disposables.add(unsub)
    return unsub
  }

  hook(event: HookEvent, phase: HookPhase, handler: AnyHookHandler, priority: number): void {
    this.k.disposables.add(this.k.hooks.register(event, phase, handler, priority))
  }
}

/**
 * Loose plugin check of `use()`: any function (a plugin factory) or an object with
 * `name` + `install`. Deliberately not `isPlugin()`, which rejects every function and
 * checks the field types: swapping them would change what `use()` accepts.
 */
function isPluginSpec(x: unknown): x is Plugin {
  if (typeof x === 'function') return true
  return typeof x === 'object' && x !== null && 'name' in x && 'install' in x
}
