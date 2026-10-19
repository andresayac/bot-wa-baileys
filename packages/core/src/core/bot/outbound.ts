/**
 * The outbound pipeline of one bot: sends and edits through the `before('send')` /
 * `after('send')` hooks, the outbound ledger, paced (delay + typing) replies, typing
 * indicators and the `ctx.stream()` primitives.
 */
import { randomId } from '../../utils/timers.js'
import { isEditableSend, messagingSupport, type ReplyOptions } from '../messaging.js'
import type { BuildContextDeps, DraftOptions } from '../provider.js'
import { toStoredError } from '../ledger.js'
import type { ChatId, MessageRef, OutboundContent, SendOptions, SendResult, SentMessage } from '../types.js'
import { assertCoordinated, type BotKernel } from './kernel.js'

export type ContextStreamDeps = Pick<BuildContextDeps, 'capabilities' | 'textFormatFor' | 'streamSend' | 'streamEdit' | 'sendDraft' | 'deleteStreamMessage' | 'stopSignal'>
export type ContextMessagingDeps = Pick<BuildContextDeps, 'pace' | 'editMessage' | 'sendClock' | 'supports'>

export class OutboundPipeline {
  constructor(private readonly k: BotKernel) {}

  /**
   * Central outbound path: `before('send')` (mutable/abortable) → provider.send → `after('send')`.
   * Both `bot.send` and every `ctx.reply`/`ctx.photo`/… reply helper route through here
   * (`ctx.edit` uses the twin {@link edit}). Any send that is not a `ctx` reply to its
   * own chat (`bot.send`, `sendTo` from a human agent, campaigns) ticks `externalSends`,
   * so an implicit `ctx.edit(content)` never edits a reply that was followed by it.
   */
  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions, origin: 'ctx' | 'api' = 'api', stream?: 'message'): Promise<SendResult> {
    const { hooks, provider, counters, inflightSends, messageLog, config } = this.k
    const payload: { chatId: ChatId; content: OutboundContent; options?: SendOptions; stream?: 'message' } = { chatId, content, options }
    if (stream) payload.stream = stream
    const proceed = await hooks.runBefore('send', payload as typeof payload & { abort(): void })
    if (!proceed) {
      return { ref: { id: 'skipped', chatId: payload.chatId }, skipped: true }
    }
    assertCoordinated(this.k)
    const localRef = { id: randomId('out'), chatId: payload.chatId }
    const op = provider.send(payload.chatId, payload.content, payload.options)
    inflightSends.add(op)
    try {
      let res: SendResult
      try { res = await op } catch (error) { counters.outbound(false); throw error }
      counters.outbound(true)
      if (isEditableSend(payload.content)) {
        if (origin !== 'ctx') this.k.externalSends.mark(payload.chatId)
      }
      await hooks.runAfter('send', payload)
      await messageLog.outbound({
        ref: res.ref,
        chatId: payload.chatId,
        content: payload.content,
        options: payload.options,
        status: 'sent',
        raw: config.persistRaw ? res.raw : undefined,
      })
      return res
    } catch (error) {
      await messageLog.outbound({
        ref: localRef,
        chatId: payload.chatId,
        content: payload.content,
        options: payload.options,
        status: 'failed',
        error: toStoredError(error),
      })
      throw error
    } finally {
      inflightSends.delete(op)
    }
  }

  /**
   * Edit path behind `ctx.edit`: the same `before('send')` → provider → `after('send')`
   * pipeline as {@link send}, with the payload carrying `edit: ref` so hooks can
   * tell edits apart. A hook may rewrite `payload.content` or `abort()` (→ `skipped`).
   * The ledger entry of `ref` is updated in place with the edited content.
   */
  async edit(ref: MessageRef, content: OutboundContent): Promise<SendResult> {
    const { hooks, provider, inflightSends, messageLog, config } = this.k
    const payload: { chatId: ChatId; content: OutboundContent; options?: SendOptions; edit: MessageRef } = {
      chatId: ref.chatId, content, options: undefined, edit: ref,
    }
    const proceed = await hooks.runBefore('send', payload as typeof payload & { abort(): void })
    if (!proceed) return { ref, skipped: true }
    assertCoordinated(this.k)
    const op = provider.editMessage!(ref, payload.content)
    inflightSends.add(op)
    try {
      const res = await op
      await hooks.runAfter('send', payload)
      await messageLog.edit(ref, payload.content, config.persistRaw ? res.raw : undefined)
      return res
    } finally {
      inflightSends.delete(op)
    }
  }

  /**
   * Run a ctx text reply through the pacer. The wait (delay + typing) is tracked as an
   * in-flight send so `stop({ drain: true })` waits for it; the reply is dropped
   * (`skipped`) if, by the end of the wait, the bot is stopping or the chat was handed
   * off meanwhile (a reply that started in an already handed-off chat still goes out).
   */
  paced(chatId: ChatId, text: string, opts: ReplyOptions | undefined, send: () => Promise<SentMessage>): Promise<SentMessage> {
    const { isHandedOff, state, inflightSends } = this.k
    const handedOffAtStart = isHandedOff(chatId)
    const op = this.k.pacer.run(chatId, text, opts, send, {
      cancelled: () => !state.pacedSendsOpen || (!handedOffAtStart && isHandedOff(chatId)),
      skip: () => ({ ref: { id: 'skipped', chatId }, id: 'skipped', chatId, skipped: true }),
    })
    inflightSends.add(op)
    const settle = () => { inflightSends.delete(op) }
    op.then(settle, settle)
    return op
  }

  /**
   * Best-effort typing indicator for `ctx.typing()` / `ctx.recording()` / streams: a
   * failing provider indicator (rejected or thrown) is logged at debug and swallowed,
   * so it never aborts the reply it decorates — same policy as the BotConfig.typing pacer.
   */
  async typing(chatId: ChatId, state: 'typing' | 'recording' | 'paused'): Promise<void> {
    try {
      assertCoordinated(this.k)
      await this.k.provider.typing?.(chatId, state)
    } catch (error) {
      this.k.logger.debug({ chatId, state, err: error instanceof Error ? error.message : String(error) }, 'typing indicator failed (ignored)')
    }
  }

  /** Typing/delay pacing, edit and capability seams shared by every context this bot builds. */
  messagingDeps(): ContextMessagingDeps {
    const provider = this.k.provider
    return {
      pace: (chatId, text, opts, send) => this.paced(chatId, text, opts, send),
      editMessage: provider.editMessage ? (ref, content) => this.edit(ref, content) : undefined,
      sendClock: this.k.externalSends,
      supports: (feature) => messagingSupport(provider, feature),
    }
  }

  /**
   * `ctx.stream()` backing: capabilities + the provider's edit/draft primitives (when present),
   * plus the per-chat text format behind `ctx.textFormat` (`IProvider.textFormatFor`).
   * Live previews run the same `before('send')` hooks as a real send (the payload carries
   * `stream: 'draft' | 'edit'`), so a hook that redacts, translates or aborts a reply also
   * covers the in-place updates. `after('send')` stays reserved for real messages. The
   * stream's new messages take the normal send path with `stream: 'message'`.
   */
  streamDeps(): ContextStreamDeps {
    const p = this.k.provider
    return {
      capabilities: p.capabilities,
      textFormatFor: p.textFormatFor ? (chatId) => p.textFormatFor!(chatId) : undefined,
      streamSend: (chatId, content, o) => this.send(chatId, content, o, 'ctx', 'message'),
      streamEdit: p.editMessage ? (ref, content) => this.streamEdit(ref, content) : undefined,
      sendDraft: p.sendDraft ? (chatId, draftId, text, opts) => this.streamDraft(chatId, draftId, text, opts) : undefined,
      deleteStreamMessage: p.deleteMessage ? (ref) => this.deleteStreamMessage(ref) : undefined,
      stopSignal: () => this.k.state.sendsAbort.signal,
    }
  }

  /** A discarded `ctx.stream()` message: gone from the chat and from the message log. */
  private async deleteStreamMessage(ref: MessageRef): Promise<void> {
    assertCoordinated(this.k)
    await this.k.provider.deleteMessage!(ref)
    try {
      await this.k.store.deleteMessage(ref)
    } catch (error) {
      this.k.events.error({ error })
    }
  }

  /** `before('send')` for a live preview. Resolves the (possibly rewritten) content, or `undefined` when a hook aborted. */
  private async runStreamSendHooks(chatId: ChatId, content: OutboundContent, stream: 'draft' | 'edit'): Promise<OutboundContent | undefined> {
    const payload: { chatId: ChatId; content: OutboundContent; options?: SendOptions; stream: 'draft' | 'edit' } = { chatId, content, stream }
    const proceed = await this.k.hooks.runBefore('send', payload as typeof payload & { abort(): void })
    return proceed ? payload.content : undefined
  }

  /** A `ctx.stream()` edit: send hooks, provider edit, then the message log is updated to the shown text. */
  private async streamEdit(ref: MessageRef, content: OutboundContent): Promise<unknown> {
    const final = await this.runStreamSendHooks(ref.chatId, content, 'edit')
    if (!final) return undefined
    assertCoordinated(this.k)
    const res = await this.k.provider.editMessage!(ref, final)
    await this.k.messageLog.streamEdit(ref, final)
    return res
  }

  /** A `ctx.stream()` draft: send hooks, then the provider draft (skipped when aborted or no longer text). */
  private async streamDraft(chatId: ChatId, draftId: number, text: string, opts?: DraftOptions): Promise<void> {
    const final = await this.runStreamSendHooks(chatId, { kind: 'text', text }, 'draft')
    if (!final || final.kind !== 'text') return
    assertCoordinated(this.k)
    await this.k.provider.sendDraft!(chatId, draftId, final.text, opts)
  }
}
