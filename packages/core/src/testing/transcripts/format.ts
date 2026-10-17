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

import type { OutboundContent, StoredMessage } from '../../core/provider.js'

/** Magic string in every transcript file. */
export const TRANSCRIPT_FORMAT = 'bot-wa/transcript'
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
}

/**
 * Build a transcript from a store message log (`IStore.getMessagesByChat`).
 * Messages are ordered by timestamp (stable). Outbound turns carry `kind` + `text`
 * only — the store keeps no full content — so replays compare those two fields.
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
      turns.push({
        dir: 'in',
        chatId: message.chatId,
        senderId: message.senderId ?? message.chatId,
        type: message.type,
        text: message.body ?? '',
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
}

/** Read one or more chats from a store message log and merge them into one transcript. */
export async function transcriptFromStore(
  store: TranscriptMessageSource,
  chatIds: string | string[],
  options: FromMessagesOptions & { limit?: number } = {},
): Promise<Transcript> {
  const ids = Array.isArray(chatIds) ? chatIds : [chatIds]
  const logs = await Promise.all(ids.map((chatId) => store.getMessagesByChat(chatId, options.limit ?? 1000)))
  return transcriptFromMessages(logs.flat(), options)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
