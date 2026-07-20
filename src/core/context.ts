/**
 * MessageContext — built for every inbound message.
 *
 * Provides ergonomic reply helpers wrapping Baileys' low-level `sendMessage`,
 * plus hooks for abort/next used by the {@link HookSystem}. An instance is
 * passed to every `when()` handler, `onMessage()` handler, typed-media handler
 * and flow action.
 *
 * @example Reply with text
 * ```ts
 * bot.when('hola', async (ctx) => await ctx.reply('👋 ¡Hola!'))
 * ```
 *
 * @example Send media
 * ```ts
 * bot.when('foto', async (ctx) => await ctx.photo('https://picsum.photos/400/300', '📸'))
 * bot.when('sticker', async (ctx) => await ctx.sticker('https://picsum.photos/512/512', { pack: 'Demo' }))
 * bot.when('audio', async (ctx) => await ctx.voice('https://example.com/beep.mp3'))
 * ```
 *
 * @example Location, contact, poll
 * ```ts
 * await ctx.location(4.7110, -74.0721, 'Bogotá 🇨🇴')
 * await ctx.contact('573001234567', 'Soporte')
 * await ctx.poll('¿Qué te parece?', ['👍', '👌', '👎'], false)
 * ```
 *
 * @example React, quote, typing
 * ```ts
 * await ctx.react('👍')
 * await ctx.quote('respondiendo a tu mensaje')
 * await ctx.replyWithTyping('escribiendo...')
 * ```
 */

import type { proto, WAMessage, WAMessageKey } from '@whiskeysockets/baileys'
import { getContentType } from '@whiskeysockets/baileys'

import type {
  ChatId,
  DefaultTools,
  MediaOptions,
  MediaPayload,
  MediaSource,
  MessageContext as IMessageContext,
  MessageType,
  SenderInfo,
  ChatInfo,
  SentMessage,
  UserId,
} from './types'

import { normalize } from '../utils/jid'
import { humanTypingDelay, sleep } from '../utils/timers'

export interface MediaProcessorAPI {
  toMediaUpload: (source: MediaSource) => any
  makeSticker: (source: MediaSource, opts?: { pack?: string; author?: string }) => Promise<Buffer>
  transcodeToOpus: (source: MediaSource) => Promise<Buffer>
}

export interface BuildContextDeps {
  rawMessage: proto.IWebMessageInfo
  tools: any
  /** Send a content payload via the provider (already-jid-resolved). */
  send: (jid: ChatId, content: any, options?: any) => Promise<WAMessage>
  /** Read receipts */
  markRead?: (key: WAMessageKey) => Promise<void>
  /** Presence update — used by typing()/recording() */
  presence?: (state: 'composing' | 'recording' | 'paused', jid?: ChatId) => Promise<void>
  /** Delete a message */
  deleteMessage?: (key: WAMessageKey) => Promise<void>
  /** Media processor functions (injected, no dynamic imports) */
  media: MediaProcessorAPI
}

/** Build the canonical MessageContext from a raw Baileys message. */
export function buildMessageContext(deps: BuildContextDeps): IMessageContext {
  const { rawMessage, send, tools, media: mediaApi } = deps
  const msg = rawMessage
  const key = (msg.key ?? { remoteJid: '', fromMe: false }) as WAMessageKey
  // Baileys 7: prefer PN JID (@s.whatsapp.net) over LID (@lid) for sending replies
  // key.remoteJid may be @lid, but key.remoteJidAlt has the @s.whatsapp.net form
  const rawFrom = (key as any).remoteJidAlt ?? key.remoteJid ?? ''
  const from = normalize(rawFrom as string) as ChatId

  const isGroup = from.endsWith('@g.us')
  const isPrivate = !isGroup && from.endsWith('@s.whatsapp.net')
  const senderId = normalize(
    isGroup
      ? ((msg as any).participant ?? (key as any).participantAlt ?? (key as any).participant ?? key.remoteJid ?? '')
      : (key.remoteJid ?? '')
  ) as UserId

  const sender: SenderInfo = {
    id: senderId,
    name: undefined,
    pushName: msg.pushName ?? undefined,
  }

  const chat: ChatInfo = {
    id: from,
    name: undefined,
    isGroup,
    isBroadcast: from === 'status@broadcast' || from.endsWith('@broadcast'),
  }

  // Body & type — extracted from the rich Baileys message object
  let body = ''
  let type: MessageType = 'unknown'
  let media: MediaPayload | undefined

  const contentType = getContentType(msg.message ?? undefined) ?? ''
  const m = msg.message ?? {}

  if (m.conversation || m.extendedTextMessage?.text) {
    body = (m.conversation ?? m.extendedTextMessage?.text ?? '').toString()
    type = 'text'
  } else if (m.imageMessage) {
    type = 'image'
    body = m.imageMessage.caption ?? ''
  } else if (m.videoMessage) {
    type = 'video'
    body = m.videoMessage.caption ?? ''
  } else if (m.audioMessage) {
    type = (m.audioMessage as any).ptt ? 'voice' : 'audio'
  } else if (m.stickerMessage) {
    type = 'sticker'
  } else if (m.documentMessage) {
    type = 'document'
    body = m.documentMessage.caption ?? ''
  } else if (m.locationMessage) {
    type = 'location'
  } else if (m.contactMessage) {
    type = 'contact'
  } else if (m.pollCreationMessage || m.pollUpdateMessage) {
    type = 'poll'
  } else if (m.buttonsResponseMessage) {
    type = 'buttons'
    body = m.buttonsResponseMessage.selectedDisplayText ?? ''
  } else if (m.listResponseMessage) {
    type = 'list'
    body = m.listResponseMessage.title ?? ''
  }

  // Quoted message body if present
  const quotedContext = m.extendedTextMessage?.contextInfo
  const quoted = quotedContext?.quotedMessage
    ? {
        body:
          ((quotedContext.quotedMessage as any).conversation as string | undefined) ??
          ((quotedContext.quotedMessage as any).extendedTextMessage?.text as string | undefined) ??
          '',
        from: (quotedContext.participant as string | undefined) ?? from,
        sender: (quotedContext.participant as string | undefined) ?? undefined,
      }
    : undefined

  const mentions: UserId[] = (quotedContext?.mentionedJid ?? []) as UserId[]

  // Reply helpers — each maps toBaileys sendMessage content ---------------

  const sendOut = async (content: any, opts?: any): Promise<SentMessage> => {
    const sent = await send(from, content, opts)
    return {
      jid: from,
      messageId: sent.key.id!,
      key: sent.key,
      raw: sent,
    }
  }

  // Lazily-loaded media buffer accessor
  const ctx: IMessageContext = {
    body,
    from,
    sender,
    chat,
    type,
    isGroup,
    isPrivate,
    isFromMe: !!key.fromMe,
    mentions,
    quoted,
    media,
    rawMessage: msg,
    key,
    timestamp: (msg.messageTimestamp as number) ?? Date.now(),

    /* Send helpers ------------------------------------------------------ */
    async say(t: string) {
      return sendOut({ text: t })
    },
    async reply(t: string) {
      return sendOut({ text: t })
    },
    async answer(t: string) {
      return sendOut({ text: t })
    },
    async text(t: string) {
      return sendOut({ text: t })
    },
    async photo(source: MediaSource, caption?: string) {
      const media = mediaApi.toMediaUpload(source)
      return sendOut({ image: media, caption })
    },
    async video(source: MediaSource, caption?: string, opts: MediaOptions = {}) {
      return sendOut({
        video: mediaApi.toMediaUpload(source),
        caption,
        ptv: opts.ptv,
        gifPlayback: opts.gifPlayback,
      })
    },
    async audio(source: MediaSource) {
      const uploaded = mediaApi.toMediaUpload(source)
      if ('url' in uploaded || typeof uploaded === 'string') {
        return sendOut({ audio: uploaded, mimetype: 'audio/ogg; codecs=opus', ptt: false })
      }
      const opus = await mediaApi.transcodeToOpus(source)
      return sendOut({ audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: false })
    },
    async voice(source: MediaSource) {
      const opus = await mediaApi.transcodeToOpus(source)
      return sendOut({ audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true })
    },
    async file(source: MediaSource, filename?: string, caption?: string) {
      return sendOut({
        document: mediaApi.toMediaUpload(source),
        fileName: filename,
        caption,
      })
    },
    async sticker(source: MediaSource, opts: Pick<MediaOptions, 'pack' | 'author'> = {}) {
      const sticker = await mediaApi.makeSticker(source, opts)
      return sendOut({ sticker })
    },
    async location(lat: number, lng: number, name?: string) {
      return sendOut({
        location: { degreesLatitude: lat, degreesLongitude: lng, name },
      })
    },
    async contact(phone: string, displayName?: string) {
      const vcard =
        'BEGIN:VCARD\n' +
        'VERSION:3.0\n' +
        `FN:${displayName ?? phone}\n` +
        `TEL;type=CELL;type=VOICE;waid=${phone.replace(/[^\d]/g, '')}:${phone}\n` +
        'END:VCARD'
      return sendOut({
        contacts: { displayName: displayName ?? phone, contacts: [{ vcard }] },
      })
    },
    async poll(question: string, options: string[], multiSelect = false) {
      return sendOut({
        poll: { name: question, values: options, selectableCount: multiSelect ? options.length : 1 },
      })
    },
    async react(emoji: string) {
      return sendOut({ react: { text: emoji, key } })
    },
    async quote(t: string) {
      return sendOut({ text: t }, { quoted: msg })
    },
    async replyWithTyping(t: string, msPerChar = 40) {
      const ms = humanTypingDelay(t, msPerChar)
      await ctx.typing()
      await sleep(ms)
      return ctx.text(t)
    },

    /* Actions ----------------------------------------------------------- */
    async markRead() {
      await deps.markRead?.(key)
    },
    async typing() {
      await deps.presence?.('composing', from)
    },
    async recording() {
      await deps.presence?.('recording', from)
    },
    async delete() {
      await deps.deleteMessage?.(key)
    },

    /* Flow control ------------------------------------------------------ */
    abort() {
      // Signal picked up by HookSystem.runBefore
      ;(ctx as any).__aborted = true
    },
    tools: tools as DefaultTools,
  }

  return ctx
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Public accessor — `ctx.media` is populated on first call. */
export async function loadMediaOf(ctx: IMessageContext): Promise<MediaPayload | undefined> {
  if (ctx.media) return ctx.media
  const downloader = (ctx as any).__mediaDownloader as
    | ((m: proto.IWebMessageInfo) => Promise<Buffer | NodeJS.ReadableStream>)
    | undefined
  if (!downloader) return undefined
  if (ctx.type === 'unknown' || ctx.type === 'text' || ctx.type === 'poll') return undefined
  try {
    const bufferOrStream = await downloader(ctx.rawMessage)
    const buffer = Buffer.isBuffer(bufferOrStream)
      ? bufferOrStream
      : await streamToBuffer(bufferOrStream as NodeJS.ReadableStream)
    const messagePayload = ctx.rawMessage.message ?? undefined
    const contentType = getContentType(messagePayload) ?? ''
    const part = (messagePayload as any)?.[contentType]
    ctx.media = {
      buffer,
      mimetype: part?.mimetype ?? 'application/octet-stream',
      filename: part?.fileName,
    }
    return ctx.media
  } catch {
    return undefined
  }
}
