/**
 * Evolution API webhook → normalized {@link InboundEvent}s.
 *
 * Identity: every user id goes through {@link WaIdentityStore}, which links the
 * LID/PN twins Evolution attaches (`remoteJidAlt`, `senderPn`, `participantAlt`,
 * `participantPn`, `senderLid`) so the same human always yields the same
 * `senderId` — even when a later payload only carries the LID.
 */

import type {
  ChatInfo,
  DisconnectReason,
  InboundEvent,
  InboundMessage,
  MediaRef,
  MessageType,
  QuotedRef,
  SenderInfo,
} from '@bot-wa/core'
import { isGroupJid, isLidJid, normalizeJid, type WaIdentityStore } from './identity.js'
import { isRecord } from './rest.js'
import type { EvolutionContextInfo, EvolutionMediaToken, EvolutionMessage, EvolutionMessageKey, EvolutionWebhook } from './types.js'

export interface ParseContext {
  identity: WaIdentityStore
  /** The bot's own canonical id (sender of `fromMe` messages). */
  selfId?: string | null
}

/** `MESSAGES_UPSERT` / `messages-upsert` / `messages.upsert` → `messages.upsert`. */
export function normalizeEventName(event: unknown): string {
  return typeof event === 'string' ? event.trim().toLowerCase().replace(/[_-]/g, '.') : ''
}

function toMs(ts: EvolutionMessage['messageTimestamp']): number {
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts
  if (typeof ts === 'string' && ts.trim() !== '' && Number.isFinite(Number(ts))) return toMs(Number(ts))
  if (isRecord(ts) && typeof ts.low === 'number') return toMs(ts.low >>> 0)
  return Date.now()
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const rec = (v: unknown): Record<string, unknown> | undefined => (isRecord(v) ? v : undefined)

/** Envelopes Baileys wraps real content in (disappearing mode, view once, document with caption). */
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']

/** The content inside any wrapper envelopes (bounded depth, like Baileys' normalizeMessageContent). */
export function unwrapMessage(message: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  let m = message
  for (let depth = 0; m && depth < 5; depth++) {
    const inner = WRAPPERS.map((w) => rec(rec(m![w])?.message)).find((x) => x !== undefined)
    if (!inner) break
    m = inner
  }
  return m
}

/** Plain text of a (possibly quoted) Baileys message object. */
export function textOf(raw: Record<string, unknown> | undefined): string {
  const message = unwrapMessage(raw)
  if (!message) return ''
  return (
    str(message.conversation) ??
    str(rec(message.extendedTextMessage)?.text) ??
    str(rec(message.imageMessage)?.caption) ??
    str(rec(message.videoMessage)?.caption) ??
    str(rec(message.documentMessage)?.caption) ??
    ''
  )
}

interface Classified {
  type: MessageType
  body: string
  mediaPart?: Record<string, unknown>
  contextInfo?: EvolutionContextInfo
}

function classify(raw: Record<string, unknown>): Classified {
  const m = unwrapMessage(raw) ?? {}
  const ctxOf = (part: Record<string, unknown> | undefined): EvolutionContextInfo | undefined =>
    rec(part?.contextInfo) as EvolutionContextInfo | undefined

  if (str(m.conversation) !== undefined) return { type: 'text', body: String(m.conversation) }
  const ext = rec(m.extendedTextMessage)
  if (ext) return { type: 'text', body: str(ext.text) ?? '', contextInfo: ctxOf(ext) }
  const image = rec(m.imageMessage)
  if (image) return { type: 'image', body: str(image.caption) ?? '', mediaPart: image, contextInfo: ctxOf(image) }
  const video = rec(m.videoMessage)
  if (video) return { type: 'video', body: str(video.caption) ?? '', mediaPart: video, contextInfo: ctxOf(video) }
  const audio = rec(m.audioMessage)
  if (audio) return { type: audio.ptt ? 'voice' : 'audio', body: '', mediaPart: audio, contextInfo: ctxOf(audio) }
  const doc = rec(m.documentMessage)
  if (doc) return { type: 'document', body: str(doc.caption) ?? '', mediaPart: doc, contextInfo: ctxOf(doc) }
  const sticker = rec(m.stickerMessage)
  if (sticker) return { type: 'sticker', body: '', mediaPart: sticker, contextInfo: ctxOf(sticker) }
  const loc = rec(m.locationMessage) ?? rec(m.liveLocationMessage)
  if (loc) return { type: 'location', body: str(loc.name) ?? str(loc.address) ?? '', contextInfo: ctxOf(loc) }
  const contact = rec(m.contactMessage)
  if (contact) return { type: 'contact', body: str(contact.displayName) ?? '', contextInfo: ctxOf(contact) }
  const poll = rec(m.pollCreationMessage) ?? rec(m.pollCreationMessageV2) ?? rec(m.pollCreationMessageV3)
  if (poll) return { type: 'poll', body: str(poll.name) ?? '' }
  const btn = rec(m.buttonsResponseMessage)
  if (btn) return { type: 'buttons', body: str(btn.selectedDisplayText) ?? str(btn.selectedButtonId) ?? '' }
  const tpl = rec(m.templateButtonReplyMessage)
  if (tpl) return { type: 'buttons', body: str(tpl.selectedDisplayText) ?? str(tpl.selectedId) ?? '' }
  const list = rec(m.listResponseMessage)
  if (list) return { type: 'list', body: str(list.title) ?? str(rec(list.singleSelectReply)?.selectedRowId) ?? '' }
  return { type: 'unknown', body: '' }
}

const MEDIA_TYPES = new Set<MessageType>(['image', 'video', 'audio', 'voice', 'document', 'sticker'])
/** Protocol/system payloads that are not user messages. */
const SKIP_PARTS = ['protocolMessage', 'senderKeyDistributionMessage', 'editedMessage', 'pollUpdateMessage', 'messageContextInfo']

function isSystemOnly(m: Record<string, unknown>): boolean {
  const keys = Object.keys(m).filter((k) => k !== 'base64' && k !== 'mediaUrl')
  return keys.length > 0 && keys.every((k) => SKIP_PARTS.includes(k))
}

function senderFor(key: EvolutionMessageKey, group: boolean, chatId: string, ctx: ParseContext): string | undefined {
  if (key.fromMe) return ctx.selfId ?? undefined
  if (group) {
    return ctx.identity.resolve(key.participant, key.participantAlt, key.participantPn, key.senderPn, key.senderLid)
  }
  return chatId
}

/** Normalize one `messages.upsert` item. Returns an event list (message or reaction), possibly empty. */
export function parseMessage(data: EvolutionMessage, ctx: ParseContext): InboundEvent[] {
  const key = data.key
  if (!isRecord(key)) return []
  const remote = normalizeJid(key.remoteJid)
  if (!remote || remote === 'status@broadcast') return []
  const m = rec(data.message) ?? {}
  if (isSystemOnly(unwrapMessage(m) ?? m)) return []

  const group = isGroupJid(remote)
  const channel = remote.endsWith('@newsletter')
  const broadcast = remote.endsWith('@broadcast')
  const chatId = group || channel || broadcast
    ? remote
    // senderPn/senderLid describe the stanza sender — the bot itself on fromMe — so only
    // remoteJidAlt (the peer's twin) may be linked to the chat then.
    : ctx.identity.resolve(remote, key.remoteJidAlt, ...(key.fromMe ? [] : [key.senderPn, key.senderLid])) ?? remote
  const senderId = senderFor(key, group, chatId, ctx) ?? (key.fromMe ? 'me' : chatId)

  const reaction = rec(m.reactionMessage)
  if (reaction) {
    const target = rec(reaction.key) as EvolutionMessageKey | undefined
    if (!target?.id) return []
    const emoji = str(reaction.text) ?? ''
    return [{
      kind: 'reaction',
      reaction: { ref: { id: target.id, chatId, native: target }, emoji, senderId, removed: emoji === '' },
    }]
  }

  const kind = group ? 'group' : channel ? 'channel' : broadcast ? 'broadcast' : 'dm'
  const chat: ChatInfo = { id: chatId, kind, isGroup: group, isBroadcast: broadcast || channel }
  const c = classify(m)
  const contextInfo = c.contextInfo ?? data.contextInfo
  const rawWho = normalizeJid(group ? key.participant : key.remoteJid)
  const senderInfo: SenderInfo = {
    id: senderId,
    displayName: key.fromMe ? undefined : str(data.pushName),
    platformData: {
      jid: rawWho,
      lid: rawWho && isLidJid(rawWho) ? rawWho : undefined,
      phoneNumber: !senderId.endsWith('@lid') && senderId !== 'me' ? senderId : undefined,
    },
  }

  let media: MediaRef | undefined
  if (MEDIA_TYPES.has(c.type)) {
    const part = c.mediaPart ?? {}
    const token: EvolutionMediaToken = { key, base64: str(m.base64) }
    const size = Number(part.fileLength)
    media = {
      kind: c.type as MediaRef['kind'],
      mimetype: str(part.mimetype),
      filename: str(part.fileName),
      size: Number.isFinite(size) && size > 0 ? size : undefined,
      token,
    }
  }

  let quoted: QuotedRef | undefined
  if (contextInfo?.stanzaId) {
    const quotedSender = contextInfo.participant ? ctx.identity.lookup(contextInfo.participant) : undefined
    quoted = {
      ref: { id: contextInfo.stanzaId, chatId, native: { id: contextInfo.stanzaId, remoteJid: key.remoteJid, participant: contextInfo.participant } },
      body: textOf(rec(contextInfo.quotedMessage)),
      senderId: quotedSender,
    }
  }
  const mentions = (contextInfo?.mentionedJid ?? [])
    .map((j) => ctx.identity.lookup(j))
    .filter((j): j is string => j !== undefined)

  const message: InboundMessage<EvolutionMessage> = {
    ref: { id: str(key.id) ?? '', chatId, native: key },
    chat,
    senderInfo,
    from: chatId,
    sender: senderId,
    chatId,
    senderId,
    isGroup: group,
    isBroadcast: chat.isBroadcast,
    fromMe: !!key.fromMe,
    type: c.type,
    body: c.body,
    timestamp: toMs(data.messageTimestamp),
    mentions,
    quoted,
    media,
    raw: data,
  }
  return [{ kind: 'message', message }]
}

const STATUS_MAP: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
}

function parseStatus(data: Record<string, unknown>, ctx: ParseContext): InboundEvent | undefined {
  const status = STATUS_MAP[String(data.status ?? '').toUpperCase()]
  const id = str(data.keyId) ?? str(rec(data.key)?.id)
  const remote = str(data.remoteJid) ?? str(rec(data.key)?.remoteJid)
  if (!status || !id || !remote) return undefined
  const chatId = isGroupJid(remote) ? remote : ctx.identity.lookup(remote) ?? remote
  return {
    kind: 'status',
    status: {
      ref: { id, chatId, native: { id, remoteJid: remote, fromMe: data.fromMe, participant: data.participant } },
      status,
      recipient: chatId,
      timestamp: Date.now(),
    },
  }
}

function parseConnection(data: Record<string, unknown>): InboundEvent | undefined {
  const state = str(data.state)
  if (state === 'open') return { kind: 'connection', update: { state: 'ready' } }
  if (state === 'connecting') return { kind: 'connection', update: { state: 'connecting' } }
  if (state === 'close') {
    const code = Number(data.statusReason)
    const reason: DisconnectReason = code === 401 ? 'sessionInvalid' : code === 440 ? 'sessionTakenOver' : 'transient'
    return { kind: 'connection', update: { state: 'closed', reason, detail: Number.isFinite(code) ? { code } : undefined } }
  }
  return undefined
}

function parseQr(data: Record<string, unknown>): InboundEvent | undefined {
  const qr = rec(data.qrcode) ?? data
  const code = str(qr.code) ?? str(qr.pairingCode)
  if (!code) return undefined
  return { kind: 'connection', update: { state: 'authenticating', authPayload: code } }
}

function parseCall(data: Record<string, unknown>, ctx: ParseContext): InboundEvent | undefined {
  const id = str(data.id)
  const from = ctx.identity.resolve(data.from, data.callerPn)
  if (!id || !from) return undefined
  const chat = normalizeJid(data.chatId)
  const isGroup = data.isGroup === true || (chat !== undefined && isGroupJid(chat))
  return {
    kind: 'call',
    event: {
      id,
      from,
      status: str(data.status) ?? 'offer',
      ...(isGroup && chat ? { chatId: chat, isGroup: true } : {}),
      ...(typeof data.isVideo === 'boolean' ? { isVideo: data.isVideo } : {}),
      ...(typeof data.offline === 'boolean' ? { offline: data.offline } : {}),
    },
  }
}

const GROUP_ACTIONS = new Set(['add', 'remove', 'promote', 'demote'])

function parseGroupParticipants(data: Record<string, unknown>, ctx: ParseContext): InboundEvent | undefined {
  const chatId = normalizeJid(data.id)
  const action = str(data.action)
  if (!chatId || !action || !GROUP_ACTIONS.has(action)) return undefined
  const list = Array.isArray(data.participants) ? data.participants : []
  const participants = list
    .map((p) => (isRecord(p) ? ctx.identity.resolve(p.id, p.phoneNumber, p.lid) : ctx.identity.lookup(p)))
    .filter((p): p is string => p !== undefined)
  const actor = data.author ? ctx.identity.lookup(data.author) : undefined
  return {
    kind: 'group',
    event: { chatId, action: action as 'add' | 'remove' | 'promote' | 'demote', participants, ...(actor ? { actor } : {}) },
  }
}

/** Normalize one whole webhook envelope. Unknown events yield `[]`. */
export function parseWebhook(body: EvolutionWebhook, ctx: ParseContext): InboundEvent[] {
  const event = normalizeEventName(body.event)
  const items = Array.isArray(body.data) ? body.data : body.data === undefined ? [] : [body.data]
  const out: InboundEvent[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    switch (event) {
      case 'messages.upsert':
        out.push(...parseMessage(item as unknown as EvolutionMessage, ctx))
        break
      case 'messages.update': {
        const e = parseStatus(item, ctx)
        if (e) out.push(e)
        break
      }
      case 'connection.update': {
        const e = parseConnection(item)
        if (e) out.push(e)
        break
      }
      case 'qrcode.updated': {
        const e = parseQr(item)
        if (e) out.push(e)
        break
      }
      case 'call': {
        const e = parseCall(item, ctx)
        if (e) out.push(e)
        break
      }
      case 'group.participants.update': {
        const e = parseGroupParticipants(item, ctx)
        if (e) out.push(e)
        break
      }
      default:
        break
    }
  }
  return out
}
