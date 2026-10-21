/**
 * MessageContext — the ergonomic object handed to every handler.
 *
 * Transport-agnostic: it wraps an already-normalized {@link InboundMessage} and
 * a `send(OutboundContent)` provided by the transport. All proto parsing, JID /
 * LID-PN handling and media transcoding live in the provider (e.g. @botmesh/baileys),
 * NOT here. Reply helpers keep their familiar signatures; internally each builds
 * an {@link OutboundContent} descriptor and calls the provider.
 *
 * @example
 * ```ts
 * bot.when('hola', async (ctx) => await ctx.reply('👋 ¡Hola!'))
 * bot.when('foto', async (ctx) => await ctx.photo('https://picsum.photos/400/300', '📸'))
 * ```
 */

import { humanTypingDelay, sleep } from '../utils/timers.js'
import { unavailableUserData } from '../user/UserDataService.js'
import { isEditableSend, isMessageRef, type EditOptions, type EditResult, type ReplyOptions } from './messaging.js'
import { MediaTooLargeError, UnsupportedContentError } from './provider.js'
import { defaultI18n, normalizeLocale } from '../i18n/I18n.js'
import { streamText } from '../streaming/streamText.js'
import { newFormToken } from '../forms/reply.js'
import { withFormDefaults } from '../forms/defaults.js'
import type {
  BuildContextDeps,
  Button,
  ChatId,
  DefaultTools,
  MediaPayload,
  MediaRef,
  MediaSource,
  MessageContext as IMessageContext,
  MessageRef,
  OutboundContent,
  SendOptions,
  SentMessage,
  TextFormat,
} from './provider.js'

/** `ctx.textFormat`: the chat's own format, else the provider-wide one; omitted when neither is known. */
function textFormatOf(deps: BuildContextDeps, chatId: ChatId): { textFormat?: TextFormat } {
  const format = deps.textFormatFor?.(chatId) ?? deps.capabilities?.textFormat
  return format !== undefined ? { textFormat: format } : {}
}

/** Build the canonical MessageContext from a normalized inbound message. */
export function buildMessageContext(deps: BuildContextDeps): IMessageContext {
  const { inbound, tools, send } = deps
  const from = inbound.from
  const isGroup = inbound.isGroup
  const isPrivate = inbound.chat.kind === 'dm'

  // This context's own last reply (target of `ctx.edit(content)`), stamped with the
  // external-send clock so a later `bot.send`/`sendTo` to the chat invalidates it.
  let ownLast: { ref: MessageRef; kind: OutboundContent['kind']; at: number } | undefined

  const sendTo = async (chatId: ChatId, content: OutboundContent, opts?: SendOptions, via: BuildContextDeps['send'] = send): Promise<SentMessage> => {
    const r = await via(chatId, content, opts)
    if (chatId === from && !r.skipped && isEditableSend(content)) {
      ownLast = { ref: r.ref, kind: content.kind, at: deps.sendClock?.now() ?? 0 }
    }
    return { ref: r.ref, id: r.ref.id, chatId: r.ref.chatId, raw: r.raw, skipped: r.skipped }
  }
  const sendOut = (content: OutboundContent, opts?: SendOptions): Promise<SentMessage> => sendTo(from, content, opts)

  // Text replies run through the pacer (delay + typing indicator) when the bot provides one.
  const sendText = (t: string, opts?: ReplyOptions, sendOpts?: SendOptions): Promise<SentMessage> => {
    const run = () => sendOut({ kind: 'text', text: t }, sendOpts)
    return deps.pace ? deps.pace(from, t, opts, run) : run()
  }

  const skipped = (ref: MessageRef = { id: 'skipped', chatId: from }): SentMessage =>
    ({ ref, id: ref.id, chatId: ref.chatId, skipped: true })

  const edit = async (
    a: MessageRef | string | OutboundContent,
    b?: string | OutboundContent | EditOptions,
    c?: EditOptions,
  ): Promise<EditResult> => {
    const explicit = isMessageRef(a)
    const raw = (explicit ? b : a) as string | OutboundContent
    const opts = (explicit ? c : b as EditOptions | undefined) ?? {}
    const content: OutboundContent = typeof raw === 'string' ? { kind: 'text', text: raw } : raw
    // The implicit target is this context's own last reply, and only when it has the same
    // kind (editing text over a photo or poll is not a meaningful, or portable, edit) and no
    // send from outside this chat's ctx replies reached the chat after it.
    const own = explicit ? undefined : ownLast
    const fresh = own !== undefined && own.kind === content.kind
      && (deps.sendClock ? deps.sendClock.lastExternal(from) <= own.at : true)
    const target = explicit ? a : fresh ? own.ref : undefined
    const native = deps.editMessage && (deps.supports ? deps.supports('edit') === 'native' : true)
    if (target && native) {
      try {
        const r = await deps.editMessage!(target, content)
        // A before('send') hook blocked the edit: honor it, do not send a new message instead.
        if (r.skipped) return { ...skipped(target), edited: false }
        const ref = r.ref ?? target
        return { ref, id: ref.id, chatId: ref.chatId, raw: r.raw, edited: true }
      } catch (error) {
        if (!(error instanceof UnsupportedContentError)) throw error
      }
    }
    if (opts.fallback === 'skip') return { ...skipped(target), edited: false }
    // Degraded edit: a new message in the chat of the message being edited.
    const sent = await sendTo(target?.chatId ?? from, content)
    return { ...sent, edited: false }
  }

  const ctx: IMessageContext = {
    body: inbound.body,
    from,
    sender: inbound.sender,
    senderInfo: inbound.senderInfo,
    pushName: inbound.senderInfo.displayName,
    chat: inbound.chat,
    type: inbound.type,
    isGroup,
    isPrivate,
    isFromMe: inbound.fromMe,
    mentions: inbound.mentions,
    quoted: inbound.quoted,
    media: undefined,
    sharedLocation: inbound.location,
    ref: inbound.ref,
    raw: inbound.raw,
    timestamp: inbound.timestamp,

    // Interaction projection (Telegram/Discord). acknowledge() no-ops without one.
    interaction: deps.interaction,
    async acknowledge(text?: string) {
      if (deps.interaction && deps.acknowledgeInteraction) {
        await deps.acknowledgeInteraction(deps.interaction.id, text)
      }
    },

    /* Send helpers — build OutboundContent descriptors ------------------- */
    async say(t: string, opts?: ReplyOptions) { return sendText(t, opts) },
    async reply(t: string, opts?: ReplyOptions) { return sendText(t, opts) },
    async answer(t: string, opts?: ReplyOptions) { return sendText(t, opts) },
    async text(t: string, opts?: ReplyOptions) { return sendText(t, opts) },
    async photo(source: MediaSource, caption?: string) {
      return sendOut({ kind: 'image', media: source, caption })
    },
    async video(source: MediaSource, caption?: string, opts?: { gifPlayback?: boolean; ptv?: boolean }) {
      return sendOut({ kind: 'video', media: source, caption, gifPlayback: opts?.gifPlayback, ptv: opts?.ptv })
    },
    async audio(source: MediaSource) { return sendOut({ kind: 'audio', media: source }) },
    async voice(source: MediaSource) { return sendOut({ kind: 'voice', media: source }) },
    async file(source: MediaSource, filename?: string, caption?: string) {
      return sendOut({ kind: 'document', media: source, filename, caption })
    },
    async sticker(source: MediaSource, opts?: { pack?: string; author?: string }) {
      return sendOut({ kind: 'sticker', media: source, pack: opts?.pack, author: opts?.author })
    },
    async location(lat: number, lng: number, name?: string) {
      return sendOut({ kind: 'location', lat, lng, name })
    },
    async contact(phone: string, displayName?: string) {
      return sendOut({ kind: 'contact', phone, displayName })
    },
    async poll(question: string, options: string[], multiSelect = false) {
      return sendOut({ kind: 'poll', question, options, multiSelect })
    },
    async buttons(text: string, buttons: Button[]) {
      return sendOut({ kind: 'buttons', text, buttons })
    },
    async react(emoji: string, target?: MessageRef) {
      // Degrade to a no-op where reactions cannot be sent (Messenger, Instagram).
      if (deps.supports?.('react') === 'unsupported') return skipped()
      return sendOut({ kind: 'reaction', emoji, target: target ?? inbound.ref })
    },
    async quote(t: string, opts?: ReplyOptions) {
      return sendText(t, opts, { quoted: inbound.ref })
    },
    edit,
    supports(feature) { return deps.supports ? deps.supports(feature) : 'native' },
    async replyWithTyping(t: string, msPerChar = 40) {
      const ms = humanTypingDelay(t, msPerChar)
      await ctx.typing()
      await sleep(ms)
      // Straight to the send: replyWithTyping already paced itself (no BotConfig.typing on top).
      return sendOut({ kind: 'text', text: t })
    },
    async sendNative(provider: string, payload: unknown) {
      return sendOut({ kind: 'native', provider, payload })
    },
    stream(source, opts) {
      const stop = deps.stopSignal?.()
      if (stop) {
        const signal = opts?.signal ? AbortSignal.any([opts.signal, stop]) : stop
        opts = { ...opts, signal }
      }
      return streamText({
        capabilities: deps.capabilities,
        isPrivate,
        send: deps.streamSend ? (content, o) => sendTo(from, content, o, deps.streamSend!) : sendOut,
        edit: deps.streamEdit ? (ref, content) => deps.streamEdit!(ref, content) : undefined,
        delete: deps.deleteStreamMessage ? (ref) => deps.deleteStreamMessage!(ref) : undefined,
        draft: deps.sendDraft ? (draftId, text, o) => deps.sendDraft!(from, draftId, text, o) : undefined,
        typing: deps.typing ? () => deps.typing!(from, 'typing') : undefined,
        ...(stop ? { shutdown: stop } : {}),
      }, source, opts)
    },
    async form(definition, opts) {
      const token = opts?.token ?? newFormToken(definition.id)
      // Localized cta / submit label / body (core.form.*) in this message's language.
      const form = withFormDefaults(definition, (key, params) => ctx.t(key, params))
      return sendOut({ kind: 'form', form, token, ...(opts?.nativeId !== undefined ? { nativeId: opts.nativeId } : {}) })
    },
    capabilities: deps.capabilities,
    ...textFormatOf(deps, from),
    ...(deps.canRenderForm ? { canRenderForm: deps.canRenderForm } : {}),

    /* Actions — degrade to no-op when the provider lacks the capability -- */
    async markRead() { await deps.markRead?.(inbound.ref) },
    // Best-effort: a failing indicator never rejects (it must not abort the reply it precedes).
    async typing() { try { await deps.typing?.(from, 'typing') } catch { /* ignored */ } },
    async recording() { try { await deps.typing?.(from, 'recording') } catch { /* ignored */ } },
    async delete() { await deps.deleteMessage?.(inbound.ref) },

    /* Human handoff — resolves false when built without a bot (no `deps.handoff`) */
    async handoff(opts) { return deps.handoff ? deps.handoff(from, opts) : false },

    /* Dispatch control — `_passed`/`_aborted` are the Dispatcher's flags -- */
    pass() { (ctx as unknown as { _passed?: boolean })._passed = true },
    abort() { (ctx as unknown as { _aborted?: boolean })._aborted = true },

    user: deps.user ?? unavailableUserData(inbound.senderId),

    /* i18n — ctx.lang is re-resolved by the Bot inside the per-chat queue */
    lang: (deps.i18n ?? defaultI18n).defaultLocale,
    get defaultLang() { return (deps.i18n ?? defaultI18n).defaultLocale },
    t(key, params) { return (deps.i18n ?? defaultI18n).translate(ctx.lang, key, params) },
    async setLang(code: string) {
      const i18n = deps.i18n ?? defaultI18n
      const requested = normalizeLocale(code)
      if (!requested) throw new TypeError('setLang() expects a non-empty locale code')
      // Without i18n turned on the next message would ignore the preference, so refuse
      // instead of switching for a single reply.
      if (!i18n.enabled) {
        throw new Error('setLang(): i18n is not enabled; call bot.locale(...) or set BotConfig.i18n first')
      }
      const lang = i18n.supported(requested)
      if (!lang) {
        const shown = requested.length > 32 ? `${requested.slice(0, 32)}…` : requested
        throw new TypeError(`setLang(): no registered locale serves "${shown}" (see bot.locale())`)
      }
      await ctx.user.set(i18n.userKey, lang)
      ctx.lang = lang
      ctx.langSource = 'user'
    },

    tools: tools as DefaultTools,
  }

  // Stash the lazy-media handle for loadMediaOf().
  ;(ctx as unknown as { __mediaRef?: MediaRef; __downloadMedia?: BuildContextDeps['downloadMedia'] }).__mediaRef = inbound.media
  ;(ctx as unknown as { __downloadMedia?: BuildContextDeps['downloadMedia'] }).__downloadMedia = deps.downloadMedia

  return ctx
}

async function streamToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      // Leaving the loop early already ends a Node stream; destroy() covers other readables.
      ;(stream as { destroy?: () => void }).destroy?.()
      throw new MediaTooLargeError(total, maxBytes)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** Options of {@link loadMediaOf}. */
export interface LoadMediaOptions {
  /**
   * Refuse media larger than this many bytes with a `MediaTooLargeError`: checked
   * against the size the provider declared (before downloading anything) and
   * while reading the download, which is cut as soon as it goes over. Default: no cap.
   */
  maxBytes?: number
  /** Reject with the download error instead of resolving `undefined`. Default `false`. */
  throwOnError?: boolean
}

/**
 * Public accessor — `ctx.media` is populated on first call via the provider's downloader.
 * Resolves `undefined` when the message carries no media or (by default) the download fails.
 */
export async function loadMediaOf(ctx: IMessageContext, options: LoadMediaOptions = {}): Promise<MediaPayload | undefined> {
  const maxBytes = options.maxBytes ?? Infinity
  if (ctx.media) {
    if (ctx.media.buffer.length > maxBytes) throw new MediaTooLargeError(ctx.media.buffer.length, maxBytes)
    return ctx.media
  }
  const holder = ctx as unknown as {
    __mediaRef?: MediaRef
    __downloadMedia?: (ref: MediaRef) => Promise<Buffer | NodeJS.ReadableStream>
  }
  const ref = holder.__mediaRef
  const downloader = holder.__downloadMedia
  if (!ref || !downloader) return undefined
  if (ref.size !== undefined && ref.size > maxBytes) throw new MediaTooLargeError(ref.size, maxBytes)
  let buffer: Buffer
  try {
    const bufferOrStream = await downloader(ref)
    buffer = Buffer.isBuffer(bufferOrStream)
      ? bufferOrStream
      : await streamToBuffer(bufferOrStream as NodeJS.ReadableStream, maxBytes)
  } catch (error) {
    if (error instanceof MediaTooLargeError || options.throwOnError) throw error
    return undefined
  }
  if (buffer.length > maxBytes) throw new MediaTooLargeError(buffer.length, maxBytes)
  ctx.media = {
    buffer,
    mimetype: ref.mimetype ?? 'application/octet-stream',
    filename: ref.filename,
    size: ref.size,
  }
  return ctx.media
}
