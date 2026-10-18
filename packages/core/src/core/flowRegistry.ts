/**
 * Dynamic flow registry — the runtime CRUD behind `bot.registerFlow()`,
 * `unregisterFlow()`, `replaceFlow()`, `listFlows()` and `triggerFlow()`.
 *
 * Keeps, per conversation name, the dispatcher matchers that enter it so a flow
 * can be removed or hot-swapped without a restart. Conversations already running
 * keep the version they entered with (the runtime hands them their function at
 * `enter()` time); new triggers use the new version.
 */

import type { ConversationRuntime, ConversationSnapshot, RuntimeMessage } from '../conversations/ConversationRuntime.js'
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

/** Options of {@link Bot.triggerFlow}. */
export interface FlowTriggerOptions {
  /** Shallow-merged into `c.state` before the first step runs. */
  state?: Record<string, unknown>
  /** `ctx.body` of the synthetic triggering message. Default `''`. */
  body?: string
}

/** @internal Collaborators the registry needs from its {@link Bot}. */
export interface FlowRegistryDeps {
  runtime: ConversationRuntime
  enterMatcher(trigger: Trigger, target: string): () => void
  isStarted(): boolean
  isHandedOff(chatId: ChatId): boolean
  /** Access lists (blacklist / whitelist) refuse this subject — same gate as an inbound message. */
  isBlocked(chatId: ChatId, userId: UserId): boolean
  reply(chatId: ChatId, text: string): Promise<unknown>
  decorate?(ctx: RuntimeMessage): RuntimeMessage
  reportError(error: unknown, ctx: RuntimeMessage): void
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

  trigger(id: string, target: FlowTriggerTarget, opts: FlowTriggerOptions = {}): boolean {
    if (!this.deps.isStarted()) throw new Error('triggerFlow() needs a started bot')
    const fn = this.deps.runtime.lookup(id)
    if (!fn) return false
    const chatId = target.chatId
    if (this.deps.isBlocked(chatId, target.userId ?? chatId)) return false
    if (this.deps.isHandedOff(chatId)) return false
    const base: RuntimeMessage = {
      from: chatId,
      sender: target.userId ?? chatId,
      body: opts.body ?? '',
      type: 'text',
      isGroup: target.isGroup === true,
      reply: (text: string) => this.deps.reply(chatId, text),
    }
    const ctx = this.deps.decorate ? this.deps.decorate(base) : base
    const seed = opts.state
    const run = seed
      ? this.deps.runtime.enter(async (c, m) => { Object.assign(c.state, seed); await fn(c, m) }, ctx)
      : this.deps.runtime.enter(id, ctx)
    // Fire-and-forget: enter() resolves when the conversation ENDS.
    void run.catch((error) => this.deps.reportError(error, ctx))
    return true
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
