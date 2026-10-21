/**
 * Dynamic flow registry — the runtime CRUD behind `bot.registerFlow()`,
 * `unregisterFlow()`, `replaceFlow()` and `listFlows()` (`triggerFlow()` lives on the
 * Bot as a wrapper over `bot.trigger()`).
 *
 * Keeps, per conversation name, the dispatcher matchers that enter it so a flow
 * can be removed or hot-swapped without a restart. Conversations already running
 * keep the version they entered with (the runtime hands them their function at
 * `enter()` time); new triggers use the new version.
 */

import type { ConversationRuntime, ConversationSnapshot } from '../conversations/ConversationRuntime.js'
import { FlowBuilder, type CompiledFlow } from '../flows/FlowBuilder.js'
import type { Trigger } from './types.js'
import type { ChatId, UserId } from './provider.js'

/** One entry of {@link Bot.listFlows}. */
export type RegisteredFlowInfo =
  | { id: string; kind: 'flow'; steps: number; persistent: boolean }
  | { id: string; kind: 'conversation' }

/** Who {@link Bot.triggerFlow} starts the flow with. Ids are opaque strings. */
export interface FlowTriggerTarget {
  chatId: ChatId
  /** Participant id in a group; defaults to `chatId` (a DM). */
  userId?: UserId
  /** Whether `chatId` is a group (selects per-participant conversation keys). Default `false`. */
  isGroup?: boolean
}

/** Options of {@link Bot.triggerFlow} (mapped onto {@link Bot.trigger}'s `data` / `body`). */
export interface FlowTriggerOptions {
  /** Shallow-merged into `c.state` before the first step runs (same as {@link Bot.trigger}'s `data`). */
  data?: Record<string, unknown>
  /** @deprecated Use `data`. Alias kept for the alpha; passing both throws a `TypeError`. */
  state?: Record<string, unknown>
  /** `ctx.body` of the synthetic triggering message. Default `''`. */
  body?: string
}

/** @internal Collaborators the registry needs from its {@link Bot}. */
export interface FlowRegistryDeps {
  runtime: ConversationRuntime
  enterMatcher(trigger: Trigger, target: string): () => void
}

/** @internal */
export class DynamicFlowRegistry {
  private readonly matchers = new Map<string, Set<() => void>>()

  constructor(private readonly deps: FlowRegistryDeps) {}

  /** Record an enter-matcher of `target` so {@link unregister} can remove it. Returns a tracked unsub. */
  track(target: string, unsub: () => void): () => void {
    let set = this.matchers.get(target)
    if (!set) this.matchers.set(target, (set = new Set()))
    let done = false
    const tracked = () => {
      if (done) return
      done = true
      set!.delete(tracked)
      unsub()
    }
    set.add(tracked)
    return tracked
  }

  has(id: string): boolean { return this.deps.runtime.has(id) }

  register(input: FlowBuilder | CompiledFlow): string {
    const compiled = toCompiled(input)
    if (this.deps.runtime.has(compiled.id)) {
      throw new Error(`Flow "${compiled.id}" is already registered; use replaceFlow() to hot-swap it`)
    }
    this.install(compiled)
    return compiled.id
  }

  replace(id: string, input: FlowBuilder | CompiledFlow): void {
    if (!id) throw new Error('replaceFlow() needs a flow id')
    const compiled: CompiledFlow = { ...toCompiled(input), id }
    this.dropMatchers(id)
    this.install(compiled)
  }

  unregister(id: string): boolean {
    const known = this.deps.runtime.unregister(id)
    const hadMatchers = this.dropMatchers(id)
    return known || hadMatchers
  }

  list(): RegisteredFlowInfo[] {
    const live = new Map<string, RegisteredFlowInfo>()
    for (const r of this.deps.runtime.listRegistrations()) {
      if (!this.deps.runtime.has(r.name)) continue
      live.set(r.name, r.flow
        ? { id: r.name, kind: 'flow', steps: r.flow.steps.length, persistent: r.flow.opts.persistent === true }
        : { id: r.name, kind: 'conversation' })
    }
    return [...live.values()]
  }

  conversations(): ConversationSnapshot[] { return this.deps.runtime.listActive() }

  private install(compiled: CompiledFlow): void {
    this.deps.runtime.registerCompiled(compiled)
    this.deps.enterMatcher(compiled.trigger, compiled.id)
  }

  private dropMatchers(id: string): boolean {
    const set = this.matchers.get(id)
    if (!set || set.size === 0) return false
    for (const unsub of [...set]) unsub()
    this.matchers.delete(id)
    return true
  }
}

function toCompiled(input: FlowBuilder | CompiledFlow): CompiledFlow {
  return input instanceof FlowBuilder ? input.compile() : input
}
