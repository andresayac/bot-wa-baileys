/**
 * Operational entry points of one bot: `trigger()` (proactive conversation start),
 * `broadcast()`, metrics and the i18n language resolution shared with the Dispatcher.
 */
import { checkAccess } from '../../gates/accessList.js'
import type { I18n } from '../../i18n/I18n.js'
import { runBroadcast, type BroadcastOptions, type BroadcastResult } from '../../ops/broadcast.js'
import type { BotMetricsSnapshot } from '../../ops/metrics.js'
import { assertTriggerArgs, triggerInbound, type TriggerOptions, type TriggerResult } from '../../ops/trigger.js'
import type { ChatId, MessageContext, OutboundContent, SendOptions, SentMessage } from '../types.js'
import type { ContextFactory } from './contextFactory.js'
import type { BotKernel } from './kernel.js'
import { SPAN_NAMES, TRACE_ATTR } from '../../telemetry/attributes.js'

/** Resolve `ctx.lang` / `ctx.langSource` (i18n must be enabled). Never rejects. */
export async function resolveLang(i18n: I18n, ctx: MessageContext): Promise<void> {
  const { lang, source } = await i18n.resolveDetailed(ctx)
  ctx.lang = lang
  ctx.langSource = source
}

/** `bot.send`, late-bound on the receiver (a spy or override on `send` is honoured). */
export type BroadcastSend = (chatId: ChatId, content: OutboundContent, options?: SendOptions) => Promise<SentMessage>

export class BotOps {
  constructor(private readonly k: BotKernel, private readonly contextFor: ContextFactory) {}

  broadcast(send: BroadcastSend, chatIds: readonly ChatId[], content: string | OutboundContent, opts?: BroadcastOptions): Promise<BroadcastResult> {
    const outbound: OutboundContent = typeof content === 'string' ? { kind: 'text', text: content } : content
    // Not started yet (or stopped): nothing may go out through a provider that is not running.
    const stopSignal = this.k.state.isStarted ? this.k.state.lifecycleAbort.signal : AbortSignal.abort()
    const signal = opts?.signal ? AbortSignal.any([opts.signal, stopSignal]) : stopSignal
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
    const { runtime, state, counters, access } = this.k
    assertTriggerArgs(name, opts)
    if (!runtime.has(name)) throw new Error(`Conversation "${name}" is not registered`)
    const inbound = triggerInbound(name, opts)
    const base = { name, chatId: inbound.chatId, userId: inbound.senderId }
    if (!state.acceptingInbound) return { ...base, started: false, reason: 'stopped' }
    if (checkAccess(access.blacklist, access.whitelist, inbound) !== 'allowed') {
      counters.blockedDropped()
      return { ...base, started: false, reason: 'blocked' }
    }
    const ctx = this.contextFor(inbound)
    return this.k.dispatcher.runExclusive(ctx, async (): Promise<TriggerResult> => {
      if (!state.acceptingInbound) return { ...base, started: false, reason: 'stopped' }
      if (!this.k.handoffs.admits(ctx)) {
        counters.handoffDropped()
        return { ...base, started: false, reason: 'handoff' }
      }
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

  metrics(): BotMetricsSnapshot {
    return this.k.counters.snapshot(this.k.runtime.activeCount())
  }
}
