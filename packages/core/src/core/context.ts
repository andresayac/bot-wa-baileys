/**
 * MessageContext — the ergonomic object handed to every handler.
 *
 * Transport-agnostic: it wraps an already-normalized {@link InboundMessage} and
 * a `send(OutboundContent)` provided by the transport. All proto parsing, JID /
 * LID-PN handling and media transcoding live in the provider (e.g. @bot-wa/baileys),
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
import { MediaTooLargeError } from './provider.js'
import type {
  BuildContextDeps,
  Button,
  DefaultTools,
  MediaPayload,
  MediaRef,
  MediaSource,
  MessageContext as IMessageContext,
  SendOptions,
  SentMessage,
} from './provider.js'

/** Build the canonical MessageContext from a normalized inbound message. */
export function buildMessageContext(deps: BuildContextDeps): IMessageContext {
  const { inbound, tools, send } = deps
  const from = inbound.from
  const isGroup = inbound.isGroup
  const isPrivate = inbound.chat.kind === 'dm'

  const sendOut = async (content: Parameters<typeof send>[1], opts?: SendOptions): Promise<SentMessage> => {
    const r = await send(from, content, opts)
    return { ref: r.ref, id: r.ref.id, chatId: r.ref.chatId, raw: r.raw, skipped: r.skipped }
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
    async say(t: string) { return sendOut({ kind: 'text', text: t }) },
    async reply(t: string) { return sendOut({ kind: 'text', text: t }) },
    async answer(t: string) { return sendOut({ kind: 'text', text: t }) },
    async text(t: string) { return sendOut({ kind: 'text', text: t }) },
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
    async react(emoji: string) {
      return sendOut({ kind: 'reaction', emoji, target: inbound.ref })
    },
    async quote(t: string) {
      return sendOut({ kind: 'text', text: t }, { quoted: inbound.ref })
    },
    async replyWithTyping(t: string, msPerChar = 40) {
      const ms = humanTypingDelay(t, msPerChar)
      await ctx.typing()
      await sleep(ms)
      return ctx.text(t)
    },
    async sendNative(provider: string, payload: unknown) {
      return sendOut({ kind: 'native', provider, payload })
    },

    /* Actions — degrade to no-op when the provider lacks the capability -- */
    async markRead() { await deps.markRead?.(inbound.ref) },
    async typing() { await deps.typing?.(from, 'typing') },
    async recording() { await deps.typing?.(from, 'recording') },
    async delete() { await deps.deleteMessage?.(inbound.ref) },

    /* Human handoff — resolves false when built without a bot (no `deps.handoff`) */
    async handoff(opts) { return deps.handoff ? deps.handoff(from, opts) : false },

    /* Dispatch control — `_passed`/`_aborted` are the Dispatcher's flags -- */
    pass() { (ctx as unknown as { _passed?: boolean })._passed = true },
    abort() { (ctx as unknown as { _aborted?: boolean })._aborted = true },

    user: deps.user ?? unavailableUserData(inbound.senderId),

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
