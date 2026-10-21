/**
 * Durable media references for the Baileys transport (`IProvider.serializeMediaRef` /
 * `rehydrateMediaRef`).
 *
 * A Baileys `MediaRef.token` is the live `WAMessage`. For the durable inbox it is reduced to
 * what a download needs: the media content (CDN url, direct path, media key and hashes,
 * WITHOUT thumbnails, captions or quoted context) as protobuf bytes, plus the raw message key,
 * which only the re-upload request (`sock.updateMediaMessage`) uses when the CDN copy expired.
 * The key is never used for identity, keying or routing (LID/PN rules are untouched).
 *
 * The stored value is UNTRUSTED when read back: every field is validated and a malformed,
 * oversized, unknown-version or mismatching value is rejected with a `ProviderError`.
 */

import { normalizeMessageContent, proto, toNumber, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys'
import { ProviderError, type MediaRef, type SerializedMediaRef } from '@botmesh/core'

/** Format version written by {@link serializeBaileysMediaRef}. */
export const BAILEYS_MEDIA_REF_VERSION = 1
/** Upper bound of the base64 protobuf content (a media content without thumbnails is ~300 bytes). */
const MAX_CONTENT_B64 = 16 * 1024

type MediaField = 'imageMessage' | 'videoMessage' | 'audioMessage' | 'documentMessage' | 'stickerMessage'
const MEDIA_FIELDS: readonly MediaField[] = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']

const FIELD_OF: Partial<Record<MediaRef['kind'], MediaField>> = {
  image: 'imageMessage',
  video: 'videoMessage',
  audio: 'audioMessage',
  voice: 'audioMessage',
  document: 'documentMessage',
  sticker: 'stickerMessage',
}

/** What a download (and a re-upload) needs from one media content; nothing else is journaled. */
const KEPT = [
  'url', 'directPath', 'mediaKey', 'mediaKeyTimestamp', 'fileEncSha256', 'fileSha256', 'fileLength',
  'mimetype', 'fileName', 'seconds', 'ptt', 'width', 'height', 'isAnimated',
] as const

/** The journaled data of format v1. */
export interface BaileysMediaRefV1 {
  /** The raw WhatsApp message key (re-upload requests only). */
  key: { remoteJid: string; id: string; fromMe?: boolean; participant?: string }
  /** Base64 `proto.Message` holding exactly one media content. */
  m: string
  /** `messageTimestamp` (seconds). */
  t?: number
}

/** Options of {@link serializeBaileysMediaRef}. */
export interface SerializeMediaOptions {
  /** Journal view-once media too (its key then lives at rest). Default `false`. */
  viewOnce?: boolean
}

function isViewOnce(message: proto.IMessage | null | undefined, content: { viewOnce?: boolean | null } | undefined): boolean {
  if (content?.viewOnce) return true
  const m = message ?? {}
  return Boolean(m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension
    || m.ephemeralMessage?.message?.viewOnceMessage || m.ephemeralMessage?.message?.viewOnceMessageV2)
}

/**
 * The durable reference of an inbound media message, or `undefined` when it must not (or
 * cannot) be journaled: view-once media (unless `options.viewOnce`), no media key or path,
 * an unexpected shape. Never throws.
 */
export function serializeBaileysMediaRef(ref: MediaRef, options: SerializeMediaOptions = {}): SerializedMediaRef | undefined {
  try {
    const message = ref.token as WAMessage | undefined
    const field = FIELD_OF[ref.kind]
    if (!field || !message || typeof message !== 'object' || !message.key?.id || !message.key.remoteJid) return undefined
    const inner = normalizeMessageContent(message.message)
    const content = inner?.[field] as Record<string, unknown> | null | undefined
    if (!content || !content.mediaKey || !(content.directPath || content.url)) return undefined
    if (isViewOnce(message.message, content as { viewOnce?: boolean | null }) && options.viewOnce !== true) return undefined

    const kept: Record<string, unknown> = {}
    for (const name of KEPT) if (content[name] !== undefined && content[name] !== null) kept[name] = content[name]
    const bytes = proto.Message.encode(proto.Message.fromObject({ [field]: kept })).finish()
    const m = Buffer.from(bytes).toString('base64')
    if (m.length > MAX_CONTENT_B64) return undefined

    const k = message.key
    const key: BaileysMediaRefV1['key'] = {
      remoteJid: k.remoteJid!,
      id: k.id!,
      ...(typeof k.fromMe === 'boolean' ? { fromMe: k.fromMe } : {}),
      ...(k.participant ? { participant: k.participant } : {}),
    }
    const t = message.messageTimestamp === undefined || message.messageTimestamp === null ? undefined : toNumber(message.messageTimestamp)
    const data: BaileysMediaRefV1 = { key, m, ...(typeof t === 'number' && Number.isFinite(t) ? { t } : {}) }
    return { v: BAILEYS_MEDIA_REF_VERSION, data: data as unknown as SerializedMediaRef['data'] }
  } catch {
    return undefined
  }
}

const JID = /^[\w.:+-]{1,128}@[\w.-]{1,64}$/
const MESSAGE_ID = /^[\w.:-]{1,128}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function invalid(why: string): ProviderError {
  return new ProviderError(`Invalid Baileys media reference: ${why}`)
}

/**
 * Decode and validate a journaled reference into the message key and a `WAMessage` holding
 * only the media content. @throws {ProviderError} on anything unexpected.
 */
export function parseBaileysMediaRef(stored: SerializedMediaRef, kind: MediaRef['kind']): { key: WAMessageKey; message: WAMessage } {
  if (!stored || typeof stored !== 'object') throw invalid('not an object')
  if (stored.v !== BAILEYS_MEDIA_REF_VERSION) throw invalid(`unknown version ${String(stored.v)}`)
  const data = stored.data as Partial<BaileysMediaRefV1> | null
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('no data')
  const key = data.key
  if (!key || typeof key !== 'object') throw invalid('no key')
  if (typeof key.remoteJid !== 'string' || !JID.test(key.remoteJid)) throw invalid('bad remoteJid')
  if (typeof key.id !== 'string' || !MESSAGE_ID.test(key.id)) throw invalid('bad id')
  if (key.fromMe !== undefined && typeof key.fromMe !== 'boolean') throw invalid('bad fromMe')
  if (key.participant !== undefined && (typeof key.participant !== 'string' || !JID.test(key.participant))) throw invalid('bad participant')
  if (data.t !== undefined && (typeof data.t !== 'number' || !Number.isFinite(data.t) || data.t < 0)) throw invalid('bad timestamp')
  if (typeof data.m !== 'string' || data.m.length === 0 || data.m.length > MAX_CONTENT_B64 || !BASE64.test(data.m)) throw invalid('bad content')

  let decoded: proto.Message
  try { decoded = proto.Message.decode(Buffer.from(data.m, 'base64')) } catch { throw invalid('undecodable content') }
  const present = MEDIA_FIELDS.filter((f) => decoded[f] !== undefined && decoded[f] !== null)
  const field = FIELD_OF[kind]
  if (present.length !== 1 || present[0] !== field) throw invalid('media content does not match the message kind')
  const content = decoded[field] as { mediaKey?: Uint8Array | null } | null | undefined
  if (!content?.mediaKey?.length) throw invalid('no media key')

  const waKey: WAMessageKey = {
    remoteJid: key.remoteJid,
    id: key.id,
    ...(key.fromMe !== undefined ? { fromMe: key.fromMe } : {}),
    ...(key.participant !== undefined ? { participant: key.participant } : {}),
  }
  const message = { key: waKey, message: decoded, ...(data.t !== undefined ? { messageTimestamp: data.t } : {}) } as WAMessage
  return { key: waKey, message }
}
