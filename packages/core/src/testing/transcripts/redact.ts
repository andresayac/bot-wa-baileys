/**
 * Transcript redaction — replace PII with stable placeholders so a recorded
 * conversation can be committed as a golden file.
 *
 * - Ids (`chatId`, `senderId`, message ids) are mapped by value, never parsed:
 *   the same opaque id always becomes the same placeholder (`<user:1>`,
 *   `<chat:1>`, `<msg:3>`). User and chat ids are also replaced inside any text;
 *   message ids only as whole fields (they are often short numbers).
 * - Display names become `<name:N>` (in the `displayName` field and, on word
 *   boundaries, inside any text), so a reply that greets the user by name is
 *   redacted too and replays with the placeholder as push name.
 * - Emails and phone numbers in **inbound** texts become `<email:N>` /
 *   `<phone:N>`; custom rules add more patterns (`<order:N>`, ...).
 * - Outbound texts only get the values already learned from the inbound side
 *   (user-derived data the bot echoes back). Patterns are not applied to what the
 *   bot prints on its own (prices, dates, order numbers), because replay would
 *   compare them against the real values. Opt in with `outboundPatterns` (and
 *   replay with `{ redact }`) when the bot prints PII that never came from the user.
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
  /**
   * Display names: `'placeholder'` (default) replaces them with `<name:N>` in the
   * field and in every text; `'drop'` removes the field but still redacts the name
   * in texts; `'keep'` leaves them untouched.
   */
  displayNames?: 'placeholder' | 'drop' | 'keep'
  /**
   * Apply the email/phone/custom patterns to outbound texts too (default `false`:
   * outbound texts only get values learned from inbound turns). Replay such a
   * golden with `replayTranscript(..., { redact: { ... } })`.
   */
  outboundPatterns?: boolean
  /**
   * Use format-valid surrogates instead of `<email:N>` / `<phone:N>`
   * (`email1@redacted.invalid`, `+10000000001`), so validation steps in flows
   * accept the redacted input on replay. Default `false`.
   */
  surrogates?: boolean
  /** Drop `startedAt` (the wall-clock start) (default `true`). */
  dropStartedAt?: boolean
  /** Extra patterns. */
  rules?: RedactionRule[]
  /** Values that must never be redacted (e.g. a support phone printed by the bot). */
  allow?: string[]
  /** Reuse placeholders across transcripts. Mutated in place. */
  map?: RedactionMap
}

const PLACEHOLDER = /^<([a-z0-9_-]+):\d+>$/
const SURROGATE_EMAIL = /^email\d+@redacted\.invalid$/
const SURROGATE_PHONE = /^\+1000000\d{4}$/
/** @internal Built-in email pattern (shared with replay). */
export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** @internal Built-in phone pattern (shared with replay); a match needs 7+ digits ({@link isPhoneMatch}). */
export const PHONE_PATTERN = /\+?\d[\d\s().-]{5,}\d/g
/** User/chat ids shorter than this are only replaced as whole fields, never inside free text. */
const MIN_EMBEDDED_ID = 4
/** Names shorter than this are only replaced as whole fields. */
const MIN_EMBEDDED_NAME = 2

/** @internal Does `match` count as a phone number (7+ digits)? */
export function isPhoneMatch(match: string): boolean {
  return (match.match(/\d/g)?.length ?? 0) >= 7
}

/** @internal Category of a placeholder or surrogate produced by redaction (`undefined` for other strings). */
export function placeholderCategory(value: string): string | undefined {
  const token = PLACEHOLDER.exec(value)
  if (token) return token[1]
  if (SURROGATE_EMAIL.test(value)) return 'email'
  if (SURROGATE_PHONE.test(value)) return 'phone'
  return undefined
}

/** A fresh, empty placeholder table to share between {@link redactTranscript} calls. */
export function createRedactionMap(): RedactionMap {
  return new Map()
}

/** Return a redacted copy of `transcript` (the input is not modified). */
export function redactTranscript(transcript: Transcript, options: RedactOptions = {}): Transcript {
  const redactor = new Redactor(options)
  const turns: TranscriptTurn[] = transcript.turns.map((turn) => ({ ...turn }))
  const names = options.displayNames ?? 'placeholder'

  // Pass 1a: register ids (sender before chat, so a DM is `<user:N>`) and display names in order of appearance.
  for (const turn of turns) {
    if (options.ids !== false) {
      if (turn.dir === 'in') {
        redactor.id('user', turn.senderId)
        redactor.id(turn.isGroup ? 'chat' : 'user', turn.chatId)
      } else {
        redactor.id('user', turn.chatId)
      }
      if (turn.id) redactor.id('msg', turn.id)
    }
    if (turn.dir === 'in' && turn.displayName && names !== 'keep') redactor.name(turn.displayName)
  }
  // Pass 1b: learn the PII values users typed, so replies echoing them are redacted the same way.
  for (const turn of turns) if (turn.dir === 'in') redactor.text(turn.text, 'in')

  // Pass 2: rewrite every field.
  const redacted = turns.map((turn): TranscriptTurn => {
    if (turn.dir === 'in') {
      const { displayName, ...rest } = turn
      const next = {
        ...rest,
        chatId: redactor.field(turn.chatId),
        senderId: redactor.field(turn.senderId),
        text: redactor.text(turn.text, 'in'),
        ...(turn.id ? { id: redactor.field(turn.id) } : {}),
      }
      if (displayName === undefined || names === 'drop') return next
      return { ...next, displayName: names === 'keep' ? displayName : redactor.text(displayName, 'in') }
    }
    return {
      ...turn,
      chatId: redactor.field(turn.chatId),
      text: redactor.text(turn.text, 'out'),
      ...(turn.id ? { id: redactor.field(turn.id) } : {}),
      ...(turn.content !== undefined ? { content: redactor.json(turn.content, 'out') } : {}),
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
  /** Whole-field ids (user, chat, msg). */
  private readonly ids = new Set<string>()
  /** Values replaced inside free text as substrings (user/chat ids, pattern matches). */
  private readonly embedded = new Set<string>()
  /** Names, replaced inside free text on word boundaries. */
  private readonly names = new Set<string>()
  private readonly rules: Array<{ name: string; pattern: RegExp }>
  /** Cached matcher for known values; `null` = stale. */
  private known: RegExp | undefined | null = null

  constructor(private readonly options: RedactOptions) {
    this.map = options.map ?? new Map()
    this.allow = new Set(options.allow ?? [])
    this.rules = []
    for (const rule of options.rules ?? []) {
      if (!/^[a-z0-9_-]+$/.test(rule.name)) throw new TypeError(`invalid redaction rule name "${rule.name}"`)
      const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`
      this.rules.push({ name: rule.name, pattern: new RegExp(rule.pattern.source, flags) })
    }
    if (options.emails !== false) this.rules.push({ name: 'email', pattern: new RegExp(EMAIL_PATTERN.source, 'g') })
    if (options.phones !== false) this.rules.push({ name: 'phone', pattern: new RegExp(PHONE_PATTERN.source, 'g') })
    // Values registered by an earlier call on a shared map keep their role.
    for (const [value, placeholder] of this.map) this.learn(value, placeholderCategory(placeholder) ?? '')
  }

  id(category: 'user' | 'chat' | 'msg', value: string): void {
    if (!value || placeholderCategory(value) || this.allow.has(value)) return
    this.placeholder(category, value)
  }

  name(value: string): void {
    if (!value || placeholderCategory(value) || this.allow.has(value)) return
    this.placeholder('name', value)
  }

  /** A whole-field id. */
  field(value: string): string {
    if (this.options.ids === false) return value
    return this.ids.has(value) ? this.map.get(value)! : value
  }

  text(value: string, side: 'in' | 'out'): string {
    if (!value) return value
    if (this.ids.has(value) || this.names.has(value)) return this.map.get(value)!
    const known = this.knownPattern()
    let out = known ? value.replace(known, (match) => this.map.get(match) ?? match) : value
    if (side === 'in' || this.options.outboundPatterns) {
      for (const rule of this.rules) {
        rule.pattern.lastIndex = 0
        out = out.replace(rule.pattern, (match) => {
          if (this.allow.has(match) || placeholderCategory(match)) return match
          if (rule.name === 'phone' && !isPhoneMatch(match)) return match
          return this.placeholder(rule.name, match)
        })
      }
    }
    return out
  }

  json(value: JsonValue, side: 'in' | 'out'): JsonValue {
    if (typeof value === 'string') return this.text(value, side)
    if (Array.isArray(value)) return value.map((item) => this.json(item, side))
    if (isRecord(value)) {
      if ('$binary' in value) return value
      const out: { [key: string]: JsonValue } = {}
      for (const [key, field] of Object.entries(value)) out[key] = this.json(field as JsonValue, side)
      return out
    }
    return value
  }

  /** One regex matching every known value that may appear inside text (longest first, single pass). */
  private knownPattern(): RegExp | undefined {
    if (this.known !== null) return this.known
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const alternatives = [
      ...[...this.embedded].map((value) => ({ value, source: escape(value) })),
      ...[...this.names]
        .filter((value) => value.length >= MIN_EMBEDDED_NAME)
        .map((value) => ({ value, source: `(?<![\\p{L}\\p{N}_])${escape(value)}(?![\\p{L}\\p{N}_])` })),
    ].sort((a, b) => b.value.length - a.value.length)
    this.known = alternatives.length ? new RegExp(alternatives.map((alt) => alt.source).join('|'), 'gu') : undefined
    return this.known
  }

  private learn(value: string, category: string): void {
    this.known = null
    if (category === 'user' || category === 'chat' || category === 'msg') {
      if (this.options.ids === false) return
      this.ids.add(value)
      if (category !== 'msg' && value.length >= MIN_EMBEDDED_ID) this.embedded.add(value)
    } else if (category === 'name') {
      this.names.add(value)
    } else {
      this.embedded.add(value)
    }
  }

  private placeholder(category: string, value: string): string {
    const known = this.map.get(value)
    if (known) return known
    let count = 0
    for (const placeholder of this.map.values()) if (placeholderCategory(placeholder) === category) count++
    const n = count + 1
    const placeholder = this.options.surrogates && category === 'email'
      ? `email${n}@redacted.invalid`
      : this.options.surrogates && category === 'phone'
        ? `+1000000${String(n).padStart(4, '0')}`
        : `<${category}:${n}>`
    this.map.set(value, placeholder)
    this.learn(value, category)
    return placeholder
  }
}
