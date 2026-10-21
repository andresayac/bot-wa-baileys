/**
 * Golden transcript format — a versioned, JSON-safe record of a conversation
 * (inbound turns from users, outbound turns from the bot) that can be redacted,
 * committed next to the tests and replayed against a bot.
 *
 * Ids (`chatId`, `senderId`, message ids) are opaque strings: nothing here parses
 * them. Times are millisecond offsets from the start of the transcript (`t`), so
 * a transcript never carries wall-clock dates unless `startedAt` is kept.
 */

import { createHash } from 'node:crypto'

import type { ChatId, InboundEvent, OutboundContent, StoredMessage } from '../../core/provider.js'

/** Magic string in every transcript file. */
export const TRANSCRIPT_FORMAT = 'botmesh/transcript'
/** Current transcript schema version. Bump on breaking changes and migrate in {@link parseTranscript}. */
export const TRANSCRIPT_VERSION = 1

/** Any JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** A user → bot turn. */
export interface TranscriptInbound {
  dir: 'in'
  /** `'message'` (default) or `'interaction'` (button/list/callback; `text` holds its data). */
  event?: 'message' | 'interaction'
  chatId: string
  senderId: string
  /** Message type (`'text'`, `'image'`, ...). */
  type: string
  /** Body / caption, or the interaction data. */
  text: string
  isGroup?: boolean
  displayName?: string
  /** Inbound message id (replayed as-is so dedupe behaves the same). */
  id?: string
  /** Milliseconds since the transcript started. */
  t?: number
}

/** A bot → user turn. */
export interface TranscriptOutbound {
  dir: 'out'
  chatId: string
  /** Outbound content kind (`'text'`, `'image'`, `'buttons'`, ...). */
  kind: string
  /** Human-readable text of the content (text, caption, question...), `''` when none. */
  text: string
  /** Full JSON-safe content when recorded live (absent when built from a store log). */
  content?: JsonValue
  /** Provider message id of the sent message. */
  id?: string
  /** Milliseconds since the transcript started. */
  t?: number
}

export type TranscriptTurn = TranscriptInbound | TranscriptOutbound

/** A golden transcript (schema {@link TRANSCRIPT_VERSION}). */
export interface Transcript {
  format: typeof TRANSCRIPT_FORMAT
  version: typeof TRANSCRIPT_VERSION
  name?: string
  description?: string
  /** Where the turns came from. */
  source?: 'recorder' | 'store' | 'manual' | 'replay'
  /** `true` once {@link redactTranscript} ran over it. */
  redacted?: boolean
  /** Epoch ms of the first turn. Dropped by redaction. */
  startedAt?: number
  turns: TranscriptTurn[]
}

/** Thrown by {@link parseTranscript} on malformed or unsupported input. */
export class TranscriptFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptFormatError'
  }
}

/** Build a transcript from turns (handy for hand-written goldens). */
export function createTranscript(turns: TranscriptTurn[], meta: Partial<Omit<Transcript, 'format' | 'version' | 'turns'>> = {}): Transcript {
  return { format: TRANSCRIPT_FORMAT, version: TRANSCRIPT_VERSION, ...meta, turns: turns.map((turn) => ({ ...turn })) }
}

/** Stable, diff-friendly JSON (2-space indent, trailing newline). */
export function serializeTranscript(transcript: Transcript): string {
  return `${JSON.stringify(transcript, null, 2)}\n`
}

/**
 * Parse and validate a transcript (a JSON string or an already-parsed object).
 * Throws {@link TranscriptFormatError} when the shape or version is wrong.
 */
export function parseTranscript(input: string | unknown): Transcript {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch (error) {
      throw new TranscriptFormatError(`invalid transcript JSON: ${(error as Error).message}`)
    }
  }
  if (!isRecord(value)) throw new TranscriptFormatError('transcript must be an object')
  if (value.format !== TRANSCRIPT_FORMAT) throw new TranscriptFormatError(`not a transcript (format must be "${TRANSCRIPT_FORMAT}")`)
  if (value.version !== TRANSCRIPT_VERSION) {
    throw new TranscriptFormatError(`unsupported transcript version ${String(value.version)} (expected ${TRANSCRIPT_VERSION})`)
  }
  if (!Array.isArray(value.turns)) throw new TranscriptFormatError('transcript.turns must be an array')

  const turns = value.turns.map((turn, index): TranscriptTurn => {
    if (!isRecord(turn)) throw new TranscriptFormatError(`turn ${index} must be an object`)
    const need = (key: string): string => {
      const field = turn[key]
      if (typeof field !== 'string') throw new TranscriptFormatError(`turn ${index}: "${key}" must be a string`)
      return field
    }
    if (turn.t !== undefined && typeof turn.t !== 'number') throw new TranscriptFormatError(`turn ${index}: "t" must be a number`)
    if (turn.dir === 'in') {
      if (turn.event !== undefined && turn.event !== 'message' && turn.event !== 'interaction') {
        throw new TranscriptFormatError(`turn ${index}: unknown event "${String(turn.event)}"`)
      }
      need('chatId'); need('senderId'); need('type'); need('text')
      return { ...(turn as unknown as TranscriptInbound) }
    }
    if (turn.dir === 'out') {
      need('chatId'); need('kind'); need('text')
      return { ...(turn as unknown as TranscriptOutbound) }
    }
    throw new TranscriptFormatError(`turn ${index}: "dir" must be "in" or "out"`)
  })
  return { ...(value as unknown as Transcript), turns }
}

/** Human-readable text of an outbound content (same projection the store log uses). */
export function outboundText(content: OutboundContent): string {
  switch (content.kind) {
    case 'text': return content.text
    case 'image':
    case 'video':
    case 'document': return content.caption ?? ''
    case 'location': return content.name ?? content.address ?? ''
    case 'contact': return content.displayName ?? content.phone
    case 'poll': return content.question
    case 'buttons':
    case 'list': return content.text
    case 'card': return content.title
    case 'template': return content.name
    case 'reaction': return content.emoji
    default: return ''
  }
}

/** Inbound events a transcript can hold as turns (messages and interactions). */
export type TranscriptInboundEvent = Extract<InboundEvent, { kind: 'message' | 'interaction' }>

/**
 * The inbound turn of a message or interaction event, as the recorder writes it:
 * `isGroup`, `displayName` and `id` only when the event carries them, `t` only when given.
 */
export function inboundTurnOf(event: TranscriptInboundEvent, t?: number): TranscriptInbound {
  if (event.kind === 'message') {
    const message = event.message
    return {
      dir: 'in',
      chatId: message.chatId,
      senderId: message.senderId,
      type: message.type,
      text: message.body ?? '',
      ...(message.isGroup ? { isGroup: true } : {}),
      ...(message.senderInfo?.displayName ? { displayName: message.senderInfo.displayName } : {}),
      ...(message.ref?.id ? { id: message.ref.id } : {}),
      ...(t !== undefined ? { t } : {}),
    }
  }
  const it = event.interaction
  return {
    dir: 'in',
    event: 'interaction',
    chatId: it.chatId,
    senderId: it.senderId,
    type: it.kind,
    text: it.data,
    ...(it.isGroup ? { isGroup: true } : {}),
    ...(it.senderInfo?.displayName ? { displayName: it.senderInfo.displayName } : {}),
    ...(it.ref?.id ? { id: it.ref.id } : {}),
    ...(t !== undefined ? { t } : {}),
  }
}

/** The outbound turn of a sent content: `kind`, readable `text` and the JSON-safe `content`. */
export function outboundTurnOf(chatId: ChatId, content: OutboundContent, t?: number, id?: string): TranscriptOutbound {
  return {
    dir: 'out',
    chatId,
    kind: content.kind,
    text: outboundText(content),
    content: serializeContent(content),
    ...(t !== undefined ? { t } : {}),
    ...(id !== undefined ? { id } : {}),
  }
}

/**
 * Readable rendering of a transcript, one turn per line: `user-1> hola`,
 * `bot< Your name?`, `bot< [buttons] Elige` (non-text kinds are tagged),
 * `user-1> (button) a` (interactions). Lines carry a `[chatId]` prefix when the
 * transcript spans several chats.
 */
export function transcriptToText(transcript: Transcript): string {
  const chats = new Set(transcript.turns.map((turn) => turn.chatId))
  const prefix = (turn: TranscriptTurn): string => (chats.size > 1 ? `[${turn.chatId}] ` : '')
  return transcript.turns.map((turn) => {
    if (turn.dir === 'out') {
      const tag = turn.kind === 'text' ? '' : `[${turn.kind}] `
      return `${prefix(turn)}bot< ${tag}${turn.text}`
    }
    const tag = turn.event === 'interaction' ? `(${turn.type}) ` : turn.type === 'text' ? '' : `[${turn.type}] `
    return `${prefix(turn)}${turn.senderId}> ${tag}${turn.text}`
  }).join('\n')
}

/**
 * JSON-safe copy of an outbound content. Binary payloads become
 * `{ $binary: { bytes, sha256 } }`, streams `{ $stream: true }`; functions and
 * `undefined` fields are dropped.
 */
export function serializeContent(content: OutboundContent): JsonValue {
  return toJson(content) ?? null
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $binary: { bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') } }
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => toJson(item) ?? null)
  if (typeof value === 'object') {
    if (typeof (value as { pipe?: unknown }).pipe === 'function' && typeof (value as { on?: unknown }).on === 'function') {
      return { $stream: true }
    }
    const out: { [key: string]: JsonValue } = {}
    for (const [key, field] of Object.entries(value)) {
      const json = toJson(field)
      if (json !== undefined) out[key] = json
    }
    return out
  }
  return undefined
}

/** Options for {@link transcriptFromMessages}. */
export interface FromMessagesOptions {
  name?: string
  /** Keep outbound messages whose status is `'failed'` (default `false`). */
  includeFailed?: boolean
  /**
   * Chat kind of the inbound turns. The message log has no chat kind, so pass it
   * here (a flag for all chats, or a predicate per chat id) to replay group
   * conversations as groups. {@link transcriptFromStore} reads it from the stored
   * chat (`getChat(chatId).kind === 'group'`) when this is omitted.
   */
  isGroup?: boolean | ((chatId: string) => boolean)
}

/**
 * Build a transcript from a store message log (`IStore.getMessagesByChat`).
 * Messages are ordered by timestamp (stable). Outbound turns carry `kind` + `text`
 * only — the store keeps no full content — so replays compare those two fields.
 * Display names are not in the log, so replays use the mock default push name.
 */
export function transcriptFromMessages(messages: StoredMessage[], options: FromMessagesOptions = {}): Transcript {
  const ordered = messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => a.message.timestamp - b.message.timestamp || a.index - b.index)
    .map(({ message }) => message)
  const startedAt = ordered[0]?.timestamp
  const turns: TranscriptTurn[] = []
  for (const message of ordered) {
    const t = startedAt === undefined ? undefined : message.timestamp - startedAt
    const outbound = message.direction ? message.direction === 'outbound' : message.fromMe === true
    if (outbound) {
      if (message.type === 'unknown') continue
      if (message.status === 'failed' && !options.includeFailed) continue
      turns.push({ dir: 'out', chatId: message.chatId, kind: message.type, text: message.body ?? '', id: message.ref.id, t })
    } else {
      const group = typeof options.isGroup === 'function' ? options.isGroup(message.chatId) : options.isGroup
      turns.push({
        dir: 'in',
        chatId: message.chatId,
        senderId: message.senderId ?? message.chatId,
        type: message.type,
        text: message.body ?? '',
        ...(group ? { isGroup: true } : {}),
        id: message.ref.id,
        t,
      })
    }
  }
  return createTranscript(turns, { source: 'store', startedAt, ...(options.name ? { name: options.name } : {}) })
}

/** Minimal slice of `IStore` needed by {@link transcriptFromStore}. */
export interface TranscriptMessageSource {
  getMessagesByChat(chatId: string, limit?: number): Promise<StoredMessage[]>
  /** Used to detect group chats when `isGroup` is not given. */
  getChat?(chatId: string): Promise<{ kind?: string } | undefined>
}

/** Anything exposing the store a bot writes to (e.g. a `Bot`). */
export interface TranscriptStoreOwner {
  getStore(): TranscriptMessageSource
}

/**
 * Read one or more chats from a store message log and merge them into one transcript.
 *
 * Pass the **bot** (or `bot.getStore()`): a `Bot` wraps the store it is given in a
 * namespaced view, so reading the raw store you passed to `new Bot({ store })`
 * finds nothing under the plain chat ids.
 */
export async function transcriptFromStore(
  source: TranscriptMessageSource | TranscriptStoreOwner,
  chatIds: string | string[],
  options: FromMessagesOptions & { limit?: number } = {},
): Promise<Transcript> {
  const store = 'getStore' in source && typeof source.getStore === 'function' ? source.getStore() : (source as TranscriptMessageSource)
  const ids = Array.isArray(chatIds) ? chatIds : [chatIds]
  const logs = await Promise.all(ids.map((chatId) => store.getMessagesByChat(chatId, options.limit ?? 1000)))
  let isGroup = options.isGroup
  if (isGroup === undefined && store.getChat) {
    const chats = await Promise.all(ids.map(async (chatId) => [chatId, (await store.getChat!(chatId))?.kind === 'group'] as const))
    const groups = new Set(chats.filter(([, group]) => group).map(([chatId]) => chatId))
    isGroup = (chatId) => groups.has(chatId)
  }
  return transcriptFromMessages(logs.flat(), { ...options, ...(isGroup !== undefined ? { isGroup } : {}) })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
