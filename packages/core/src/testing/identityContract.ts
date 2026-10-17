/**
 * Identity stability contract — reusable checks for provider test suites.
 *
 * The core never re-derives identity: every provider must resolve its
 * transport aliases (WhatsApp LID↔PN, Telegram `sender_chat`, Discord
 * member/user, …) BEFORE emitting, so that the same human always yields the
 * same `senderId` (and the same DM the same `chatId`). When a provider breaks
 * that promise, one person is silently split across two conversation keys —
 * the most expensive bug this project has shipped.
 *
 * These helpers check a stream of normalized events (what a provider emitted,
 * or what `toInbound()`/`parseInbound()` returned) without any test-runner
 * dependency, so any package can use them:
 *
 * - per event: every id is a non-empty string and not an obvious
 *   `"undefined"`/`"null"`/`"[object Object]"` leak; the duplicated aliases
 *   agree (`from`/`chatId`/`chat.id`, `sender`/`senderId`/`senderInfo.id`,
 *   `ref.chatId`); `ChatKind` is valid and consistent with `isGroup` /
 *   `isBroadcast`;
 * - across events: one chat id never changes `ChatKind`;
 * - per human (your expectations): one stable `senderId`, one stable DM
 *   `chatId`, optionally the exact ids/kind you expect, and distinct humans
 *   never collapse into one `senderId`.
 *
 * @example
 * ```ts
 * import { assertStableIdentity } from '@bot-wa/core/testing'
 *
 * const events = [
 *   toInbound(msg({ remoteJid: LID, remoteJidAlt: PN, id: 'm1' }), identity),
 *   toInbound(msg({ remoteJid: LID, id: 'm2' }), identity), // PN twin missing
 *   toInbound(msg({ remoteJid: PN, id: 'm3' }), identity),
 * ]
 * assertStableIdentity(events, { andres: { events: [0, 1, 2], senderId: PN } })
 * ```
 */

import type {
  ChatId,
  ChatKind,
  IProvider,
  InboundEvent,
  InboundInteraction,
  InboundMessage,
  UserId,
} from '../core/provider.js'

/** Anything a provider test may hold: the `InboundEvent` wrapper or the bare message/interaction. */
export type IdentityEventInput = InboundEvent | InboundMessage | InboundInteraction

/** What one human's events must satisfy. */
export interface IdentityExpectation {
  /** Indices (into the checked array) of the events produced by this human. */
  events: number[]
  /** The canonical sender id every one of these events must carry. */
  senderId?: UserId
  /** The chat id every one of these events must carry (e.g. the DM, or a group). */
  chatId?: ChatId
  /** The `ChatKind` every one of these events must carry. */
  kind?: ChatKind
}

/** Human label → that human's event indices, or a full {@link IdentityExpectation}. */
export type IdentityExpectations = Record<string, number[] | IdentityExpectation>

/** Tuning for {@link checkIdentityContract}. */
export interface IdentityContractOptions {
  /** Require `ref.chatId === chatId`. Default `true`. */
  requireRefChatId?: boolean
  /** Flag ids that look like stringified `undefined`/`null`/`NaN`/objects. Default `true`. */
  rejectSuspiciousIds?: boolean
  /** Flag two different humans sharing one `senderId`. Default `true`. */
  distinctHumans?: boolean
}

/** Machine-readable rule ids reported in {@link IdentityViolation.rule}. */
export type IdentityRule =
  | 'missing-id'
  | 'suspicious-id'
  | 'alias-mismatch'
  | 'chat-kind'
  | 'kind-drift'
  | 'unstable-sender'
  | 'unstable-chat'
  | 'unexpected-sender'
  | 'unexpected-chat'
  | 'unexpected-kind'
  | 'collapsed-humans'
  | 'bad-index'

/** One broken promise of the identity stability contract. */
export interface IdentityViolation {
  rule: IdentityRule
  /** Human-readable explanation (ids included, so the failure is actionable). */
  message: string
  /** Index of the offending event, for per-event rules. */
  index?: number
  /** Label of the human, for per-human rules. */
  human?: string
}

/** Thrown by {@link assertStableIdentity}; carries every violation found. */
export class IdentityContractError extends Error {
  readonly violations: IdentityViolation[]
  constructor(violations: IdentityViolation[]) {
    super(
      `Identity stability contract violated (${violations.length} violation${violations.length === 1 ? '' : 's'}):\n` +
        violations.map((v) => `  - [${v.rule}] ${v.message}`).join('\n'),
    )
    this.name = 'IdentityContractError'
    this.violations = violations
  }
}

/**
 * Check normalized events against the identity stability contract and return
 * every violation (empty array = conforming). Non-identity events (connection,
 * status, …) are skipped but keep their index.
 */
export function checkIdentityContract(
  events: ReadonlyArray<IdentityEventInput>,
  expectations: IdentityExpectations = {},
  options: IdentityContractOptions = {},
): IdentityViolation[] {
  const requireRefChatId = options.requireRefChatId ?? true
  const rejectSuspicious = options.rejectSuspiciousIds ?? true
  const distinctHumans = options.distinctHumans ?? true
  const out: IdentityViolation[] = []
  const projected = events.map((e, index) => project(e, index))

  // ---- per event -----------------------------------------------------------
  const kindByChat = new Map<string, { kind: unknown; index: number }>()
  for (const p of projected) {
    if (!p) continue
    const at = `event #${p.index} (${p.source})`
    const fields = p.source === 'interaction' ? [...ID_FIELDS, 'interactionId'] : ID_FIELDS
    for (const path of fields) {
      const v = get(p.rec, path)
      if (typeof v !== 'string' || v === '') {
        out.push({ rule: 'missing-id', index: p.index, message: `${at}: ${path} is ${fmt(v)}` })
      } else if (rejectSuspicious && SUSPICIOUS_ID.test(v)) {
        out.push({ rule: 'suspicious-id', index: p.index, message: `${at}: ${path} looks like a stringified empty value: ${fmt(v)}` })
      }
    }

    agree(out, p, at, ['from', 'chatId', 'chat.id'])
    agree(out, p, at, ['sender', 'senderId', 'senderInfo.id'])
    if (requireRefChatId) agree(out, p, at, ['chatId', 'ref.chatId'])

    const kind = get(p.rec, 'chat.kind')
    if (typeof kind !== 'string' || !CHAT_KINDS.has(kind)) {
      out.push({ rule: 'chat-kind', index: p.index, message: `${at}: chat.kind is ${fmt(kind)} (expected one of ${[...CHAT_KINDS].join(', ')})` })
    } else {
      const isGroup = get(p.rec, 'isGroup')
      const chatIsGroup = get(p.rec, 'chat.isGroup')
      const chatIsBroadcast = get(p.rec, 'chat.isBroadcast')
      if (isGroup !== (kind === 'group')) {
        out.push({ rule: 'chat-kind', index: p.index, message: `${at}: isGroup is ${fmt(isGroup)} but chat.kind is '${kind}'` })
      }
      if (chatIsGroup !== (kind === 'group')) {
        out.push({ rule: 'chat-kind', index: p.index, message: `${at}: chat.isGroup is ${fmt(chatIsGroup)} but chat.kind is '${kind}'` })
      }
      if (typeof chatIsBroadcast !== 'boolean') {
        out.push({ rule: 'chat-kind', index: p.index, message: `${at}: chat.isBroadcast is ${fmt(chatIsBroadcast)}` })
      } else {
        if (p.source === 'message' && get(p.rec, 'isBroadcast') !== chatIsBroadcast) {
          out.push({ rule: 'chat-kind', index: p.index, message: `${at}: isBroadcast is ${fmt(get(p.rec, 'isBroadcast'))} but chat.isBroadcast is ${chatIsBroadcast}` })
        }
        if (kind === 'broadcast' && !chatIsBroadcast) {
          out.push({ rule: 'chat-kind', index: p.index, message: `${at}: chat.kind is 'broadcast' but chat.isBroadcast is false` })
        }
        if (chatIsBroadcast && kind !== 'broadcast' && kind !== 'channel') {
          out.push({ rule: 'chat-kind', index: p.index, message: `${at}: chat.isBroadcast is true for a '${kind}' chat` })
        }
      }
      const chatId = get(p.rec, 'chatId')
      if (typeof chatId === 'string' && chatId !== '') {
        const first = kindByChat.get(chatId)
        if (!first) kindByChat.set(chatId, { kind, index: p.index })
        else if (first.kind !== kind) {
          out.push({
            rule: 'kind-drift',
            index: p.index,
            message: `chat ${fmt(chatId)} is '${String(first.kind)}' at event #${first.index} but '${kind}' at event #${p.index}`,
          })
        }
      }
    }
  }

  // ---- per human -----------------------------------------------------------
  const humansBySender = new Map<string, Set<string>>()
  for (const [human, spec] of Object.entries(expectations)) {
    const ex: IdentityExpectation = Array.isArray(spec) ? { events: spec } : spec
    const members: Projected[] = []
    for (const idx of ex.events) {
      const p = Number.isInteger(idx) && idx >= 0 && idx < projected.length ? projected[idx] : undefined
      if (!p) {
        out.push({ rule: 'bad-index', human, index: idx, message: `human "${human}": event #${idx} is out of range or not a message/interaction` })
      } else {
        members.push(p)
      }
    }
    if (members.length === 0) continue

    const senders = groupBy(members, (p) => get(p.rec, 'senderId'))
    for (const s of senders.keys()) {
      if (typeof s !== 'string') continue
      const set = humansBySender.get(s) ?? new Set<string>()
      set.add(human)
      humansBySender.set(s, set)
    }
    if (senders.size > 1) {
      out.push({ rule: 'unstable-sender', human, message: `human "${human}": ${senders.size} different senderIds — ${describeGroups(senders)}` })
    }
    if (ex.senderId !== undefined) {
      const wrong = members.filter((p) => get(p.rec, 'senderId') !== ex.senderId)
      if (wrong.length > 0) {
        out.push({ rule: 'unexpected-sender', human, message: `human "${human}": expected senderId ${fmt(ex.senderId)} — ${describeGroups(groupBy(wrong, (p) => get(p.rec, 'senderId')))}` })
      }
    }

    const dms = members.filter((p) => get(p.rec, 'chat.kind') === 'dm')
    const dmChats = groupBy(dms, (p) => get(p.rec, 'chatId'))
    if (ex.chatId === undefined && dmChats.size > 1) {
      out.push({ rule: 'unstable-chat', human, message: `human "${human}": DM split across ${dmChats.size} chatIds — ${describeGroups(dmChats)}` })
    }
    if (ex.chatId !== undefined) {
      const wrong = members.filter((p) => get(p.rec, 'chatId') !== ex.chatId)
      if (wrong.length > 0) {
        out.push({ rule: 'unexpected-chat', human, message: `human "${human}": expected chatId ${fmt(ex.chatId)} — ${describeGroups(groupBy(wrong, (p) => get(p.rec, 'chatId')))}` })
      }
    }
    if (ex.kind !== undefined) {
      const wrong = members.filter((p) => get(p.rec, 'chat.kind') !== ex.kind)
      if (wrong.length > 0) {
        out.push({ rule: 'unexpected-kind', human, message: `human "${human}": expected chat.kind '${ex.kind}' — ${describeGroups(groupBy(wrong, (p) => get(p.rec, 'chat.kind')))}` })
      }
    }
  }

  if (distinctHumans) {
    for (const [senderId, humans] of humansBySender) {
      if (humans.size > 1) {
        out.push({ rule: 'collapsed-humans', message: `humans ${[...humans].map((h) => `"${h}"`).join(', ')} all carry senderId ${fmt(senderId)}` })
      }
    }
  }
  return out
}

/**
 * Throw an {@link IdentityContractError} listing every violation unless the
 * events satisfy the identity stability contract (see
 * {@link checkIdentityContract}). Runner-agnostic: works in any test framework.
 *
 * @throws {IdentityContractError}
 */
export function assertStableIdentity(
  events: ReadonlyArray<IdentityEventInput>,
  expectations: IdentityExpectations = {},
  options: IdentityContractOptions = {},
): void {
  const violations = checkIdentityContract(events, expectations, options)
  if (violations.length > 0) throw new IdentityContractError(violations)
}

/** Live recording of a provider's event stream (see {@link recordEvents}). */
export interface EventRecorder {
  /** Every event emitted since recording started, in order. */
  readonly events: InboundEvent[]
  /** Just the inbound messages. */
  messages(): InboundMessage[]
  /** Just the interactions. */
  interactions(): InboundInteraction[]
  /** Stop recording (unsubscribes from the provider). */
  stop(): void
}

/**
 * Subscribe to `provider.onEvent` and keep everything it emits — handy to feed
 * {@link assertStableIdentity} from a provider suite that drives `ingest()`
 * or a fake socket.
 */
export function recordEvents(provider: Pick<IProvider, 'onEvent'>): EventRecorder {
  const events: InboundEvent[] = []
  const off = provider.onEvent((e) => { events.push(e) })
  return {
    events,
    messages: () => events.flatMap((e) => (e.kind === 'message' ? [e.message] : [])),
    interactions: () => events.flatMap((e) => (e.kind === 'interaction' ? [e.interaction] : [])),
    stop: () => { off() },
  }
}

/* ============================================================================
 * INTERNALS
 * ========================================================================== */

interface Projected {
  index: number
  source: 'message' | 'interaction'
  rec: Record<string, unknown>
}

const ID_FIELDS = ['ref.id', 'ref.chatId', 'chatId', 'from', 'chat.id', 'senderId', 'sender', 'senderInfo.id']
const CHAT_KINDS: ReadonlySet<string> = new Set<ChatKind>(['dm', 'group', 'channel', 'broadcast'])
/** `undefined`/`null`/`NaN` as a whole token (e.g. `undefined@s.whatsapp.net`) or a stringified object. */
const SUSPICIOUS_ID = /(^|[^a-z])(undefined|null|nan)([^a-z]|$)|\[object /i

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

function project(input: unknown, index: number): Projected | undefined {
  if (!isRecord(input)) return undefined
  if ('interactionId' in input) return { index, source: 'interaction', rec: input }
  if (input.kind === 'message') return isRecord(input.message) ? { index, source: 'message', rec: input.message } : undefined
  if (input.kind === 'interaction') return isRecord(input.interaction) ? { index, source: 'interaction', rec: input.interaction } : undefined
  if ('kind' in input) return undefined // connection/status/reaction/… — no identity to check
  if ('ref' in input || 'senderId' in input || 'chatId' in input) return { index, source: 'message', rec: input }
  return undefined
}

function get(rec: Record<string, unknown>, path: string): unknown {
  let cur: unknown = rec
  for (const key of path.split('.')) {
    if (!isRecord(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

function agree(out: IdentityViolation[], p: Projected, at: string, paths: string[]): void {
  const values = paths
    .map((path) => ({ path, value: get(p.rec, path) }))
    .filter((x): x is { path: string; value: string } => typeof x.value === 'string' && x.value !== '')
  if (new Set(values.map((x) => x.value)).size > 1) {
    out.push({ rule: 'alias-mismatch', index: p.index, message: `${at}: ${values.map((x) => `${x.path}=${fmt(x.value)}`).join(', ')} disagree` })
  }
}

function groupBy(members: Projected[], key: (p: Projected) => unknown): Map<unknown, number[]> {
  const groups = new Map<unknown, number[]>()
  for (const p of members) {
    const k = key(p)
    const list = groups.get(k) ?? []
    list.push(p.index)
    groups.set(k, list)
  }
  return groups
}

function describeGroups(groups: Map<unknown, number[]>): string {
  return [...groups].map(([value, idx]) => `${fmt(value)} at ${idx.map((i) => `#${i}`).join(', ')}`).join('; ')
}

function fmt(value: unknown): string {
  if (value === undefined) return 'undefined'
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value)
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}
