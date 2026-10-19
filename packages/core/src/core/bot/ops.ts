/**
 * Operational entry points of one bot: `trigger()` / `triggerFlow()` (proactive
 * conversation start), `broadcast()`, metrics, busy state, the flow inventory behind
 * `describe()` / `lint()`, conversation keys of the admin API and the collaborators of
 * the subject-data export/erasure. The `Bot` facade only delegates here.
 */
import { isDurableStore, type FlowInventory } from '../../flows/inventory.js'
import { runBroadcast, type BroadcastOptions, type BroadcastResult } from '../../ops/broadcast.js'
import type { BotMetricsSnapshot } from '../../ops/metrics.js'
import { assertTriggerArgs, triggerInbound, type TriggerOptions, type TriggerResult } from '../../ops/trigger.js'
import { parseTimerDuration } from '../../utils/timers.js'
import type { ConversationTarget } from '../Bot.js'
import type { FlowTriggerOptions, FlowTriggerTarget } from '../flowRegistry.js'
import type { SubjectDataDeps } from '../subjectData.js'
import type { ChatId, MessageContext, OutboundContent, SendOptions, SentMessage } from '../types.js'
import type { ContextFactory } from './contextFactory.js'
import { admitAccess, admitHandoff } from './gates.js'
import { toOutbound, type BotKernel } from './kernel.js'
import { resolveLang } from './lang.js'
import { SPAN_NAMES, TRACE_ATTR } from '../../telemetry/attributes.js'

/** `bot.send`, late-bound on the receiver (a spy or override on `send` is honoured). */
export type BroadcastSend = (chatId: ChatId, content: OutboundContent, options?: SendOptions) => Promise<SentMessage>
/** `bot.trigger`, late-bound on the receiver (a spy or override on `trigger` is honoured). */
export type TriggerFn = (name: string, opts: TriggerOptions) => Promise<TriggerResult>

export class BotOps {
  constructor(private readonly k: BotKernel, private readonly contextFor: ContextFactory) {}

  broadcast(send: BroadcastSend, chatIds: readonly ChatId[], content: string | OutboundContent, opts?: BroadcastOptions): Promise<BroadcastResult> {
    // Not started yet (or stopped): nothing may go out through a provider that is not running.
    const stopSignal = this.k.state.isStarted ? this.k.state.lifecycleAbort.signal : AbortSignal.abort()
    const signal = opts?.signal ? AbortSignal.any([opts.signal, stopSignal]) : stopSignal
    const outbound = toOutbound(content)
    const run = () => runBroadcast(
      { send: (chatId, c, o) => send(chatId, c, o), reportError: (error) => this.k.events.error({ error }) },
      chatIds,
      outbound,
      { ...opts, signal },
    )
    const tracing = this.k.tracing
    if (!tracing) return run()
    // Tracing: one `bot.broadcast` span; every send is a `bot.send` child of it.
    const attributes = { [TRACE_ATTR.broadcastRecipients]: chatIds.length, [TRACE_ATTR.contentKind]: outbound.kind }
    return tracing.trace(SPAN_NAMES.broadcast, { attributes }, () => run())
  }

  trigger(name: string, opts: TriggerOptions): Promise<TriggerResult> {
    const tracing = this.k.tracing
    if (!tracing) return this.triggerNow(name, opts)
    // Tracing: a `bot.trigger` span (the conversation's first turn is its child).
    return tracing.trace(SPAN_NAMES.trigger, { attributes: { [TRACE_ATTR.triggerName]: name } }, (span) => {
      const result = this.triggerNow(name, opts)
      result.then((r) => { span.setAttribute(TRACE_ATTR.triggerResult, r.started ? 'started' : r.reason) }, () => {})
      return result
    })
  }

  private async triggerNow(name: string, opts: TriggerOptions): Promise<TriggerResult> {
    const { runtime, state, counters } = this.k
    assertTriggerArgs(name, opts)
    if (!runtime.has(name)) throw new Error(`Conversation "${name}" is not registered`)
    const inbound = triggerInbound(name, opts)
    const base = { name, chatId: inbound.chatId, userId: inbound.senderId }
    if (!state.acceptingInbound) return { ...base, started: false, reason: 'stopped' }
    if (!admitAccess(this.k, inbound)) return { ...base, started: false, reason: 'blocked' }
    const ctx = this.contextFor(inbound)
    return this.k.dispatcher.runExclusive(ctx, async (): Promise<TriggerResult> => {
      if (!state.acceptingInbound) return { ...base, started: false, reason: 'stopped' }
      if (!admitHandoff(this.k, ctx)) return { ...base, started: false, reason: 'handoff' }
      // Same language resolution as an inbound message (Dispatcher `prepare`), in the chat's slot.
      if (this.k.i18n.enabled) await resolveLang(this.k.i18n, ctx)
      const key = runtime.keyFor(ctx)
      if (runtime.hasActive(key) || runtime.hasDormant(key)) {
        if (opts.ifActive !== 'replace') return { ...base, started: false, reason: 'busy' }
        runtime.discardDormant(key)
      }
      // Fire-and-forget: enter() resolves when the conversation ENDS.
      void runtime.enter(name, ctx, { state: opts.data })
        .catch((error) => this.k.events.error({ error, ctx: ctx as unknown as MessageContext }))
      counters.triggerStarted()
      return { ...base, started: true }
    })
  }

  /** `bot.triggerFlow()`: {@link trigger} (through the late-bound `trigger`) with `ifActive: 'replace'`. */
  async triggerFlow(trigger: TriggerFn, id: string, target: FlowTriggerTarget, opts: FlowTriggerOptions): Promise<boolean> {
    if (!this.k.state.acceptingInbound) throw new Error('triggerFlow() needs a started bot')
    if (!this.k.runtime.has(id)) return false
    const result = await trigger(id, {
      chatId: target.chatId,
      ...(target.userId !== undefined ? { userId: target.userId } : {}),
      isGroup: target.isGroup === true,
      ...(opts.state ? { data: opts.state } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ifActive: 'replace',
    })
    if (result.reason === 'stopped') throw new Error('triggerFlow() needs a started bot')
    return result.started
  }

  metrics(): BotMetricsSnapshot {
    return this.k.counters.snapshot(this.k.runtime.activeCount())
  }

  /** A provider event is still being handled, or a conversation is running a step (see `Bot.isBusy`). */
  isBusy(): boolean {
    return this.k.inflightEvents.size > 0 || this.k.runtime.hasRunning()
  }

  /** The runtime key of a conversation target (a raw key is returned as is). */
  conversationKey(target: string | ConversationTarget): string {
    return typeof target === 'string' ? target : this.k.runtime.keyFor(target)
  }

  /** Input of `describeFlows()` / `lintFlows()`: registrations, routes and the config bits the linter needs. */
  flowInventory(): FlowInventory {
    const { config, runtime, flowRoutes, store } = this.k
    const timeout = config.conversation?.timeout
    return {
      registrations: runtime.listRegistrations(),
      routes: flowRoutes.list(),
      defaultTimeoutMs: timeout !== undefined ? parseTimerDuration(timeout, 'conversation.timeout') : undefined,
      durableStore: isDurableStore(store),
    }
  }

  /** Collaborators of `exportSubjectData()` / `deleteSubjectData()`. */
  subjectDeps(): SubjectDataDeps {
    const { store, namespace, runtime, handoffs, chatWrites, i18n, welcome, users } = this.k
    return { store, namespace, runtime, handoffs, chatWrites, i18n, welcome, users }
  }
}
