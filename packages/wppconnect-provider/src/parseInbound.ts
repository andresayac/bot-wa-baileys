/**
 * wppconnect-server webhook → normalized {@link InboundEvent}s.
 *
 * Identity: user ids go through {@link WaIdentityStore}. Aliases the payload
 * carries (`sender.phoneNumber` / `sender.lid`) are linked here; the provider
 * additionally resolves unknown LIDs through the `contact/pn-lid` endpoint
 * BEFORE calling this mapper (see `WPPConnectProvider.ingest`).
 */

import { toInboundLocation } from '@botmesh/core'
import type {
  ChatInfo,
  DisconnectReason,
  InboundEvent,
  InboundMessage,
  MediaRef,
  MessageType,
  QuotedRef,
  SenderInfo,
} from '@botmesh/core'
import { isGroupJid, isLidJid, isRecord, normalizeJid, type WaIdentityStore } from '@botmesh/wa-gateway-kit'
import type { WppId, WppMediaToken, WppMessage } from './types.js'

export interface ParseContext {
  identity: WaIdentityStore
  /** The bot's own canonical id (sender of `fromMe` messages). */
  selfId?: string | null
}

/** Serialized form of a WA-JS id (string or `{ _serialized }`). */
export function serializedId(id: unknown): string | undefined {
  if (typeof id === 'string') return id || undefined
  if (isRecord(id)) {
    if (typeof id._serialized === 'string' && id._serialized) return id._serialized
    if (typeof id.user === 'string' && typeof id.server === 'string') return `${id.user}@${id.server}`
  }
  return undefined
}

/** A WA-JS user/chat id normalized to a JID string. */
export const jidOf = (id: unknown): string | undefined => normalizeJid(serializedId(id))

/** The chat (`remote`) part of a serialized message id: `false_<remote>_<id>[_<participant>]`. */
export function remoteOfMessageId(id: unknown): string | undefined {
  if (isRecord(id) && id.remote !== undefined) return jidOf(id.remote)
  const s = serializedId(id)
  const m = s ? /^(?:true|false)_([^_]+@[^_]+)_/.exec(s) : null
  return m ? normalizeJid(m[1]) : undefined
}

const TYPE_MAP: Record<string, MessageType> = {
  chat: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  ptt: 'voice',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
  vcard: 'contact',
  multi_vcard: 'contact',
  poll_creation: 'poll',
  list_response: 'list',
  buttons_response: 'buttons',
  template_button_reply: 'buttons',
}

/** System/protocol message types that never reach handlers. */
const SKIP_TYPES = new Set(['e2e_notification', 'notification_template', 'notification', 'gp2', 'protocol', 'revoked', 'ciphertext', 'call_log', 'broadcast_notification'])
const MEDIA_TYPES = new Set<MessageType>(['image', 'video', 'audio', 'voice', 'document', 'sticker'])

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function bodyFor(type: MessageType, m: WppMessage): string {
  switch (type) {
    case 'text':
    case 'list':
    case 'buttons':
      return str(m.body) ?? ''
    case 'image':
    case 'video':
    case 'document':
      // WA-JS puts the base64 thumbnail in `body` for media; the text is the caption.
      return str(m.caption) ?? ''
    case 'location':
      return str(m.loc) ?? ''
    case 'contact':
      return str(m.vcardFormattedName) ?? ''
    case 'poll':
      return str(m.pollName) ?? ''
    default:
      return ''
  }
}

/** Every alias in a message that may need LID→PN resolution. */
export function lidsIn(m: Record<string, unknown>): string[] {
  const candidates = [m.from, m.to, m.author, m.chatId, m.quotedParticipant, isRecord(m.sender) ? m.sender.id : undefined, m.peerJid, m.senderUserJid, m.who]
  if (Array.isArray(m.mentionedJidList)) candidates.push(...m.mentionedJidList)
  if (Array.isArray(m.who)) candidates.push(...m.who)
  return [...new Set(candidates.map(jidOf).filter((j): j is string => j !== undefined && isLidJid(j)))]
}

/** Normalize an `onmessage` payload. */
export function parseMessage(m: WppMessage, ctx: ParseContext): InboundEvent[] {
  const msgId = serializedId(m.id)
  if (!msgId) return []
  const rawType = str(m.type) ?? 'unknown'
  if (SKIP_TYPES.has(rawType)) return []
  const fromMe = m.fromMe === true || (isRecord(m.id) && m.id.fromMe === true) || msgId.startsWith('true_')
  const remote = jidOf(m.chatId) ?? (fromMe ? jidOf(m.to) : jidOf(m.from)) ?? remoteOfMessageId(m.id)
  if (!remote || remote === 'status@broadcast') return []

  const group = m.isGroupMsg === true || isGroupJid(remote)
  const channel = remote.endsWith('@newsletter')
  const broadcast = remote.endsWith('@broadcast')
  const sender = isRecord(m.sender) ? m.sender : undefined
  const senderPn = jidOf(sender?.phoneNumber)
  const senderLid = jidOf(sender?.lid)

  const chatId = group || channel || broadcast
    ? remote
    : ctx.identity.resolve(remote, ...(fromMe ? [] : [senderPn, senderLid])) ?? remote
  let senderId: string
  if (fromMe) senderId = ctx.selfId ?? 'me'
  else if (group) senderId = ctx.identity.resolve(m.author ? jidOf(m.author) : jidOf(sender?.id), senderPn, senderLid) ?? remote
  else senderId = chatId

  const type: MessageType = TYPE_MAP[rawType] ?? 'unknown'
  const kind = group ? 'group' : channel ? 'channel' : broadcast ? 'broadcast' : 'dm'
  const chat: ChatInfo = { id: chatId, kind, isGroup: group, isBroadcast: broadcast || channel }
  const rawWho = group ? jidOf(m.author) ?? jidOf(sender?.id) : jidOf(m.from)
  const senderInfo: SenderInfo = {
    id: senderId,
    displayName: fromMe ? undefined : str(sender?.pushname) ?? str(m.notifyName) ?? str(sender?.name),
    platformData: {
      jid: rawWho,
      lid: rawWho && isLidJid(rawWho) ? rawWho : senderLid,
      phoneNumber: !isLidJid(senderId) && senderId !== 'me' ? senderId : undefined,
      ...(typeof sender?.isBusiness === 'boolean' ? { isBusiness: sender.isBusiness } : {}),
    },
  }

  let media: MediaRef | undefined
  if (MEDIA_TYPES.has(type)) {
    const token: WppMediaToken = { messageId: msgId }
    media = {
      kind: type as MediaRef['kind'],
      mimetype: str(m.mimetype),
      filename: str(m.filename),
      size: typeof m.size === 'number' && m.size > 0 ? m.size : undefined,
      token,
    }
  }

  let quoted: QuotedRef | undefined
  const quotedId = serializedId(m.quotedMsgId) ?? str(m.quotedStanzaID)
  if (quotedId) {
    const qp = jidOf(m.quotedParticipant)
    quoted = {
      ref: { id: quotedId, chatId, native: { id: quotedId, participant: qp } },
      body: str(m.quotedMsg?.body) ?? str(m.quotedMsg?.caption) ?? '',
      senderId: qp ? ctx.identity.lookup(qp) : undefined,
    }
  }
  const mentions = (Array.isArray(m.mentionedJidList) ? m.mentionedJidList : [])
    .map((j: WppId) => ctx.identity.lookup(jidOf(j)))
    .filter((j): j is string => j !== undefined)

  const location = type === 'location'
    ? toInboundLocation({ latitude: m.lat, longitude: m.lng, name: m.loc, live: m.isLive === true })
    : undefined
  const t = typeof m.t === 'number' ? m.t : Number(m.t)
  const message: InboundMessage<WppMessage> = {
    ref: { id: msgId, chatId, native: { id: msgId, remote, fromMe } },
    chat,
    senderInfo,
    from: chatId,
    sender: senderId,
    chatId,
    senderId,
    isGroup: group,
    isBroadcast: chat.isBroadcast,
    fromMe,
    type,
    body: bodyFor(type, m),
    timestamp: Number.isFinite(t) && t > 0 ? (t < 1e12 ? t * 1000 : t) : Date.now(),
    mentions,
    quoted,
    media,
    ...(location ? { location } : {}),
    raw: m,
  }
  return [{ kind: 'message', message }]
}

/** WA-JS ACK levels → neutral delivery status. */
function ackStatus(ack: unknown): 'sent' | 'delivered' | 'read' | 'failed' | undefined {
  const n = Number(ack)
  if (!Number.isFinite(n)) return undefined
  if (n < 0) return 'failed'
  if (n === 1) return 'sent'
  if (n === 2) return 'delivered'
  if (n >= 3) return 'read'
  return undefined
}

function parseAck(d: Record<string, unknown>, ctx: ParseContext): InboundEvent | undefined {
  const status = ackStatus(d.ack)
  const id = serializedId(d.id)
  const remote = remoteOfMessageId(d.id) ?? jidOf(d.to)
  if (!status || !id || !remote) return undefined
  const chatId = isGroupJid(remote) ? remote : ctx.identity.lookup(remote) ?? remote
  return { kind: 'status', status: { ref: { id, chatId, native: { id, remote } }, status, recipient: chatId, timestamp: Date.now() } }
}

function parseReaction(d: Record<string, unknown>, ctx: ParseContext): InboundEvent | undefined {
  const target = serializedId(d.msgId)
  const remote = remoteOfMessageId(d.msgId) ?? remoteOfMessageId(d.id)
  const senderId = ctx.identity.resolve(jidOf(d.senderUserJid) ?? jidOf(d.sender))
  if (!target || !remote || !senderId) return undefined
  const chatId = isGroupJid(remote) ? remote : ctx.identity.lookup(remote) ?? remote
  const emoji = str(d.reactionText) ?? ''
  return { kind: 'reaction', reaction: { ref: { id: target, chatId, native: { id: target, remote } }, emoji, senderId, removed: emoji === '' } }
}

function parseCall(d: Record<string, unknown>, ctx: ParseContext): InboundEvent | undefined {
  const id = str(d.id) ?? serializedId(d.id)
  const from = ctx.identity.resolve(jidOf(d.peerJid) ?? jidOf(d.sender))
  if (!id || !from) return undefined
  const group = jidOf(d.groupJid)
  return {
    kind: 'call',
    event: {
      id,
      from,
      status: 'offer',
      ...(d.isGroup === true && group ? { chatId: group, isGroup: true } : {}),
      ...(typeof d.isVideo === 'boolean' ? { isVideo: d.isVideo } : {}),
    },
  }
}

const GROUP_ACTIONS = new Set(['add', 'remove', 'promote', 'demote'])

function parseParticipants(d: Record<string, unknown>, ctx: ParseContext): InboundEvent | undefined {
  const chatId = jidOf(d.groupId) ?? jidOf(d.chatId)
  const action = str(d.action)
  if (!chatId || !action || !GROUP_ACTIONS.has(action)) return undefined
  const who = Array.isArray(d.who) ? d.who : d.who !== undefined ? [d.who] : []
  const participants = who.map((w: unknown) => ctx.identity.lookup(jidOf(w))).filter((p): p is string => p !== undefined)
  const actor = d.by !== undefined ? ctx.identity.lookup(jidOf(d.by)) : undefined
  return { kind: 'group', event: { chatId, action: action as 'add' | 'remove' | 'promote' | 'demote', participants, ...(actor ? { actor } : {}) } }
}

const READY = new Set(['isLogged', 'inChat', 'qrReadSuccess', 'CONNECTED', 'successChat', 'chatsAvailable'])
const INVALID = new Set(['desconnectedMobile', 'deleteToken', 'qrReadError', 'qrReadFail'])
const CLOSED = new Set(['browserClose', 'serverClose', 'autocloseCalled', 'CLOSED', 'DISCONNECTED'])

function parseStatusFind(d: Record<string, unknown>): InboundEvent | undefined {
  const status = str(d.status)
  if (!status) return undefined
  if (READY.has(status)) return { kind: 'connection', update: { state: 'ready' } }
  if (status === 'notLogged' || status === 'QRCODE') return { kind: 'connection', update: { state: 'authenticating' } }
  if (INVALID.has(status) || CLOSED.has(status)) {
    const reason: DisconnectReason = INVALID.has(status) ? 'sessionInvalid' : 'transient'
    return { kind: 'connection', update: { state: 'closed', reason, detail: { code: status } } }
  }
  return undefined
}

function parseQr(d: Record<string, unknown>): InboundEvent | undefined {
  const payload = str(d.urlcode) ?? str(d.qrcode)
  return payload ? { kind: 'connection', update: { state: 'authenticating', authPayload: payload } } : undefined
}

/** Normalize one webhook body. Unknown events yield `[]`. */
export function parseWebhook(body: Record<string, unknown>, ctx: ParseContext): InboundEvent[] {
  const one = (e: InboundEvent | undefined): InboundEvent[] => (e ? [e] : [])
  switch (str(body.event)) {
    case 'onmessage':
    case 'onselfmessage':
      return parseMessage(body as unknown as WppMessage, ctx)
    case 'onack':
      return one(parseAck(body, ctx))
    case 'onreactionmessage':
      return one(parseReaction(body, ctx))
    case 'incomingcall':
      return one(parseCall(body, ctx))
    case 'onparticipantschanged':
      return one(parseParticipants(body, ctx))
    case 'status-find':
      return one(parseStatusFind(body))
    case 'qrcode':
      return one(parseQr(body))
    default:
      return []
  }
}
