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

import type { UserData } from '../user/types.js'

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
 * Opaque, lazy media reference on an inbound event. The bytes are NOT inline;
 * `IProvider.downloadMedia(ref)` retrieves them. This single shape covers:
 *  - Baileys (decrypt + CDN fetch + possible reupload),
 *  - Cloud API / Telegram (resolve id -> short-lived URL -> fetch bytes),
 *  - Discord (plain HTTPS GET).
 */
export interface MediaRef {
  kind: Exclude<MessageType, 'text' | 'poll' | 'buttons' | 'list' | 'unknown'>
  mimetype?: string
  filename?: string
  size?: number
  /** Provider-internal handle (Baileys message, Telegram file_id, Discord url). */
  token: unknown
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
export interface CallEvent {
  id: string
  from: UserId
  status: string
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

export class ProviderError extends Error {}

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
  onEvent(listener: (event: InboundEvent<TRaw>) => void | Promise<void>): () => void

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
  ref: MessageRef
  raw: TRaw
  timestamp: number

  /**
   * Present only when this context projects an interaction (Telegram/Discord).
   * `acknowledge()` is a safe no-op on transports without ack (WhatsApp).
   */
  interaction?: { id: string; data: string; respondBy?: number }
  acknowledge?(text?: string): Promise<void>

  /* Reply helpers — every reply targets `this.from` (unchanged surface) */
  say(text: string): Promise<SentMessage>
  reply(text: string): Promise<SentMessage>
  answer(text: string): Promise<SentMessage>
  text(t: string): Promise<SentMessage>
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
  react(emoji: string): Promise<SentMessage>
  quote(text: string): Promise<SentMessage>
  replyWithTyping(text: string, msPerChar?: number): Promise<SentMessage>
  /** Escape hatch for transport-native content (templates, components). */
  sendNative(provider: string, payload: unknown): Promise<SentMessage>

  /* Actions — degrade to no-op when the provider lacks the capability */
  markRead(): Promise<void>
  typing(): Promise<void>
  recording(): Promise<void>
  delete(): Promise<void>

  /* Dispatch control (unchanged) */
  pass(): void
  abort(): void
  next?(): Promise<void>

  /**
   * Persistent profile of the sender (`ctx.sender`), shared across chats — see
   * {@link UserData}. `ctx.user.ns('game')` scopes it to a namespace.
   */
  user: UserData

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
  /** Set when this context projects an interaction (button/slash/callback). */
  interaction?: { id: string; data: string; respondBy?: number }
  /** Sender profile exposed as `ctx.user`; when omitted every `ctx.user` call rejects with `UserDataError('UNAVAILABLE')`. */
  user?: UserData
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
}

/**
 * One persisted per-user profile entry — the storage unit behind `ctx.user`.
 *
 * The atomic unit is a TOP-LEVEL key inside a namespace: `ctx.user.set('address.city', …)`
 * reads and rewrites the whole `address` entry, while two different top-level
 * keys never touch each other. `value` is JSON-compatible data (stores persist
 * it as JSON and hand back a fresh copy on every read).
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
  /** Epoch ms after which the entry counts as absent. `undefined` = never expires. */
  expiresAt?: number
  /** Epoch ms of the last write. */
  updatedAt: number
}

export interface IStore {
  saveMessage(msg: StoredMessage): Promise<void>
  getMessage(ref: MessageRef): Promise<StoredMessage | undefined>
  getMessagesByChat(chatId: ChatId, limit?: number): Promise<StoredMessage[]>
  deleteMessage(ref: MessageRef): Promise<void>

  upsertChat(chat: StoredChat): Promise<void>
  getChat(chatId: ChatId): Promise<StoredChat | undefined>
  listChats(): Promise<StoredChat[]>
  deleteChat(chatId: ChatId): Promise<void>

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

/** keyFor-compatible message key over the neutral ref. */
export function messageKey(ref: MessageRef): string {
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
  /** Pluggable pacing policy; a transport may also own its own limiter. */
  rateLimit?: unknown
  debug?: boolean
  logger?: LoggerLike
}
