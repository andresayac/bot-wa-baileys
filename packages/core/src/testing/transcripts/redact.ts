/**
 * Transcript redaction — replace PII with stable placeholders so a recorded
 * conversation can be committed as a golden file.
 *
 * - Ids (`chatId`, `senderId`, message ids) are mapped by value, never parsed:
 *   the same opaque id always becomes the same placeholder (`<user:1>`,
 *   `<chat:1>`, `<msg:3>`), and every occurrence of a known id inside any text
 *   is replaced too.
 * - Emails and phone numbers in texts/contents become `<email:N>` / `<phone:N>`.
 * - Custom rules add more patterns (`<order:N>`, ...).
 *
 * Placeholders are numbered in order of first appearance, so redaction is
 * deterministic; redacting an already-redacted transcript changes nothing.
 * Share one {@link RedactionMap} between calls to keep placeholders stable
 * across several transcripts.
 */

import { isRecord, type JsonValue, type Transcript, type TranscriptTurn } from './format.js'

/** One custom redaction rule. Every match becomes `<name:N>`. */
export interface RedactionRule {
  /** Placeholder label (`[a-z0-9_-]+`). */
  name: string
  /** Pattern to replace (the global flag is added when missing). */
  pattern: RegExp
}

/** Shared value → placeholder table (see {@link createRedactionMap}). */
export type RedactionMap = Map<string, string>

/** Options for {@link redactTranscript}. */
export interface RedactOptions {
  /** Redact emails in texts (default `true`). */
  emails?: boolean
  /** Redact phone-like digit runs (7+ digits) in texts (default `true`). */
  phones?: boolean
  /** Replace chat/sender/message ids with placeholders (default `true`). */
  ids?: boolean
  /** Drop display names (default `true`). */
  dropDisplayNames?: boolean
  /** Drop `startedAt` (the wall-clock start) (default `true`). */
  dropStartedAt?: boolean
  /** Extra patterns. */
  rules?: RedactionRule[]
  /** Values that must never be redacted (e.g. a support phone printed by the bot). */
  allow?: string[]
  /** Reuse placeholders across transcripts. Mutated in place. */
  map?: RedactionMap
}

const PLACEHOLDER = /^<[a-z0-9_-]+:\d+>$/
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE = /\+?\d[\d\s().-]{5,}\d/g
/** Ids shorter than this are only replaced as whole fields, never inside free text. */
const MIN_EMBEDDED_ID = 4

/** A fresh, empty placeholder table to share between {@link redactTranscript} calls. */
export function createRedactionMap(): RedactionMap {
  return new Map()
}

/** Return a redacted copy of `transcript` (the input is not modified). */
export function redactTranscript(transcript: Transcript, options: RedactOptions = {}): Transcript {
  const redactor = new Redactor(options)
  const turns: TranscriptTurn[] = transcript.turns.map((turn) => ({ ...turn }))

  // Pass 1: register ids in order of appearance (sender before chat, so a DM is `<user:N>`).
  if (options.ids !== false) {
    for (const turn of turns) {
      if (turn.dir === 'in') {
        redactor.id('user', turn.senderId)
        redactor.id(turn.isGroup ? 'chat' : 'user', turn.chatId)
      } else {
        redactor.id('user', turn.chatId)
      }
      if (turn.id) redactor.id('msg', turn.id)
    }
  }

  // Pass 2: rewrite every field.
  const redacted = turns.map((turn): TranscriptTurn => {
    if (turn.dir === 'in') {
      const { displayName, ...rest } = turn
      const next = {
        ...rest,
        chatId: redactor.field(turn.chatId),
        senderId: redactor.field(turn.senderId),
        text: redactor.text(turn.text),
        ...(turn.id ? { id: redactor.field(turn.id) } : {}),
      }
      return options.dropDisplayNames === false && displayName !== undefined ? { ...next, displayName: redactor.text(displayName) } : next
    }
    return {
      ...turn,
      chatId: redactor.field(turn.chatId),
      text: redactor.text(turn.text),
      ...(turn.id ? { id: redactor.field(turn.id) } : {}),
      ...(turn.content !== undefined ? { content: redactor.json(turn.content) } : {}),
    }
  })

  const { startedAt, ...meta } = transcript
  return {
    ...meta,
    ...(options.dropStartedAt === false && startedAt !== undefined ? { startedAt } : {}),
    redacted: true,
    turns: redacted,
  }
}

class Redactor {
  private readonly map: RedactionMap
  private readonly allow: Set<string>
  private readonly ids = new Set<string>()
  private readonly rules: Array<{ name: string; pattern: RegExp }>

  constructor(private readonly options: RedactOptions) {
    this.map = options.map ?? new Map()
    this.allow = new Set(options.allow ?? [])
    this.rules = []
    for (const rule of options.rules ?? []) {
      if (!/^[a-z0-9_-]+$/.test(rule.name)) throw new TypeError(`invalid redaction rule name "${rule.name}"`)
      const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`
      this.rules.push({ name: rule.name, pattern: new RegExp(rule.pattern.source, flags) })
    }
    if (options.emails !== false) this.rules.push({ name: 'email', pattern: EMAIL })
    if (options.phones !== false) this.rules.push({ name: 'phone', pattern: PHONE })
    // Ids registered by an earlier call on a shared map are still ids.
    for (const [value, placeholder] of this.map) {
      if (/^<(user|chat|msg):\d+>$/.test(placeholder)) this.ids.add(value)
    }
  }

  id(category: 'user' | 'chat' | 'msg', value: string): void {
    if (!value || PLACEHOLDER.test(value) || this.allow.has(value)) return
    this.placeholder(category, value)
    this.ids.add(value)
  }

  /** A whole-field id. */
  field(value: string): string {
    if (this.options.ids === false) return value
    return this.ids.has(value) ? this.map.get(value)! : value
  }

  text(value: string): string {
    if (!value) return value
    let out = value
    if (this.options.ids !== false) {
      if (this.ids.has(out)) return this.map.get(out)!
      const embedded = [...this.ids].filter((id) => id.length >= MIN_EMBEDDED_ID && out.includes(id)).sort((a, b) => b.length - a.length)
      for (const id of embedded) out = out.split(id).join(this.map.get(id)!)
    }
    for (const rule of this.rules) {
      rule.pattern.lastIndex = 0
      out = out.replace(rule.pattern, (match) => {
        if (this.allow.has(match)) return match
        if (rule.name === 'phone' && (match.match(/\d/g)?.length ?? 0) < 7) return match
        return this.placeholder(rule.name, match)
      })
    }
    return out
  }

  json(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.text(value)
    if (Array.isArray(value)) return value.map((item) => this.json(item))
    if (isRecord(value)) {
      if ('$binary' in value) return value
      const out: { [key: string]: JsonValue } = {}
      for (const [key, field] of Object.entries(value)) out[key] = this.json(field as JsonValue)
      return out
    }
    return value
  }

  private placeholder(category: string, value: string): string {
    const known = this.map.get(value)
    if (known) return known
    let count = 0
    const prefix = `<${category}:`
    for (const placeholder of this.map.values()) if (placeholder.startsWith(prefix)) count++
    const placeholder = `${prefix}${count + 1}>`
    this.map.set(value, placeholder)
    return placeholder
  }
}
