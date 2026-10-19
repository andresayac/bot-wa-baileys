/**
 * @bot-wa/core — IProvider v2 and normalized transport-agnostic types.
 *
 * Design invariants:
 *  - Core carries NO transport-specific concept. No JID / LID / PN / @g.us /
 *    WAMessageKey / proto / QR. Those live in @bot-wa/baileys.
 *  - Identity is OPAQUE strings the provider fully resolves before emitting an
 *    event. Any aliasing (LID/PN twin, Telegram sender_chat, Discord member vs
 *    user) is reconciled INSIDE the provider. The core never re-derives identity.
 *  - Inbound is normalized to `InboundEvent`; outbound to `OutboundContent`.
 *  - ESM, zero runtime deps in core (only structural / type-only references).
 */

import type { HandoffConfig, HandoffOptions, StoredHandoff } from '../gates/handoff.js'
import type { InboundDedupeOptions } from './dedupe.js'
import type { DurabilityConfig } from '../durability/types.js'
import type { UserData } from '../user/types.js'
import type { EditOptions, EditResult, MessagingFeature, MessagingSupport, ReplyOptions, TypingConfig } from './messaging.js'
import type { I18nConfig, LangSource, TranslateParams } from '../i18n/types.js'
import type { StreamOptions, StreamResult, StreamSource } from '../streaming/types.js'
import type { FormContent, FormDefinition } from '../forms/types.js'

/* ============================================================================
 * 1. IDENTITY PRIMITIVES  (opaque — no shape grammar)
 * ========================================================================== */

/** A chat/conversation identifier. Opaque; NEVER string-sniffed by core. */
export type ChatId = string
/** A user/sender identifier. Opaque. */
export type UserId = string
/** A message identifier. Opaque; unique only within its chat for some transports. */
export type MessageId = string

/**
 * Transport-neutral reference to a specific message. Replaces `WAMessageKey`.
 * `{id, chatId}` is the portable minimum; `native` round-trips the provider's
 * own key shape (WAMessageKey, Telegram {chat_id,message_id}, Discord snowflakes)
 * so a provider can act on it later without the core knowing its structure.
 */
export interface MessageRef {
  id: MessageId
  chatId: ChatId
  native?: unknown
}

/* ============================================================================
 * 2. CHAT / SENDER  (provider-computed classification)
 * ========================================================================== */

/** Provider-populated chat classification — never inferred from id shape. */
export type ChatKind = 'dm' | 'group' | 'channel' | 'broadcast'

export interface ChatInfo {
  id: ChatId
  kind: ChatKind
  name?: string
  /** Convenience mirror of `kind === 'group'`; provider sets it, core only reads. */
  isGroup: boolean
  isBroadcast: boolean
  participants?: UserId[]
  /** Transport-native extras (WA group subject cache, Discord guildId, ...). */
  platformData?: Record<string, unknown>
}

/**
 * Base, cross-transport sender fields only. WA-only vocabulary (phoneNumber,
 * lid, isBusiness) and Telegram/Discord extras (languageCode, nickname, roles)
 * live in `platformData`, NOT as named fields on the shared type.
 */
export interface SenderInfo {
  id: UserId
  displayName?: string
  username?: string
  isBot?: boolean
  /**
   * Language the platform reports for the sender (BCP 47-ish code, e.g. `'en'`,
   * `'pt-BR'`), when it has one. Used by i18n language resolution; providers
   * that only expose it in `platformData.languageCode` work too.
   */
  language?: string
  platformData?: Record<string, unknown>
}

/* ============================================================================
 * 3. MESSAGE TYPE + MEDIA
 * ========================================================================== */

export type MessageType =
  | 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document'
  | 'sticker' | 'location' | 'contact' | 'poll' | 'buttons' | 'list'
  | 'unknown'
  /**
   * A native form submission (e.g. a WhatsApp Flow completion). Its `body` is
   * `JSON.stringify(FormReply)` — build it with `formReplyBody()`, read it with
   * `parseFormReply()`. Consumed by `flow().form()` steps.
   */
  | 'form'
  /**
   * Not a message a provider emits: the Bot projects an inbound {@link CallEvent}
   * into a context of this type so the `CALL` trigger can handle it (see `core/triggers.ts`).
   */
  | 'call'

/**
 * Opaque, lazy media reference on an inbound event. The bytes are NOT inline;
 * `IProvider.downloadMedia(ref)` retrieves them. This single shape covers:
 *  - Baileys (decrypt + CDN fetch + possible reupload),
 *  - Cloud API / Telegram (resolve id -> short-lived URL -> fetch bytes),
 *  - Discord (plain HTTPS GET).
 */
export interface MediaRef {
  kind: Exclude<MessageType, 'text' | 'poll' | 'buttons' | 'list' | 'unknown' | 'call' | 'form'>
  mimetype?: string
  filename?: string
  size?: number
  /** Provider-internal handle (Baileys message, Telegram file_id, Discord url). */
  token: unknown
}

/**
 * A location the user shared, normalized by the provider (`InboundMessage.location`,
 * surfaced on `ctx.sharedLocation`). Coordinates are WGS84 decimal degrees.
 *
 * Providers fill it for: WhatsApp via Baileys (`locationMessage` / `liveLocationMessage`),
 * WhatsApp Cloud API (`location`), Telegram (`location` / `venue`) and Messenger
 * (`location` attachments, when Meta still sends coordinates).
 */
export interface InboundLocation {
  latitude: number
  longitude: number
  /** Place name (a venue, a named pin), when the transport sends one. */
  name?: string
  /** Street address, when the transport sends one. */
  address?: string
  /** `true` for a live-location share (its first update); omitted for a static pin. */
  live?: boolean
}

/** Downloaded media payload surfaced on `ctx.media`. */
export interface MediaPayload {
  buffer: Buffer
  mimetype: string
  filename?: string
  size?: number
}

/**
 * Outbound media source. Extensible per provider via the `native` escape hatch
 * (e.g. Telegram's reuse-by-`file_id`) rather than a fixed closed union.
 */
export type MediaSource =
  | string
  | Buffer
  | { url: string }
  | { buffer: Buffer }
  | { path: string }
  | { stream: NodeJS.ReadableStream }
  | { native: unknown }

/* ============================================================================
 * 4. INBOUND — normalized events
 * ========================================================================== */

/**
 * A quoted/replied-to message. `body`/`senderId` may be absent when a transport
 * only returns the id inline (Cloud API); resolve lazily via provider.getMessage.
 */
export interface QuotedRef {
  ref?: MessageRef
  body?: string
  senderId?: UserId
}

/**
 * The single normalized inbound message. `chatId`/`senderId` are ALREADY stable
 * and resolved — the stability contract (see `IProvider`) guarantees the same
 * human yields the same `senderId` (and chat the same `chatId`) for the session,
 * so `ConversationRuntime.keyFor(`${chatId}:${senderId}`)` is safe for ANY
 * conforming provider. Field names `from`/`sender`/`body`/`type`/`isGroup` are
 * duplicated to match `RuntimeMessage`/`MessageContext` so the object flows into
 * the dispatcher/runtime unchanged.
 */
export interface InboundMessage<TRaw = unknown> {
  /**
   * `ref.id` MUST be unique per logical inbound message within its chat and
   * stable across redelivery (webhook retry, reconnect replay), or `''` when the
   * transport cannot guarantee that. Core dedupes on `chatId` + `ref.id`
   * (`BotConfig.dedupe`, on by default); see the INBOUND ID CONTRACT on {@link IProvider}.
   */
  ref: MessageRef
  chat: ChatInfo
  senderInfo: SenderInfo

  /** Flattened, keyFor-ready aliases (identical values to chat.id / senderInfo.id). */
  from: ChatId
  sender: UserId
  chatId: ChatId
  senderId: UserId

  isGroup: boolean
  isBroadcast: boolean
  fromMe: boolean

  type: MessageType
  body: string
  timestamp: number

  mentions: UserId[]
  quoted?: QuotedRef
  media?: MediaRef
  /**
   * The shared location of a `type: 'location'` message, when the transport sends
   * coordinates. `body` stays the place name/address (or `''`) for text matching.
   */
  location?: InboundLocation

  /** Provider-native payload (proto.IWebMessageInfo, webhook JSON, gateway obj). */
  raw: TRaw
}

/**
 * A UI interaction that is NOT a free message: Telegram callback_query, Discord
 * component click / slash command. `data` is the provider-defined id the bot set
 * when building the control. `respondBy` is the ack deadline (Discord 3s /
 * Telegram spinner); the core must call `acknowledgeInteraction` before it.
 */
export interface InboundInteraction<TRaw = unknown> {
  /**
   * MUST be unique per logical interaction within its chat and stable across
   * redelivery, or `''` when the transport cannot guarantee that. Never a
   * per-user or per-control constant (sender id, payload): core dedupes on
   * `chatId` + `interactionId`, so a reused id silently drops the user's next
   * interaction. See the INBOUND ID CONTRACT on {@link IProvider}.
   */
  interactionId: string
  ref: MessageRef
  chat: ChatInfo
  senderInfo: SenderInfo
  from: ChatId
  sender: UserId
  chatId: ChatId
  senderId: UserId
  isGroup: boolean
  kind: 'button' | 'list' | 'command' | 'modal' | 'autocomplete'
  data: string
  /** Epoch ms by which acknowledgeInteraction() must run, if the transport enforces one. */
  respondBy?: number
  timestamp: number
  raw: TRaw
}

/** Neutral delivery/read receipt — replaces piggybacking on Baileys' ack shape. */
export interface DeliveryStatus {
  ref: MessageRef
  status: 'sent' | 'delivered' | 'read' | 'failed'
  recipient?: UserId
  error?: { code?: string | number; message?: string }
  timestamp: number
  /**
   * Transport-specific receipt data the core never interprets (e.g. the
   * Cloud API `pricing` / `conversation` objects of a status webhook).
   */
  platformData?: Record<string, unknown>
}

export interface InboundReaction {
  ref: MessageRef
  emoji: string
  senderId: UserId
  removed?: boolean
}

export interface PollVote {
  ref: MessageRef
  senderId: UserId
  /** Aggregated per-option tallies the provider computed internally. */
  options: Array<{ name: string; votes: number; voters?: UserId[] }>
}

/**
 * The discriminated union every provider emits through `onEvent`. Replaces the
 * ad-hoc string-keyed emitter (`rawMessage`, `messageUpdate`, `reaction`, ...).
 */
/**
 * Listener passed to {@link IProvider.onEvent}: receives every normalized inbound
 * event. May be async; providers do not await it unless they document so.
 */
export type InboundListener<TRaw = unknown> = (event: InboundEvent<TRaw>) => void | Promise<void>

export type InboundEvent<TRaw = unknown> =
  | { kind: 'message'; message: InboundMessage<TRaw> }
  | { kind: 'interaction'; interaction: InboundInteraction<TRaw> }
  | { kind: 'status'; status: DeliveryStatus }
  | { kind: 'reaction'; reaction: InboundReaction }
  | { kind: 'poll-vote'; vote: PollVote }
  | { kind: 'connection'; update: ConnectionUpdate }
  | { kind: 'group'; event: GroupEvent }
  | { kind: 'presence'; event: PresenceEvent }
  | { kind: 'call'; event: CallEvent }

export interface GroupEvent {
  chatId: ChatId
  action: 'add' | 'remove' | 'promote' | 'demote' | 'update'
  participants: UserId[]
  actor?: UserId
}
export interface PresenceEvent {
  chatId: ChatId
  presences: Record<UserId, { lastKnownPresence?: string; lastSeen?: number }>
}
/**
 * An inbound call notification. Transports may emit several per call (one per
 * status update) with the same `id`.
 */
export interface CallEvent {
  id: string
  /**
   * The caller, resolved to the SAME canonical id their messages carry as
   * `senderId` (the identity-stability contract applies to calls too).
   */
  from: UserId
  /** Transport status, e.g. WhatsApp `offer` / `ringing` / `reject` / `timeout` / `terminate`. */
  status: string
  /**
   * The chat the call belongs to: the group for a group call. Omitted → the DM
   * with the caller (`from`).
   */
  chatId?: ChatId
  /** `true` when `chatId` is a group (a group call). Provider-set, like `ChatInfo.isGroup`. */
  isGroup?: boolean
  /** `true` for a video call, when the transport says so. */
  isVideo?: boolean
  /**
   * `true` when the notification was delivered late (e.g. replayed after the bot
   * reconnected) rather than while the call was ringing.
   */
  offline?: boolean
}

/* ============================================================================
 * 5. OUTBOUND — normalized content
 * ========================================================================== */

export interface Button {
  id: string
  title: string
  /** Optional link/URL variant (Telegram url button, WA CTA-URL). */
  url?: string
}

export interface ListSection {
  title?: string
  rows: Array<{ id: string; title: string; description?: string }>
}

/** Options common to any send. */
export interface SendOptions {
  /**
   * Durability (`BotConfig.durability`): idempotency key of this send in the outbox. A key
   * that was already sent is answered from the outbox without sending again. Optional —
   * sends made while handling an inbound message get a deterministic key automatically.
   * With durability on, core strips it before calling the provider; with it off, it is
   * passed through and providers ignore it.
   */
  idempotencyKey?: string
  quoted?: MessageRef
  mentions?: UserId[]
  /**
   * Reply INTO a time-boxed interaction (Discord interaction token, Telegram
   * callback). Providers that lack the concept ignore it.
   */
  interactionId?: string
  /** Transport-native passthrough (WA ephemeralExpiration, Discord flags, ...). */
  platformData?: Record<string, unknown>
}

/**
 * Tagged union of transport-neutral content. Each provider maps a kind to its
 * native primitive, and MUST reject a kind it cannot honor with
 * `UnsupportedContentError` (or degrade explicitly, as Baileys maps `buttons`
 * to numbered text). The `template` and `native` kinds are the escape hatches
 * for transport-specific features (Cloud API templates, Discord components,
 * Telegram inline keyboards) without polluting the neutral kinds.
 */
export type OutboundContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; media: MediaSource; caption?: string; viewOnce?: boolean }
  | { kind: 'video'; media: MediaSource; caption?: string; gifPlayback?: boolean; ptv?: boolean; viewOnce?: boolean }
  | { kind: 'audio'; media: MediaSource }
  | { kind: 'voice'; media: MediaSource }
  | { kind: 'document'; media: MediaSource; filename?: string; caption?: string; mimetype?: string }
  | { kind: 'sticker'; media: MediaSource; pack?: string; author?: string }
  | { kind: 'location'; lat: number; lng: number; name?: string; address?: string }
  | { kind: 'contact'; phone: string; displayName?: string }
  | { kind: 'poll'; question: string; options: string[]; multiSelect?: boolean }
  | { kind: 'reaction'; emoji: string; target: MessageRef }
  | { kind: 'buttons'; text: string; buttons: Button[]; footer?: string }
  | { kind: 'list'; text: string; buttonText: string; sections: ListSection[]; footer?: string }
  | { kind: 'card'; title: string; body?: string; imageUrl?: string; buttons?: Button[] }
  | { kind: 'template'; name: string; language: string; components?: unknown }
  | { kind: 'native'; provider: string; payload: unknown }
  /** A native form (only sent to providers with `capabilities.forms === 'native'`). */
  | FormContent

/** Result of a send. Opaque `ref` — no faked remoteJid/fromMe triple. */
export interface SendResult<TRaw = unknown> {
  ref: MessageRef
  raw?: TRaw
  /** True when a before('send') hook aborted; nothing was transmitted. */
  skipped?: boolean
}

/* ============================================================================
 * 6. CAPABILITIES + CONSTRAINTS  (queryable per provider)
 * ========================================================================== */

export interface ProviderCapabilities {
  /** Content kinds this provider can actually deliver. */
  contentKinds: ReadonlyArray<OutboundContent['kind']>
  maxTextLength?: number
  maxMediaBytes?: number
  maxButtonDataBytes?: number
  buttons: boolean
  lists: boolean
  polls: boolean
  /**
   * Can SEND reactions (an outbound `reaction` OutboundContent). This does NOT
   * describe inbound reaction receipt — providers may emit inbound `reaction`
   * events regardless of this flag (e.g. Messenger/Instagram receive reactions
   * but cannot send them, so they set this false).
   */
  reactions: boolean
  edit: boolean
  typing: boolean
  presence: boolean
  readReceipts: boolean
  groups: boolean
  templates: boolean
  /** Interactions carry a hard ack deadline (Discord/Telegram). */
  interactionsRequireAck: boolean
  /** Delivery is push-to-us (webhook) rather than a socket the provider owns. */
  pushIngress: boolean
  /**
   * How `flow().form()` renders: `'native'` = the provider accepts `form`
   * OutboundContent and emits `'form'` inbound messages with the submission
   * (WhatsApp Flows on the Cloud API); `'degraded'` (or absent) = the core asks
   * field by field with plain text messages.
   */
  forms?: 'native' | 'degraded'
  /**
   * How `ctx.stream()` renders a reply that is still being generated:
   * `'draft'` — native ephemeral draft previews ({@link IProvider.sendDraft}) then
   * one final send (Telegram `sendMessageDraft`); `'edit'` — send once, then
   * throttled {@link IProvider.editMessage} calls (Discord, Telegram groups);
   * `'none'` — no live preview: sentence-sized chunks with typing (WhatsApp).
   * Omitted → treated as `'none'`.
   */
  streaming?: StreamingMode
  /**
   * Rich-text dialect the channel renders in plain text messages, so producers
   * of Markdown (e.g. `@bot-wa/ai` replies) can convert it: `'whatsapp'` —
   * `*bold*`, `_italic_`, `~strike~`, `` `code` ``; `'markdown'` — Markdown is
   * rendered as is (Discord); `'html'` — a small HTML subset; `'plain'` — no
   * formatting at all (markers are shown literally, so strip them). Omitted →
   * unknown: text is sent untouched.
   */
  textFormat?: TextFormat
}

/** See {@link ProviderCapabilities.streaming}. */
export type StreamingMode = 'draft' | 'edit' | 'none'

/** See {@link ProviderCapabilities.textFormat}. */
export type TextFormat = 'whatsapp' | 'markdown' | 'html' | 'plain'

/** Options of one {@link IProvider.sendDraft} call. */
export interface DraftOptions {
  /** Show the user a button to stop the generation (Telegram `can_stop`). */
  canStop?: boolean
  /** Keep the draft visible when the user presses stop (Telegram `keep_on_stop`). */
  keepOnStop?: boolean
  /**
   * Called (at most once) when the user stops this draft. Providers without a
   * stop control never call it.
   */
  onStop?: () => void
  /** Transport-native passthrough (e.g. Telegram `message_thread_id`). */
  platformData?: Record<string, unknown>
}

/* ============================================================================
 * 7. CONNECTION STATE  (neutral — no baked-in 'qr')
 * ========================================================================== */

export type ConnectionState = 'connecting' | 'authenticating' | 'ready' | 'closed'

/** Transport-neutral disconnect taxonomy. Providers map their codes into this. */
export type DisconnectReason =
  | 'sessionInvalid'    // wipe + re-auth (Baileys loggedOut/badSession)
  | 'sessionTakenOver'  // MUST NOT auto-reconnect (Baileys conflict 440; TG/Discord 409)
  | 'transient'         // reconnect with backoff
  | 'rateLimited'       // reconnect after a signalled delay
  | 'unknown'

export interface ConnectionUpdate {
  state: ConnectionState
  /**
   * Opaque, provider-rendered auth artifact for the UI layer: a QR string,
   * an OAuth URL, a pairing code, or undefined (token auth). Core never
   * interprets it — it forwards it to the host.
   */
  authPayload?: unknown
  reason?: DisconnectReason
  /** Advisory reconnect delay (ms) when reason === 'rateLimited'. */
  retryAfterMs?: number
  detail?: { code?: string | number; message?: string }
}

/* ============================================================================
 * 8. TYPED OUTBOUND ERRORS  (core, zero deps)
 * ========================================================================== */

/** Base of the typed send errors; `name` is the concrete class name. */
export class ProviderError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A provider cannot honor an OutboundContent kind/field. */
export class UnsupportedContentError extends ProviderError {
  constructor(public readonly kind: OutboundContent['kind'], message?: string) {
    super(message ?? `Unsupported content kind: ${kind}`)
    this.name = 'UnsupportedContentError'
  }
}
/** Server-signalled quota (Telegram 429 retry_after, Discord bucket, Cloud API tier). */
export class RateLimitedError extends ProviderError {
  constructor(public readonly retryAfterMs: number, message?: string) {
    super(message ?? `Rate limited; retry after ${retryAfterMs}ms`)
    this.name = 'RateLimitedError'
  }
}
/** Recipient can't be initiated / permanently unreachable (Telegram 403). */
export class RecipientUnreachableError extends ProviderError {
  constructor(public readonly chatId: ChatId, message?: string) {
    super(message ?? `Recipient unreachable: ${chatId}`)
    this.name = 'RecipientUnreachableError'
  }
}
/** Payload exceeds a transport limit (Telegram 4096 chars, media ceilings). */
export class PayloadTooLargeError extends ProviderError {
  constructor(message?: string) { super(message); this.name = 'PayloadTooLargeError' }
}
/**
 * Inbound media over the `maxBytes` cap of {@link loadMediaOf}. `bytes` is the
 * declared size when the provider reported one (nothing was downloaded), or the
 * bytes read before the download was cut.
 */
export class MediaTooLargeError extends PayloadTooLargeError {
  constructor(public readonly bytes: number, public readonly maxBytes: number) {
    super(`Inbound media is larger than ${maxBytes} bytes (${bytes} bytes or more)`)
    this.name = 'MediaTooLargeError'
  }
}
/** Outside the send window for free-form content (Cloud API 24h window). */
export class OutsideSessionWindowError extends ProviderError {
  constructor(public readonly chatId: ChatId, message?: string) {
    super(message ?? `Outside session window for ${chatId}; a template is required`)
    this.name = 'OutsideSessionWindowError'
  }
}

/* ============================================================================
 * 9. IProvider v2
 * ========================================================================== */

/**
 * Transport-agnostic provider contract. `TRaw` is the provider's native raw
 * payload (proto.IWebMessageInfo, webhook entry, gateway object); it stays
 * `unknown` in all shared code and is narrowed only inside provider-specific
 * paths.
 *
 * STABILITY CONTRACT (normative): for the lifetime of a session, the same
 * entity MUST yield the same `senderId` and the same chat the same `chatId` on
 * every emitted event. All transport-internal aliasing is resolved inside the
 * provider before emission. The core performs no identity reconciliation.
 *
 * INBOUND ID CONTRACT (normative): a message's `ref.id` and an interaction's
 * `interactionId` identify ONE logical inbound event within its chat: distinct
 * events get distinct ids, and a redelivery of the same event (webhook retry,
 * reconnect replay) carries the same id. Core relies on this for inbound
 * idempotency (`BotConfig.dedupe`, keyed by `chatId` + id). When the transport
 * provides no such id, synthesize one from per-event data that a redelivery
 * repeats (e.g. kind + event timestamp) or emit `''`, which opts the event out
 * of deduplication. Never fall back to a per-user constant (sender id,
 * `user_ref`) or a shared placeholder (`'<prefix>_0'`).
 */
export interface IProvider<TRaw = unknown> {
  /** Stable transport tag (e.g. 'baileys', 'telegram') — used to namespace
   *  conversation keys if one Bot ever runs multiple providers concurrently. */
  readonly id: string
  readonly capabilities: ProviderCapabilities

  /** The bot's own user id once connected (for group mention matching). Optional. */
  readonly selfId?: UserId | null

  start(): Promise<void>
  stop(): Promise<void>

  /** Send normalized content. Rejects with a typed error (section 8) on failure. */
  send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<TRaw>>

  /** Subscribe to the normalized event stream. Returns an unsubscriber. */
  onEvent(listener: InboundListener<TRaw>): () => void

  /**
   * Push ingress for webhook transports (Cloud API POST, Telegram/Discord
   * webhook, Discord interaction endpoint). The host HTTP server calls this with
   * the raw body (and, optionally, the request headers for signature checks); the
   * provider normalizes and emits via onEvent. May return a value the host can
   * use as the HTTP status (e.g. 200 accepted / 403 bad signature). Socket-first
   * providers (Baileys, Discord gateway) omit it.
   */
  ingest?(rawEvent: unknown, headers?: Record<string, string | string[] | undefined>): unknown

  /** Lazy media retrieval behind one signature for every download model. */
  downloadMedia?(ref: MediaRef): Promise<Buffer | NodeJS.ReadableStream>

  /**
   * Read-back seam for poll aggregation, quote-body resolution, retry decrypt.
   * Providers that don't need it no-op / omit it. Replaces the constructor-
   * injected `getMessage` callback baked into BaileysProvider today.
   */
  getMessage?(ref: MessageRef): Promise<InboundMessage<TRaw> | undefined>

  /* Capability-gated optional actions — presence/read/delete/edit/ack. Bot must
   * feature-detect (`if (provider.typing)`), never reach into a socket. */
  markRead?(refs: MessageRef[]): Promise<void>
  typing?(chatId: ChatId, state?: 'typing' | 'recording' | 'paused'): Promise<void>
  deleteMessage?(ref: MessageRef): Promise<void>
  editMessage?(ref: MessageRef, content: OutboundContent): Promise<SendResult<TRaw>>
  acknowledgeInteraction?(interactionId: string, opts?: { text?: string; defer?: boolean }): Promise<void>
  /**
   * Show (or update) an ephemeral, not-yet-sent preview of a message being
   * generated. Same `draftId` → the same draft is updated in place. A draft is
   * NOT a message: the caller must still `send()` the final text. Only for
   * providers with `capabilities.streaming === 'draft'`; rejects (typed error)
   * where the transport refuses drafts (e.g. Telegram groups), and the caller
   * then falls back to edits or chunks.
   */
  sendDraft?(chatId: ChatId, draftId: number, text: string, opts?: DraftOptions): Promise<void>

  /**
   * Whether a `form` OutboundContent for `form` (and `opts.nativeId`) can be
   * rendered natively right now, e.g. whether a WhatsApp Flow is mapped to it.
   * Only consulted when `capabilities.forms === 'native'`; when it returns
   * `false`, an auto-mode `flow().form()` asks field by field without sending
   * (and failing) a form message first. Absent = every form is renderable.
   */
  canRenderForm?(form: FormDefinition, opts?: { nativeId?: string }): boolean

  /**
   * Rich-text dialect of one chat, for providers that serve several channels
   * with different markup through one instance (e.g. Twilio: `whatsapp:` chats
   * render WhatsApp markup, SMS chats render none). Return `undefined` when the
   * chat's format is unknown; the core then falls back to
   * `capabilities.textFormat`. Exposed as `ctx.textFormat`. Must be synchronous
   * and cheap (it runs once per inbound message). Absent = every chat uses
   * `capabilities.textFormat`.
   */
  textFormatFor?(chatId: ChatId): TextFormat | undefined

  /**
   * A single primary connection handle for DEBUGGING ONLY. Not a structural
   * guarantee of exactly one connection (Discord may hold many shard sockets).
   * Core must NOT reach through this for behavior.
   */
  readonly connection?: unknown | null
}

/* ============================================================================
 * 10. MESSAGE CONTEXT  (generic; ergonomics preserved)
 * ========================================================================== */

export interface DefaultTools {}

/**
 * The ergonomic context handed to every handler. Generic over `TRaw`. The
 * reply helpers keep IDENTICAL signatures to v1 — internally each now builds an
 * `OutboundContent` descriptor and calls `provider.send`, instead of hand-rolling
 * Baileys JSON. `from`/`sender`/`body`/`type`/`isGroup` are read straight off the
 * normalized `InboundMessage`, so user code and `keyFor` are unchanged.
 */
export interface MessageContext<TTools extends object = DefaultTools, TRaw = unknown> {
  /* Normalized inbound data */
  body: string
  from: ChatId
  sender: UserId
  senderInfo: SenderInfo
  pushName?: string
  chat: ChatInfo
  type: MessageType
  isGroup: boolean
  isPrivate: boolean
  isFromMe: boolean
  mentions: UserId[]
  quoted?: QuotedRef
  media?: MediaPayload
  /**
   * The location the user shared (`type === 'location'`), normalized by the provider;
   * `undefined` otherwise. Named `sharedLocation` because `ctx.location()` SENDS one.
   */
  sharedLocation?: InboundLocation
  ref: MessageRef
  raw: TRaw
  timestamp: number

  /**
   * Present only when this context projects an interaction (Telegram/Discord).
   * `acknowledge()` is a safe no-op on transports without ack (WhatsApp).
   */
  interaction?: { id: string; data: string; respondBy?: number }
  acknowledge?(text?: string): Promise<void>

  /**
   * Present only on the context the `CALL` trigger receives (`type === 'call'`):
   * the provider's normalized call notification.
   */
  call?: CallEvent

  /* Reply helpers — every reply targets `this.from` (unchanged surface) */
  /* Text helpers accept {@link ReplyOptions}: `{ typing }` overrides `BotConfig.typing`, `{ delay }` pauses first. */
  /** Send text to this chat. Same as {@link MessageContext.reply} (mirrors the flow DSL's `.say`). */
  say(text: string, opts?: ReplyOptions): Promise<SentMessage>
  /** Send text to this chat (`ctx.from`). The canonical text reply; `say`, `answer` and `text` are aliases. */
  reply(text: string, opts?: ReplyOptions): Promise<SentMessage>
  /** Alias of {@link MessageContext.reply}. */
  answer(text: string, opts?: ReplyOptions): Promise<SentMessage>
  /** Alias of {@link MessageContext.reply}. */
  text(t: string, opts?: ReplyOptions): Promise<SentMessage>
  photo(source: MediaSource, caption?: string): Promise<SentMessage>
  video(source: MediaSource, caption?: string, opts?: { gifPlayback?: boolean; ptv?: boolean }): Promise<SentMessage>
  audio(source: MediaSource): Promise<SentMessage>
  voice(source: MediaSource): Promise<SentMessage>
  file(source: MediaSource, filename?: string, caption?: string): Promise<SentMessage>
  sticker(source: MediaSource, opts?: { pack?: string; author?: string }): Promise<SentMessage>
  location(lat: number, lng: number, name?: string): Promise<SentMessage>
  contact(phone: string, displayName?: string): Promise<SentMessage>
  poll(question: string, options: string[], multiSelect?: boolean): Promise<SentMessage>
  buttons(text: string, buttons: Button[]): Promise<SentMessage>
  /**
   * React to the inbound message (or `target`). On a provider without
   * `capabilities.reactions` it resolves a `skipped` result instead of rejecting.
   * An empty `emoji` removes the reaction where the transport supports it.
   */
  react(emoji: string, target?: MessageRef): Promise<SentMessage>
  quote(text: string, opts?: ReplyOptions): Promise<SentMessage>
  /**
   * Edit this context's own last reply (`ctx.edit(content)`, only when it has the same
   * content kind and no `bot.send`/`bot.sendTo` went to the chat since; replies of other
   * handler runs or other participants' flows are never targeted) or a given one
   * (`ctx.edit(ref, content)`; a fallback send goes to `ref.chatId`). Native when the provider has `capabilities.edit` and
   * `editMessage`; otherwise (or when the kind is not editable there) it falls back
   * to sending a new message — `{ fallback: 'skip' }` sends nothing instead. Edits run
   * the `before`/`after('send')` hooks (payload `edit: ref`); a hook abort resolves `skipped`.
   */
  edit(content: string | OutboundContent, opts?: EditOptions): Promise<EditResult>
  edit(ref: MessageRef, content: string | OutboundContent, opts?: EditOptions): Promise<EditResult>
  /** How the current provider supports a messaging feature (`native` / `degraded` / `unsupported`). */
  supports(feature: MessagingFeature): MessagingSupport
  /**
   * Show "typing…" for about `msPerChar` ms per character (40 by default, capped at 5 s),
   * then send `text`. Ignores `BotConfig.typing`.
   *
   * @deprecated Use `ctx.reply(text, { typing: true })` (or a {@link TypingConfig} object
   * such as `{ typing: { charsPerSecond: 25, maxMs: 5000 } }`): it shares the bot-wide
   * typing policy, refreshes the indicator and is dropped on stop/handoff like every paced reply.
   */
  replyWithTyping(text: string, msPerChar?: number): Promise<SentMessage>
  /** Escape hatch for transport-native content (templates, components). */
  sendNative(provider: string, payload: unknown): Promise<SentMessage>
  /**
   * Stream a reply that is still being generated (e.g. LLM tokens) to this chat,
   * using the best strategy the provider supports (`capabilities.streaming`):
   * native drafts, throttled edits, or sentence chunks with typing. Long text is
   * split so no message exceeds `capabilities.maxTextLength`. See `StreamOptions`.
   */
  stream(source: StreamSource, opts?: StreamOptions): Promise<StreamResult>
  /**
   * Send a native form (`OutboundContent` kind `'form'`). Only meaningful when
   * `capabilities.forms === 'native'`; other providers reject it with
   * `UnsupportedContentError`. The submission arrives as an inbound message of
   * type `'form'` (see `parseFormReply()`); `flow().form()` handles all of this.
   * Set on contexts built by a Bot.
   */
  form?(definition: FormDefinition, opts?: { token?: string; nativeId?: string }): Promise<SentMessage>
  /**
   * Whether the provider can render `definition` natively right now (see
   * `IProvider.canRenderForm`). Set on contexts built by a Bot whose provider
   * implements it; absent = assume yes when `capabilities.forms === 'native'`.
   */
  canRenderForm?(definition: FormDefinition, opts?: { nativeId?: string }): boolean
  /** Capabilities of the provider this message came from (set on contexts built by a Bot). */
  capabilities?: ProviderCapabilities
  /**
   * Rich-text dialect of THIS chat: the provider's `textFormatFor(chatId)`, else
   * `capabilities.textFormat`. Unset = unknown (send Markdown untouched). Use it,
   * not `capabilities.textFormat`, to format text for the chat (`@bot-wa/ai` does).
   */
  textFormat?: TextFormat

  /* Actions — degrade to no-op when the provider lacks the capability */
  markRead(): Promise<void>
  /** Show the typing indicator. Best-effort: never rejects (a provider failure is logged at debug). */
  typing(): Promise<void>
  /** Show the recording-audio indicator. Best-effort like {@link typing}. */
  recording(): Promise<void>
  delete(): Promise<void>

  /**
   * Hand this chat (`from`) over to a human: the bot stops routing its messages until
   * `bot.resume(chatId)`, and any conversation in the chat is cancelled silently.
   * Resolves `true` if the chat was not already handed off. Safe to call without
   * awaiting (the state flips synchronously). See `bot.handoff()`.
   */
  handoff(opts?: HandoffOptions): Promise<boolean>

  /* Dispatch control (unchanged) */
  pass(): void
  abort(): void
  next?(): Promise<void>

  /**
   * Persistent profile of the sender (`ctx.sender`), shared across chats — see
   * {@link UserData}. `ctx.user.ns('game')` scopes it to a namespace.
   */
  user: UserData

  /**
   * Resolved language of this message (normalized locale code, e.g. `'es'`, `'en'`).
   * Order: `ctx.user` preference → provider-reported language → `i18n.detect` → default.
   */
  lang: string
  /**
   * The bot's default locale (`i18n.defaultLocale`, `'es'` unless configured), whatever
   * {@link lang} resolved to. Plugins that ship their own built-in texts for a few
   * languages use it as the fallback for a `lang` they do not cover.
   */
  readonly defaultLang?: string
  /**
   * Where {@link lang} came from (`'user'` | `'provider'` | `'detector'` | `'default'`);
   * `undefined` while i18n is off (then `lang` is just the default locale). Plugins
   * that want a real language signal (e.g. a speech-to-text hint) should ignore
   * `'default'`. A hook that assigns `ctx.lang` directly does not update it.
   */
  langSource?: LangSource
  /**
   * Translate `key` (dot path) in {@link lang}, interpolating `{param}` placeholders;
   * `params.count` picks plural forms. Missing keys fall back to the default locale,
   * then to the key itself. See `bot.locale()`.
   */
  t(key: string, params?: TranslateParams): string
  /**
   * Switch the sender's language: persists the registered locale serving `code`
   * (`'en-GB'` → `'en'` when only `en` exists) to `ctx.user` (key `'lang'` by default)
   * and updates {@link lang} for this message. Rejects with `TypeError` on an empty code
   * or one no registered locale serves (nothing is stored), with `Error` while i18n is
   * not enabled (no `bot.locale()` call and no `BotConfig.i18n`), and with
   * `UserDataError` when the profile cannot be written.
   */
  setLang(code: string): Promise<void>

  tools: TTools
}

/** Result of an outbound send handed back to `ctx.reply(...)` callers. */
export interface SentMessage<TRaw = unknown> {
  ref: MessageRef
  /** Convenience mirrors of ref (avoids callers destructuring `ref`). */
  id: MessageId
  chatId: ChatId
  raw?: TRaw
  skipped?: boolean
}

/* ============================================================================
 * 11. BUILD-CONTEXT DEPENDENCIES  (core, transport-agnostic)
 * ========================================================================== */

/**
 * What `buildMessageContext` needs. It is now a THIN wrapper: it receives an
 * already-normalized `InboundMessage` (no proto parsing, no identity pass) and
 * a `send` that takes `OutboundContent`. All Baileys-specific normalization has
 * moved into the provider's `toInbound()`.
 */
export interface BuildContextDeps<TRaw = unknown> {
  inbound: InboundMessage<TRaw>
  tools: object
  send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<TRaw>>
  markRead?(ref: MessageRef): Promise<void>
  typing?(chatId: ChatId, state: 'typing' | 'recording' | 'paused'): Promise<void>
  deleteMessage?(ref: MessageRef): Promise<void>
  acknowledgeInteraction?(id: string, text?: string): Promise<void>
  downloadMedia?(ref: MediaRef): Promise<Buffer | NodeJS.ReadableStream>
  /** Backs `ctx.handoff()`; without it `ctx.handoff()` resolves `false`. */
  handoff?(chatId: ChatId, opts?: HandoffOptions): Promise<boolean>
  /** Provider capabilities: `ctx.stream()` picks its strategy from them; exposed as `ctx.capabilities` (drives `flow().form()` rendering). */
  capabilities?: ProviderCapabilities
  /**
   * Backs live edits for `ctx.stream()` (strategy `'edit'`): `before('send')` hooks only (payload
   * `stream: 'edit'`), no `after('send')`. Distinct from {@link editMessage}, which backs `ctx.edit`.
   */
  streamEdit?(ref: MessageRef, content: OutboundContent): Promise<unknown>
  /**
   * Backs the NEW messages `ctx.stream()` sends to its own chat (the first message of
   * an edit stream, sentence chunks, the final message after drafts): the full send
   * path, with `stream: 'message'` on the `before('send')` / `after('send')` payload so
   * hooks can tell streamed output apart (e.g. a text-to-speech hook leaves it as text).
   * Omitted → {@link send}.
   */
  streamSend?(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<TRaw>>
  /** Backs native drafts for `ctx.stream()` (strategy `'draft'`). */
  sendDraft?(chatId: ChatId, draftId: number, text: string, opts?: DraftOptions): Promise<void>
  /** Deletes a message `ctx.stream()` sent (`onCancel: 'discard'`), from the chat and the message log. */
  deleteStreamMessage?(ref: MessageRef): Promise<void>
  /**
   * Aborts when the bot stops: `ctx.stream()` then cancels (combined with the caller's
   * `signal`), so a stream left running by a handler never outlives `bot.stop()`.
   */
  stopSignal?(): AbortSignal | undefined
  /** Set when this context projects an interaction (button/slash/callback). */
  interaction?: { id: string; data: string; respondBy?: number }
  /** Sender profile exposed as `ctx.user`; when omitted every `ctx.user` call rejects with `UserDataError('UNAVAILABLE')`. */
  user?: UserData
  /** Backs `ctx.canRenderForm()` (see `IProvider.canRenderForm`). */
  canRenderForm?(definition: FormDefinition, opts?: { nativeId?: string }): boolean
  /** Per-chat text format (see `IProvider.textFormatFor`); `ctx.textFormat` falls back to `capabilities.textFormat`. */
  textFormatFor?(chatId: ChatId): TextFormat | undefined
  /**
   * Paces text replies (delay + typing indicator) around `send`; omitted → sent immediately.
   * May resolve a `skipped` result instead of sending when the reply is cancelled during the wait.
   */
  pace?(chatId: ChatId, text: string, opts: ReplyOptions | undefined, send: () => Promise<SentMessage>): Promise<SentMessage>
  /**
   * Native edit through the bot's outbound pipeline (`before`/`after('send')` hooks, ledger);
   * resolves `skipped` when a hook blocked it. Omitted → `ctx.edit` degrades to a new send.
   */
  editMessage?(ref: MessageRef, content: OutboundContent): Promise<SendResult<TRaw>>
  /**
   * Clock of sends that did not come from this kind of `ctx` (see `ExternalSendClock`):
   * `ctx.edit(content)` skips its own last reply once another send reached the chat after it.
   * Omitted → the context's own last reply is always the implicit edit target.
   */
  sendClock?: { now(): number; lastExternal(chatId: ChatId): number }
  /** Support level of a messaging feature; omitted → everything is attempted natively. */
  supports?(feature: MessagingFeature): MessagingSupport
  /** Translator backing `ctx.t` / `ctx.setLang`; when omitted the built-in `es`/`en` core messages are used. */
  i18n?: ContextI18n
}

/** What `buildMessageContext` needs to localize a context (implemented by the Bot's `I18n`). */
export interface ContextI18n {
  /** Initial `ctx.lang` (the bot re-resolves it inside the per-chat queue). */
  readonly defaultLocale: string
  /** `ctx.user` key `ctx.setLang()` writes. */
  readonly userKey: string
  /** Whether per-message language resolution is on; `ctx.setLang()` refuses otherwise. */
  readonly enabled: boolean
  /** The registered locale serving `code` (itself or its base language), else `undefined`. */
  supported(code: unknown): string | undefined
  translate(lang: string | undefined, key: string, params?: TranslateParams): string
}

/* ============================================================================
 * 12. STORE  (generic normalized shapes — no Baileys imports)
 * ========================================================================== */

export interface StoredMessage {
  ref: MessageRef
  chatId: ChatId
  senderId?: UserId
  tenantId?: string
  environmentId?: string
  botId?: string
  providerId?: string
  connectionId?: string
  timestamp: number
  type: MessageType | OutboundContent['kind']
  body?: string
  fromMe?: boolean
  direction?: 'inbound' | 'outbound'
  status?: 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
  error?: { code?: string | number; message?: string }
  quoted?: MessageRef
  /** Normalized shared location of an inbound `location` message (see {@link InboundMessage.location}). */
  location?: InboundLocation
  raw?: unknown
}

/** One turn of AI conversation history (consumed by @bot-wa/ai). Transport-neutral. */
export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
}
export interface StoredChat {
  id: ChatId
  tenantId?: string
  environmentId?: string
  botId?: string
  providerId?: string
  connectionId?: string
  kind?: ChatKind
  name?: string
  lastMessageAt?: number
  updatedAt?: number
  raw?: unknown
  /**
   * Human-handoff state; `null` once resumed. Written by the Bot; `bot.start()` restores
   * the chats listed in the bot's handoff index (`HANDOFF_INDEX_KEY` store cursor).
   */
  handoff?: StoredHandoff | null
}
export interface StoredContact {
  id: UserId
  tenantId?: string
  environmentId?: string
  botId?: string
  providerId?: string
  connectionId?: string
  name?: string
  username?: string
  phoneNumber?: string
  updatedAt?: number
  raw?: unknown
}

export interface FlowCheckpoint {
  flowId: string
  step: number
  state: Record<string, unknown>
  updatedAt: number
  /**
   * Durability (`BotConfig.durability`): id of the inbound journal record whose message the
   * checkpointed step consumed. A replay of that record after a crash is acknowledged without
   * being dispatched again. Stores persist it opaquely with the rest of the checkpoint.
   */
  inboundId?: string
  /**
   * Durability: the causation (inbound record id + send sequence) the next step's sends
   * continue from. A step re-run on replay re-derives the same outbox keys, so a prompt
   * that already went out is not sent twice.
   */
  cause?: { id: string; seq: number }
}

/**
 * One persisted per-user profile entry — the storage unit behind `ctx.user`.
 *
 * The atomic unit is a TOP-LEVEL key inside a namespace: `ctx.user.set('address.city', …)`
 * reads and rewrites the whole `address` entry, while two different top-level
 * keys never touch each other. `value` is JSON-compatible data (stores persist
 * it as JSON and hand back a fresh copy on every read). `userId`, `namespace`
 * and `key` are compared as EXACT strings: case, accents and leading or
 * trailing whitespace all make a different entry.
 */
export interface UserDataEntry {
  /** Canonical subject id (the provider-resolved `senderId`). Opaque. */
  userId: UserId
  /** Namespace that groups keys (`'default'` for `ctx.user`). */
  namespace: string
  /** Top-level key inside the namespace (first segment of a dot path). */
  key: string
  /** JSON-compatible value. */
  value: unknown
  /**
   * Epoch ms after which the entry counts as absent. `undefined` = never
   * expires. Always a safe integer when written by `ctx.user` (BIGINT columns
   * and Redis `PX` reject fractions).
   */
  expiresAt?: number
  /** Epoch ms of the last write (integer). */
  updatedAt: number
}

export interface IStore {
  saveMessage(msg: StoredMessage): Promise<void>
  getMessage(ref: MessageRef): Promise<StoredMessage | undefined>
  getMessagesByChat(chatId: ChatId, limit?: number): Promise<StoredMessage[]>
  deleteMessage(ref: MessageRef): Promise<void>

  /**
   * Shallow-merge `chat` onto the stored record. An own field set to `undefined` UNSETS
   * that field, so a partial upsert must omit what it does not know (the Bot does).
   */
  upsertChat(chat: StoredChat): Promise<void>
  getChat(chatId: ChatId): Promise<StoredChat | undefined>
  listChats(): Promise<StoredChat[]>
  deleteChat(chatId: ChatId): Promise<void>

  /** Shallow-merge `contact` onto the stored record; same `undefined` = unset rule as {@link upsertChat}. */
  upsertContact(contact: StoredContact): Promise<void>
  getContact(userId: UserId): Promise<StoredContact | undefined>
  listContacts(): Promise<StoredContact[]>
  deleteContact(userId: UserId): Promise<void>

  /** Delivery cursor for long-poll/webhook transports (Telegram update_id). */
  getCursor?(key: string): Promise<string | undefined>
  setCursor?(key: string, value: string): Promise<void>

  /* AI conversation history (@bot-wa/ai) — transport-neutral. */
  getConversation(key: string): Promise<AIMessage[] | undefined>
  setConversation(key: string, messages: AIMessage[]): Promise<void>
  clearConversation(key: string): Promise<void>

  getCheckpoint(key: string): Promise<FlowCheckpoint | undefined>
  setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void>
  clearCheckpoint(key: string): Promise<void>
  listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>>

  /* Per-user profile data (`ctx.user`) — see {@link UserDataEntry}.
   * Optional so custom stores keep compiling; a store supports `ctx.user`
   * only when it implements get/set/delete/list (purge is optional). All six
   * built-in stores implement the full set and pass the shared
   * `test-utils/user-data-conformance.ts` suite. */

  /**
   * Read one entry. MUST return `undefined` when the entry is missing OR its
   * `expiresAt` is `<= Date.now()` (lazy expiry — expired rows may still exist
   * physically until purged).
   */
  getUserData?(userId: UserId, namespace: string, key: string): Promise<UserDataEntry | undefined>
  /**
   * Upsert one entry as a SINGLE atomic write that replaces both `value` and
   * `expiresAt` (no read-modify-write inside the store). An entry whose
   * `expiresAt` is already in the past may be dropped instead of written.
   */
  setUserData?(entry: UserDataEntry): Promise<void>
  /**
   * Delete one key (`namespace` + `key`), one whole namespace (`key` omitted)
   * or every namespace of the user (`namespace` omitted; `key` is then ignored).
   * Deleting missing data is a no-op.
   */
  deleteUserData?(userId: UserId, namespace?: string, key?: string): Promise<void>
  /** Live (non-expired) entries of a user — all namespaces, or just `namespace`. Order unspecified. */
  listUserData?(userId: UserId, namespace?: string): Promise<UserDataEntry[]>
  /**
   * Physically remove entries whose `expiresAt <= now` (default `Date.now()`)
   * across the whole store; resolves with how many were removed. Stores with
   * native expiry (Redis) resolve `0`.
   */
  purgeExpiredUserData?(now?: number): Promise<number>

  start(): Promise<void>
  stop(): Promise<void>
}

/** Escape one key part: `%` -> `%25`, `:` -> `%3A` (injective; identity for the common case). */
function escapeKeyPart(part: string): string {
  return part.replace(/%/g, '%25').replace(/:/g, '%3A')
}

/**
 * Unambiguous storage key for a message: `<chatId>:<id>` with `%` and `:`
 * percent-escaped in each part, so the single raw `:` always separates the
 * two. Ids without `:` or `%` (WhatsApp JIDs, Telegram/Discord numbers…) get
 * the exact same key as before; ids that do contain them (Twilio's
 * `whatsapp:+1555…` chat ids) no longer collide — the former plain
 * `${chatId}:${id}` mapped `('a:b', 'c')` and `('a', 'b:c')` to one key.
 *
 * Persistent stores that wrote keys in the old format read and delete through
 * {@link legacyMessageKey} as a fallback (see the store READMEs).
 */
export function messageKey(ref: MessageRef): string {
  return `${escapeKeyPart(ref.chatId)}:${escapeKeyPart(ref.id)}`
}

/**
 * The pre-escaping message key (`${chatId}:${id}`), ambiguous when either part
 * contains `:`. Only for stores migrating rows written before
 * {@link messageKey} escaped its parts: it differs from `messageKey(ref)`
 * exactly when a part contains `:` or `%`, and a row found under it must be
 * checked to belong to `ref` (same chat id and message id) before use.
 */
export function legacyMessageKey(ref: MessageRef): string {
  return `${ref.chatId}:${ref.id}`
}

/* ============================================================================
 * 13. BOT CONFIG  (transport-agnostic top level; provider config injected)
 * ========================================================================== */

export interface LoggerLike {
  debug(...a: unknown[]): void
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
  error(...a: unknown[]): void
  child?(bindings: Record<string, unknown>): LoggerLike
}

export type StoreKind = 'memory' | 'sqlite' | 'redis' | 'postgres' | 'mongo' | 'custom'

/**
 * ONLY transport-agnostic fields. All WhatsApp session/auth fields (qr,
 * pairingCode, sessionsDir, browser, markOnlineOnConnect, syncFullHistory,
 * ignoreNewsletters, ignoreBroadcasts) move into @bot-wa/baileys'
 * `BaileysProviderConfig`, consumed when you construct the provider you inject
 * here. The provider is now the transport boundary — you build it, then pass it.
 */
export interface BotConfig {
  session?: string
  /** Storage and control-plane namespace. Defaults to `local`. */
  tenantId?: string
  /** Deployment environment namespace. Defaults to `default`. */
  environmentId?: string
  /** Stable bot namespace. Defaults to `session` or the provider id. */
  botId?: string
  /** Stable provider-account/connection namespace. Defaults to `session` or `default`. */
  connectionId?: string
  /** Persist provider-native payloads. Disabled by default to minimize PII. */
  persistRaw?: boolean
  /**
   * Inbound idempotency: a redelivered message/interaction (webhook retry,
   * reconnect replay) never runs handlers twice. Keyed by `chatId` + `ref.id`
   * (interactions: `interactionId`), bounded LRU with optional TTL. Enabled by
   * default (`{ size: 1000 }`); `false` disables it. Relies on the providers'
   * INBOUND ID CONTRACT (see `IProvider`). Runs after the access lists: a
   * blocked delivery is never recorded, so a redelivery after un-blocking is
   * processed. See `InboundDeduper`.
   */
  dedupe?: InboundDedupeOptions | false
  /* --- durable message processing (opt-in) --------------------------------- */
  /**
   * Durable message processing: journal every admitted inbound event before dispatch
   * (replayed after a crash) and every send in an outbox with idempotency keys, retries,
   * backoff and a dead-letter queue. Omitted = off (in-memory, exactly as before);
   * `{}` = on with the in-memory backend. See `DurabilityConfig` and the operations guide.
   */
  durability?: DurabilityConfig
  /* ------------------------------------------------------------------------ */
  store?: StoreKind | IStore
  storeConfig?: Record<string, unknown>
  /** REQUIRED in v2: the constructed transport provider (BaileysProvider, ...). */
  provider: IProvider
  commandPrefix?: string
  conversationScope?: 'participant' | 'chat'
  conversation?: {
    timeout?: string | number
    timeoutMessage?: string
    retriesMessage?: string
    errorMessage?: string
    cancelledMessage?: string
  }
  groupMode?: 'all' | 'mentions' | 'commands'
  /** Native i18n options (default locale, detector, …). See `bot.locale()`. */
  i18n?: I18nConfig
  /** Human handoff behaviour (escape commands, persistence). See `bot.handoff()`. */
  handoff?: HandoffConfig
  /**
   * Automatic typing indicator before every text reply sent through `ctx`
   * (`reply`/`say`/`answer`/`text`/`quote`, and flow `.say`). `true` enables the
   * defaults (`{ minMs: 800, maxMs: 3000, charsPerSecond: 20 }`). Disabled by default.
   * Ignored (no indicator, no wait) on providers without `capabilities.typing`.
   */
  typing?: boolean | TypingConfig
  /** Pluggable pacing policy; a transport may also own its own limiter. */
  rateLimit?: unknown
  /** Built-in logger at `debug` level. Without it (and without `logger`) the default level is `warn`. */
  debug?: boolean
  logger?: LoggerLike
}
