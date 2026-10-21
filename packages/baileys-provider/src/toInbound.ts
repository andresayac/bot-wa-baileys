/**
 * toInbound — normalize a raw Baileys `WAMessage` into a transport-neutral
 * {@link InboundMessage}. All proto parsing and LID/PN identity canonicalization
 * lives here, INSIDE the provider, so core never sees a WhatsApp concept. The
 * emitted `chatId`/`senderId` are already stable (see {@link IdentityStore}).
 */

import { normalizeMessageContent, toNumber, type WAMessage, type WAMessageKey, type proto } from '@whiskeysockets/baileys'
import { toInboundLocation, type ChatInfo, type ChatKind, type InboundLocation, type InboundMessage, type MediaRef, type MessageType, type QuotedRef, type SenderInfo } from '@botmesh/core'
import { isPnUser, isLidUser, normalize } from './jid.js'
import { canonicalKey, type IdentityStore } from './identity.js'

const MEDIA_KINDS = new Set<MessageType>(['image', 'video', 'audio', 'voice', 'document', 'sticker'])

type ContextInfo = proto.IContextInfo

/**
 * The reply/mention context of a message, wherever its content type keeps it
 * (`extendedTextMessage`, `imageMessage`, `videoMessage`, `documentMessage`…).
 * Wrapped content (disappearing mode, view once, document with caption) is
 * unwrapped first.
 */
export function contextInfoOf(content: proto.IMessage | null | undefined): ContextInfo | undefined {
  const m = normalizeMessageContent(content)
  if (!m) return undefined
  for (const part of Object.values(m)) {
    if (part && typeof part === 'object' && 'contextInfo' in part) {
      const ctx = (part as { contextInfo?: ContextInfo | null }).contextInfo
      if (ctx) return ctx
    }
  }
  return undefined
}

/** Plain text of a (quoted) message: its text, or the caption of its media. */
function textOf(content: proto.IMessage | null | undefined): string {
  const m = normalizeMessageContent(content)
  if (!m) return ''
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    ''
  )
}

/** Epoch seconds from a `number | Long | null` protobuf timestamp (0 when absent). */
function timestampOf(value: WAMessage['messageTimestamp']): number {
  const n = Number(toNumber(value ?? 0))
  return Number.isFinite(n) ? n : 0
}

export function toInbound(message: WAMessage, identity: IdentityStore): InboundMessage<WAMessage> {
  const key = (message.key ?? { remoteJid: '', fromMe: false }) as WAMessageKey

  // Learn LID↔PN pairings this key exposes, then canonicalize to stable PN ids.
  const { chatId: from, senderId: sender, isGroup: isGroupRaw, rawParticipant } =
    canonicalKey(key, identity, message.participant)

  const isGroup = from.endsWith('@g.us')
  const isBroadcast = from === 'status@broadcast' || from.endsWith('@broadcast')
  const kind: ChatKind = isGroup ? 'group' : isBroadcast ? 'broadcast' : from.endsWith('@newsletter') ? 'channel' : 'dm'

  const rawIdentity = (isGroupRaw ? rawParticipant : key.remoteJid) ?? ''
  const senderInfo: SenderInfo = {
    id: sender,
    displayName: message.pushName ?? undefined,
    platformData: {
      phoneNumber: isPnUser(sender) ? sender : undefined,
      lid: isLidUser(rawIdentity) ? rawIdentity : undefined,
    },
  }
  const chat: ChatInfo = { id: from, kind, isGroup, isBroadcast }

  let body = ''
  let type: MessageType = 'unknown'
  let location: InboundLocation | undefined
  // Unwrap disappearing-mode, view-once and document-with-caption envelopes.
  const m: proto.IMessage = normalizeMessageContent(message.message) ?? {}

  if (m.conversation || m.extendedTextMessage?.text) {
    body = (m.conversation ?? m.extendedTextMessage?.text ?? '').toString()
    type = 'text'
  } else if (m.imageMessage) { type = 'image'; body = m.imageMessage.caption ?? '' }
  else if (m.videoMessage) { type = 'video'; body = m.videoMessage.caption ?? '' }
  else if (m.audioMessage) { type = m.audioMessage.ptt ? 'voice' : 'audio' }
  else if (m.stickerMessage) { type = 'sticker' }
  else if (m.documentMessage) { type = 'document'; body = m.documentMessage.caption ?? '' }
  else if (m.locationMessage) {
    type = 'location'
    const l = m.locationMessage
    body = l.name ?? l.address ?? ''
    location = toInboundLocation({ latitude: l.degreesLatitude, longitude: l.degreesLongitude, name: l.name, address: l.address })
  }
  else if (m.liveLocationMessage) {
    type = 'location'
    const l = m.liveLocationMessage
    body = l.caption ?? ''
    location = toInboundLocation({ latitude: l.degreesLatitude, longitude: l.degreesLongitude, live: true })
  }
  else if (m.contactMessage || m.contactsArrayMessage) {
    type = 'contact'
    body = m.contactMessage?.displayName ?? m.contactsArrayMessage?.displayName ?? ''
  }
  else if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) {
    // V3 is the single-select poll, V2 the community-announcement one.
    type = 'poll'
    body = (m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3)?.name ?? ''
  }
  // An encrypted vote. BaileysProvider decrypts these into `poll-vote` events and
  // never routes them here; kept for direct callers of this low-level mapper.
  else if (m.pollUpdateMessage) { type = 'poll' }
  else if (m.buttonsResponseMessage) { type = 'buttons'; body = m.buttonsResponseMessage.selectedDisplayText ?? '' }
  else if (m.templateButtonReplyMessage) { type = 'buttons'; body = m.templateButtonReplyMessage.selectedDisplayText ?? '' }
  else if (m.listResponseMessage) { type = 'list'; body = m.listResponseMessage.title ?? '' }

  let media: MediaRef | undefined
  if (MEDIA_KINDS.has(type)) {
    const part = (m as Record<string, { mimetype?: string | null; fileName?: string | null } | null | undefined>)[`${type === 'voice' ? 'audio' : type}Message`]
    media = { kind: type as MediaRef['kind'], mimetype: part?.mimetype ?? undefined, filename: part?.fileName ?? undefined, token: message }
  }

  const qc = contextInfoOf(m)
  // Every user id below is canonical like `senderId`: a LID-addressed group
  // quotes and mentions LIDs, so a known LID (the bot's own included) maps to
  // its PN and matches selfId, and device suffixes are stripped.
  const canonicalUser = (jid: string) => identity.canonical(normalize(jid) || jid)
  const quotedAuthor = qc?.participant ?? undefined
  let quoted: QuotedRef | undefined
  if (qc?.quotedMessage) {
    quoted = {
      body: textOf(qc.quotedMessage),
      senderId: quotedAuthor ? canonicalUser(quotedAuthor) : undefined,
    }
    if (qc.stanzaId) {
      // WAMessage-shaped, so `send(…, { quoted: quoted.ref })` threads the reply.
      const native = {
        key: { remoteJid: key.remoteJid, id: qc.stanzaId, fromMe: false, ...(quotedAuthor ? { participant: quotedAuthor } : {}) },
        message: qc.quotedMessage,
      }
      quoted.ref = { id: qc.stanzaId, chatId: from, native }
    }
  }
  const mentions = (qc?.mentionedJid ?? []).map(canonicalUser)

  return {
    ref: { id: key.id ?? '', chatId: from, native: message },
    chat,
    senderInfo,
    from,
    sender,
    chatId: from,
    senderId: sender,
    isGroup,
    isBroadcast,
    fromMe: !!key.fromMe,
    type,
    body,
    timestamp: timestampOf(message.messageTimestamp),
    mentions,
    quoted,
    media,
    ...(location ? { location } : {}),
    raw: message,
  }
}
