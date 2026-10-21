/**
 * parseInbound — turn a WhatsApp Cloud API webhook body into normalized
 * {@link InboundEvent}s.
 *
 * Identity: the canonical chatId/senderId is the phone number (wa_id, E.164
 * without '+') when known, otherwise the business-scoped user id (BSUID) that
 * Meta sends for users who enabled a WhatsApp username. See `identity.ts`.
 * Items without any usable id are dropped and logged, never emitted with an
 * empty/undefined id.
 */

import type {
  InboundEvent,
  InboundLocation,
  InboundMessage,
  MessageType,
  MediaRef,
  SenderInfo,
  FormReply,
} from '@botmesh/core'
import { formReplyBody, toInboundLocation } from '@botmesh/core'
import {
  IdentityResolver,
  MemoryIdentityMap,
  asBsuid,
  asPhone,
  isPromiseLike,
  runInOrder,
  andThen,
  type IdentityLogger,
  type MaybePromise,
  type Party,
  type ResolvedParty,
} from './identity.js'
import { statusPlatformData, type GraphConversation, type GraphPricing } from './pricing.js'

/* Loose Graph webhook shapes (only the fields we read). Everything is optional:
 * the payload is external JSON and Meta omits fields (e.g. `from`/`wa_id` for
 * username users), so nothing here is trusted to be present or well-typed. */

export interface GraphMedia { id?: string; mime_type?: string; caption?: string; filename?: string }

export interface GraphMessage {
  /** Sender phone number (wa_id). OMITTED for many username users. */
  from?: string
  /** Sender business-scoped user id (BSUID), e.g. `US.13491208655302741918`. */
  from_user_id?: string
  /** Sender parent BSUID (linked business portfolios), e.g. `US.ENT.1181...`. */
  from_parent_user_id?: string
  id?: string
  timestamp?: string
  type?: string
  context?: { id?: string; from?: string; from_user_id?: string }
  text?: { body?: string }
  image?: GraphMedia
  video?: GraphMedia
  audio?: GraphMedia & { voice?: boolean }
  document?: GraphMedia
  sticker?: GraphMedia
  location?: { latitude?: number; longitude?: number; name?: string; address?: string }
  /** Shared contact cards (`type: 'contacts'`). */
  contacts?: Array<{ name?: { formatted_name?: string } }>
  /** Template quick-reply button click (`type: 'button'`). */
  button?: { payload?: string; text?: string }
  reaction?: { message_id?: string; emoji?: string }
  interactive?: {
    type?: string
    button_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string; description?: string }
    /** WhatsApp Flow completion: `response_json` is a JSON string with `flow_token` + the Footer payload. */
    nfm_reply?: { name?: string; body?: string; response_json?: string }
  }
  /** System notices, e.g. `user_changed_number` / `user_changed_user_id`. */
  system?: {
    body?: string
    type?: string
    /** New phone number (`user_changed_number`). */
    wa_id?: string
    /** Legacy name of the new phone number field. */
    new_wa_id?: string
    /** New BSUID. */
    user_id?: string
    /** New parent BSUID. */
    parent_user_id?: string
  }
}

export interface GraphStatus {
  id?: string
  /** Recipient phone number. Omitted when the phone is not shareable. */
  recipient_id?: string
  /** Recipient BSUID. Omitted on `failed` statuses for sends addressed to a phone number. */
  recipient_user_id?: string
  recipient_parent_user_id?: string
  status?: string
  timestamp?: string
  errors?: Array<{ code?: number; title?: string }>
  /** Billing info (PMP since 2025-07; CBP before). See `pricing.ts`. */
  pricing?: GraphPricing
  /** Legacy conversation-based pricing (CBP) / free entry-point conversation. */
  conversation?: GraphConversation
}

export interface GraphContact {
  profile?: { name?: string; username?: string }
  /** Phone number. Omitted for username users the business can't see the phone of. */
  wa_id?: string
  /** BSUID. */
  user_id?: string
  parent_user_id?: string
}

/** `user_id_update` webhook item: a user's BSUID changed (e.g. new phone number). */
export interface GraphUserIdUpdate {
  user_id?: { previous?: string; current?: string }
  parent_user_id?: { previous?: string; current?: string }
}

export interface GraphValue {
  messaging_product?: string
  metadata?: { display_phone_number?: string; phone_number_id?: string }
  contacts?: GraphContact[]
  messages?: GraphMessage[]
  statuses?: GraphStatus[]
  user_id_update?: GraphUserIdUpdate[]
}

export interface GraphWebhookBody {
  object?: string
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: GraphValue }> }>
}

/** Options for {@link parseInbound}. */
export interface ParseInboundOptions {
  /** Receives a warning for every dropped item (malformed or missing ids). pino-compatible. */
  logger?: IdentityLogger
}

/* --- Drafts: parsed items waiting for identity resolution ---------------- */

/** @internal */
export type InboundDraft =
  | { kind: 'event'; party: Party; build: (who: ResolvedParty) => InboundEvent }
  | { kind: 'learn'; party: Party }
  | { kind: 'alias'; previous: Party; next: Party }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

const mediaFields = { image: 'image', video: 'video', audio: 'audio', document: 'document', sticker: 'sticker' } as const

function mediaOf(msg: GraphMessage): { type: MessageType; body: string; ref?: MediaRef } {
  const kind = msg.type as keyof typeof mediaFields
  const field = mediaFields[kind]
  if (!field) return { type: 'unknown', body: '' }
  const type: MessageType = kind === 'audio' ? (msg.audio?.voice ? 'voice' : 'audio') : (kind as MessageType)
  const m = msg[field]
  if (!m) return { type, body: '' }
  return {
    type,
    body: m.caption ?? '',
    ref: { kind: (type === 'voice' ? 'audio' : type) as MediaRef['kind'], mimetype: m.mime_type, filename: m.filename, token: m.id },
  }
}

function senderInfoOf(who: ResolvedParty): SenderInfo {
  const platformData: Record<string, unknown> = {}
  if (who.phone !== undefined) platformData.phoneNumber = who.phone
  if (who.bsuid !== undefined) platformData.bsuid = who.bsuid
  if (who.parentBsuid !== undefined) platformData.parentBsuid = who.parentBsuid
  if (who.username !== undefined) platformData.username = who.username
  return {
    id: who.id,
    ...(who.displayName !== undefined ? { displayName: who.displayName } : {}),
    ...(who.username !== undefined ? { username: who.username } : {}),
    ...(Object.keys(platformData).length > 0 ? { platformData } : {}),
  }
}

function toMessage(msg: GraphMessage, id: string, who: ResolvedParty): InboundMessage<GraphMessage> {
  const chatId = who.id
  // A reply names the message it answers (ours or the user's) by its wamid.
  const quotedId = str(msg.context?.id)
  let type: MessageType = 'unknown'
  let body = ''
  let media: MediaRef | undefined
  let location: InboundLocation | undefined

  if (msg.type === 'text') {
    type = 'text'
    body = msg.text?.body ?? ''
  } else if (msg.type === 'location') {
    type = 'location'
    body = [str(msg.location?.name), str(msg.location?.address)].filter(Boolean).join(', ')
    location = toInboundLocation(msg.location)
  } else if (msg.type === 'contacts') {
    type = 'contact'
    const cards = Array.isArray(msg.contacts) ? msg.contacts : []
    body = cards.map((c) => str(c?.name?.formatted_name)).filter(Boolean).join(', ')
  } else if (msg.type !== undefined && msg.type in mediaFields) {
    const parsed = mediaOf(msg)
    type = parsed.type
    body = parsed.body
    media = parsed.ref
  }

  return {
    ref: { id, chatId, native: msg },
    chat: { id: chatId, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: senderInfoOf(who),
    from: chatId,
    sender: chatId,
    chatId,
    senderId: chatId,
    isGroup: false,
    isBroadcast: false,
    fromMe: false,
    type,
    body,
    timestamp: msg.timestamp ? Number(msg.timestamp) : 0,
    mentions: [],
    ...(quotedId !== undefined ? { quoted: { ref: { id: quotedId, chatId } } } : {}),
    media,
    ...(location ? { location } : {}),
    raw: msg,
  }
}

/** Split an `nfm_reply.response_json` into the core's normalized {@link FormReply}. */
function flowReplyOf(responseJson: unknown): FormReply | undefined {
  if (typeof responseJson !== 'string') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(responseJson) } catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const { flow_token: token, ...values } = parsed as Record<string, unknown>
  return typeof token === 'string' ? { token, values } : { values }
}

/** Build a party from raw webhook id fields; a BSUID-shaped `from` counts as a BSUID. */
function partyOf(phoneField: unknown, bsuidField: unknown, parentField: unknown, contact?: GraphContact): Party {
  const phone = asPhone(phoneField) ?? asPhone(contact?.wa_id)
  const bsuid = asBsuid(bsuidField) ?? asBsuid(contact?.user_id) ?? asBsuid(phoneField)
  const parentBsuid = asBsuid(parentField) ?? asBsuid(contact?.parent_user_id)
  const username = str(contact?.profile?.username)
  const displayName = str(contact?.profile?.name)
  return {
    ...(phone !== undefined ? { phone } : {}),
    ...(bsuid !== undefined ? { bsuid } : {}),
    ...(parentBsuid !== undefined ? { parentBsuid } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
  }
}

const hasId = (p: Party): boolean => p.phone !== undefined || p.bsuid !== undefined || p.parentBsuid !== undefined

/**
 * Find the `contacts[]` entry describing a message sender / status recipient:
 * by BSUID or phone, else the lone contact when the batch has a single item and
 * that contact does not contradict the ids the item itself carries.
 */
function matchContact(
  contacts: GraphContact[],
  phoneField: unknown,
  bsuidField: unknown,
  single: boolean,
): GraphContact | undefined {
  const phone = asPhone(phoneField)
  const bsuid = asBsuid(bsuidField) ?? asBsuid(phoneField)
  const found = contacts.find((c) =>
    (bsuid !== undefined && asBsuid(c.user_id) === bsuid) || (phone !== undefined && asPhone(c.wa_id) === phone))
  if (found) return found
  if (!single || contacts.length !== 1) return undefined
  const lone = contacts[0]
  const lonePhone = asPhone(lone.wa_id)
  const loneBsuid = asBsuid(lone.user_id)
  const conflicts =
    (phone !== undefined && lonePhone !== undefined && lonePhone !== phone) ||
    (bsuid !== undefined && loneBsuid !== undefined && loneBsuid !== bsuid)
  return conflicts ? undefined : lone
}

/**
 * Parse a webhook body into drafts (sync, no identity state). The provider
 * resolves them with its session-wide {@link IdentityResolver}.
 * @internal
 */
export function extractDrafts(body: GraphWebhookBody, logger: IdentityLogger): InboundDraft[] {
  const drafts: InboundDraft[] = []
  if (body?.object !== 'whatsapp_business_account') return drafts
  const drop = (item: string, reason: string, messageId?: string): void => {
    logger.warn({ item, reason, ...(messageId ? { messageId } : {}) }, 'Cloud API webhook item dropped')
  }

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value
      if (!value || typeof value !== 'object') continue
      const contacts = (Array.isArray(value.contacts) ? value.contacts : []).filter((c): c is GraphContact => !!c && typeof c === 'object')
      const msgs = (Array.isArray(value.messages) ? value.messages : []).filter((m): m is GraphMessage => !!m && typeof m === 'object')
      const statuses = (Array.isArray(value.statuses) ? value.statuses : []).filter((s): s is GraphStatus => !!s && typeof s === 'object')
      const used = new Set<GraphContact>()
      const contactFor = (phoneField: unknown, bsuidField: unknown, single: boolean): GraphContact | undefined => {
        const c = matchContact(contacts, phoneField, bsuidField, single)
        if (c) used.add(c)
        return c
      }

      // BSUID changes (`user_id_update` webhook).
      for (const upd of Array.isArray(value.user_id_update) ? value.user_id_update : []) {
        const previous = asBsuid(upd?.user_id?.previous)
        const current = asBsuid(upd?.user_id?.current)
        if (previous === undefined || current === undefined) {
          drop('user_id_update', 'missing previous/current BSUID')
          continue
        }
        const prevParent = asBsuid(upd?.parent_user_id?.previous)
        const nextParent = asBsuid(upd?.parent_user_id?.current)
        drafts.push({
          kind: 'alias',
          previous: { bsuid: previous, ...(prevParent !== undefined ? { parentBsuid: prevParent } : {}) },
          next: { bsuid: current, ...(nextParent !== undefined ? { parentBsuid: nextParent } : {}) },
        })
      }

      const pendingEvents: InboundDraft[] = []
      const singleMsg = msgs.length === 1

      for (const msg of msgs) {
        const id = str(msg.id)
        const contact = contactFor(msg.from, msg.from_user_id, singleMsg)
        const party = partyOf(msg.from, msg.from_user_id, msg.from_parent_user_id, contact)
        if (!hasId(party)) { drop('message', 'no usable sender id (from / from_user_id)', id); continue }
        if (id === undefined) { drop('message', 'missing message id'); continue }

        // Phone-number / BSUID change notices: link the new ids to this session's id.
        if (msg.type === 'system' && msg.system) {
          const sysType = msg.system.type
          if (sysType === 'user_changed_number' || sysType === 'user_changed_user_id') {
            const nextPhone = asPhone(msg.system.wa_id) ?? asPhone(msg.system.new_wa_id)
            const nextBsuid = asBsuid(msg.system.user_id)
            const nextParent = asBsuid(msg.system.parent_user_id)
            if (nextPhone !== undefined || nextBsuid !== undefined || nextParent !== undefined) {
              pendingEvents.push({
                kind: 'alias',
                previous: party,
                next: {
                  ...(nextPhone !== undefined ? { phone: nextPhone } : {}),
                  ...(nextBsuid !== undefined ? { bsuid: nextBsuid } : {}),
                  ...(nextParent !== undefined ? { parentBsuid: nextParent } : {}),
                },
              })
            }
          }
        }

        // WhatsApp Flow completions → 'form' messages (consumed by flow().form()).
        if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
          const reply = flowReplyOf(msg.interactive.nfm_reply?.response_json)
          if (!reply) { drop('nfm_reply', 'response_json is not a JSON object', id); continue }
          pendingEvents.push({
            kind: 'event',
            party,
            build: (who) => ({ kind: 'message', message: { ...toMessage(msg, id, who), type: 'form', body: formReplyBody(reply) } }),
          })
          continue
        }

        // Interactive replies (button/list clicks) and template quick-reply
        // buttons (`type: 'button'`) → interaction events.
        if ((msg.type === 'interactive' && msg.interactive) || (msg.type === 'button' && msg.button)) {
          const data = msg.type === 'button'
            ? str(msg.button?.payload) ?? str(msg.button?.text) ?? ''
            : (msg.interactive?.button_reply ?? msg.interactive?.list_reply)?.id ?? ''
          const kind = msg.type === 'interactive' && msg.interactive?.type === 'list_reply' ? 'list' : 'button'
          pendingEvents.push({
            kind: 'event',
            party,
            build: (who) => ({
              kind: 'interaction',
              interaction: {
                interactionId: id,
                ref: { id, chatId: who.id, native: msg },
                chat: { id: who.id, kind: 'dm', isGroup: false, isBroadcast: false },
                senderInfo: senderInfoOf(who),
                from: who.id, sender: who.id, chatId: who.id, senderId: who.id,
                isGroup: false,
                kind,
                data,
                timestamp: msg.timestamp ? Number(msg.timestamp) : 0,
                raw: msg,
              },
            }),
          })
          continue
        }

        // Reactions → reaction events (ref = the reacted-to message).
        if (msg.type === 'reaction' && msg.reaction) {
          const target = str(msg.reaction.message_id)
          if (target === undefined) { drop('reaction', 'missing reacted-to message id', id); continue }
          const emoji = msg.reaction.emoji ?? ''
          pendingEvents.push({
            kind: 'event',
            party,
            build: (who) => ({
              kind: 'reaction',
              reaction: { ref: { id: target, chatId: who.id, native: msg }, emoji, senderId: who.id, removed: !emoji },
            }),
          })
          continue
        }

        pendingEvents.push({ kind: 'event', party, build: (who) => ({ kind: 'message', message: toMessage(msg, id, who) }) })
      }

      const singleStatus = statuses.length === 1
      for (const st of statuses) {
        const status = st.status
        // Other values (`deleted`, `warning`…) are not delivery outcomes: never report them as failed.
        if (status !== 'sent' && status !== 'delivered' && status !== 'read' && status !== 'failed') continue
        const id = str(st.id)
        const contact = contactFor(st.recipient_id, st.recipient_user_id, singleStatus)
        const party = partyOf(st.recipient_id, st.recipient_user_id, st.recipient_parent_user_id, contact)
        if (!hasId(party)) { drop('status', 'no usable recipient id (recipient_id / recipient_user_id)', id); continue }
        if (id === undefined) { drop('status', 'missing message id'); continue }
        const timestamp = st.timestamp ? Number(st.timestamp) : 0
        const error = st.errors?.[0] ? { code: st.errors[0].code, message: st.errors[0].title } : undefined
        const platformData = statusPlatformData(st)
        pendingEvents.push({
          kind: 'event',
          party,
          build: (who) => ({
            kind: 'status',
            status: {
              ref: { id, chatId: who.id },
              status,
              recipient: who.id,
              error,
              timestamp,
              ...(platformData ? { platformData } : {}),
            },
          }),
        })
      }

      // Pairs from contacts that no message/status consumed are still learned.
      for (const c of contacts) {
        if (used.has(c)) continue
        const party = partyOf(c.wa_id, c.user_id, c.parent_user_id)
        if (party.phone !== undefined && party.bsuid !== undefined) drafts.push({ kind: 'learn', party })
      }
      drafts.push(...pendingEvents)
    }
  }
  return drafts
}

/**
 * Resolve drafts in order against `resolver`. Synchronous while the resolver's
 * identity map answers synchronously; otherwise returns a promise.
 * @internal
 */
export function resolveDrafts(drafts: readonly InboundDraft[], resolver: IdentityResolver, logger: IdentityLogger): MaybePromise<InboundEvent[]> {
  const events: InboundEvent[] = []
  const done = runInOrder(drafts, (draft) => {
    if (draft.kind === 'learn') { resolver.learn(draft.party); return }
    if (draft.kind === 'alias') return resolver.alias(draft.previous, draft.next)
    return andThen(resolver.resolve(draft.party), (who) => {
      if (!who) { logger.warn({ reason: 'unresolvable id' }, 'Cloud API webhook item dropped'); return }
      events.push(draft.build(who))
    })
  })
  return andThen(done, () => events)
}

const NOOP_LOGGER: IdentityLogger = { warn() {}, error() {}, debug() {} }

/**
 * Parse a full webhook body into a flat list of events.
 *
 * Stateless: identity is resolved within this body only (phone when present,
 * else BSUID). `CloudAPIProvider.ingest()` additionally remembers phone ↔ BSUID
 * pairs across webhooks so a user keeps the same id when Meta later omits the
 * phone number.
 */
export function parseInbound(body: GraphWebhookBody, options: ParseInboundOptions = {}): InboundEvent[] {
  const logger = options.logger ?? NOOP_LOGGER
  const resolver = new IdentityResolver(new MemoryIdentityMap(), logger)
  const result = resolveDrafts(extractDrafts(body, logger), resolver, logger)
  // MemoryIdentityMap is synchronous, so resolution never goes async here.
  if (isPromiseLike(result)) throw new Error('parseInbound: unexpected asynchronous identity resolution')
  return result
}
