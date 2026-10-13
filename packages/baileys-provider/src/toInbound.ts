/**
 * toInbound — normalize a raw Baileys `WAMessage` into a transport-neutral
 * {@link InboundMessage}. All proto parsing and LID/PN identity canonicalization
 * lives here, INSIDE the provider, so core never sees a WhatsApp concept. The
 * emitted `chatId`/`senderId` are already stable (see {@link IdentityStore}).
 */

import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys'
import type { ChatInfo, ChatKind, InboundMessage, MediaRef, MessageType, SenderInfo } from '@bot-wa/core'
import { isPnUser, isLidUser } from './jid.js'
import { canonicalKey, type IdentityStore } from './identity.js'

const MEDIA_KINDS = new Set<MessageType>(['image', 'video', 'audio', 'voice', 'document', 'sticker'])

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
  const m = message.message ?? {}

  if (m.conversation || m.extendedTextMessage?.text) {
    body = (m.conversation ?? m.extendedTextMessage?.text ?? '').toString()
    type = 'text'
  } else if (m.imageMessage) { type = 'image'; body = m.imageMessage.caption ?? '' }
  else if (m.videoMessage) { type = 'video'; body = m.videoMessage.caption ?? '' }
  else if (m.audioMessage) { type = (m.audioMessage as { ptt?: boolean }).ptt ? 'voice' : 'audio' }
  else if (m.stickerMessage) { type = 'sticker' }
  else if (m.documentMessage) { type = 'document'; body = m.documentMessage.caption ?? '' }
  else if (m.locationMessage) { type = 'location' }
  else if (m.contactMessage) { type = 'contact' }
  else if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) {
    // V3 is the single-select poll, V2 the community-announcement one.
    type = 'poll'
    body = (m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3)?.name ?? ''
  }
  // An encrypted vote. BaileysProvider decrypts these into `poll-vote` events and
  // never routes them here; kept for direct callers of this low-level mapper.
  else if (m.pollUpdateMessage) { type = 'poll' }
  else if (m.buttonsResponseMessage) { type = 'buttons'; body = m.buttonsResponseMessage.selectedDisplayText ?? '' }
  else if (m.listResponseMessage) { type = 'list'; body = m.listResponseMessage.title ?? '' }

  let media: MediaRef | undefined
  if (MEDIA_KINDS.has(type)) {
    const part = (m as Record<string, { mimetype?: string; fileName?: string; fileLength?: number }>)[`${type === 'voice' ? 'audio' : type}Message`]
    media = { kind: type as MediaRef['kind'], mimetype: part?.mimetype, filename: part?.fileName, token: message }
  }

  const qc = m.extendedTextMessage?.contextInfo
  const quoted = qc?.quotedMessage
    ? {
        body:
          ((qc.quotedMessage as { conversation?: string }).conversation) ??
          ((qc.quotedMessage as { extendedTextMessage?: { text?: string } }).extendedTextMessage?.text) ??
          '',
        senderId: (qc.participant as string | undefined) ?? undefined,
      }
    : undefined
  const mentions = (qc?.mentionedJid ?? []) as string[]

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
    timestamp: (message.messageTimestamp as number) ?? 0,
    mentions,
    quoted,
    media,
    raw: message,
  }
}
