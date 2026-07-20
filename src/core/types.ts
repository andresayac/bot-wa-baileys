/**
 * @bot-wa/bot-wa-baileys — Public Types
 * =====================================
 *
 * Naming philosophy:
 *  - `when()` is universal (tod88 understands "when X happens, do Y").
 *  - Short names, fluent API, progressive disclosure.
 *  - No external framework copied verbatim — own identity.
 */

import type { Logger } from 'pino'
import type { proto, WAMessageKey, WAMessage } from '@whiskeysockets/baileys'
import type { RuntimeMessage } from '../conversations/ConversationRuntime.js'

export type { WAMessageKey, WAMessage }

/* ============================================================================
 * PROVIDER CONTRACT (IProvider)
 * ========================================================================== */

/** Outgoing message payload sent via provider. */
export interface OutgoingMessage {
  jid: string
  content: Record<string, unknown>
  options?: Record<string, unknown>
}

/** Provider interface — unified contract for Baileys, Mock, or custom providers. */
export interface IProvider {
  start(): Promise<void>
  stop(): Promise<void>
  send(jid: string, content: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null } }>
  onTyped(event: string, listener: (payload: any) => void): unknown
  offTyped(event: string, listener: (payload: any) => void): unknown
  downloadMedia?(message: unknown): Promise<Buffer | NodeJS.ReadableStream>
  readMessages?(keys: unknown[]): Promise<void>
  readonly socket: unknown | null
}

/* ============================================================================
 * PRIMITIVES & JIDS
 * ========================================================================== */

/** WhatsApp JID — `number@s.whatsapp.net`, `id@g.us`, `status@broadcast`, ... */
export type JID = string

/** A chat identifier (normalized, device-stripped). */
export type ChatId = JID

/** A user identifier (LID or PN form). */
export type UserId = JID

/** Anything that can be turned into a JID: full JID, plain number, or `{ groupId, userId }`. */
export type JidInput = string | number | { groupId: string; userId?: string }

/* ============================================================================
 * MEDIA
 * ========================================================================== */

/** A media source acceptable by senders. */
export type MediaSource =
  | string                  // URL or local path
  | Buffer                  // raw bytes
  | { url: string }         // explicit URL
  | { buffer: Buffer }      // explicit buffer
  | { path: string }        // explicit path
  | { stream: NodeJS.ReadableStream }  // streaming upload

/** Media options attached to outbound media messages. */
export interface MediaOptions {
  caption?: string
  filename?: string
  mimetype?: string
  viewOnce?: boolean
  gifPlayback?: boolean
  ptv?: boolean            // video circular
  width?: number
  height?: number
  duration?: number        // for audio/video (seconds)
  /** Sticker-only */
  pack?: string
  author?: string
}

/* ============================================================================
 * MESSAGE CONTEXT (inbound)
 * ========================================================================== */

/** Detected message type after normalization. */
export type MessageType =
  | 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document'
  | 'sticker' | 'location' | 'contact' | 'poll' | 'buttons' | 'list'
  | 'unknown'

/** Sender information extracted from an inbound message. */
export interface SenderInfo {
  id: UserId
  name?: string
  pushName?: string
  isBusiness?: boolean
  isBot?: boolean
}

/** Chat information extracted from an inbound message. */
export interface ChatInfo {
  id: ChatId
  name?: string
  isGroup: boolean
  isBroadcast: boolean
  participants?: UserId[]
}

/** Incoming media payload when a message has attachments. */
export interface MediaPayload {
  buffer: Buffer
  mimetype: string
  filename?: string
  size?: number
}

/**
 * Inbound MessageContext — given to every handler.
 * Provides reply helpers, route info, and injected tools.
 *
 * @example
 * ```ts
 * bot.when('hola', async (ctx) => {
 *   await ctx.reply(`👋 hi ${ctx.sender.pushName ?? ctx.from}`)
 *   console.log(ctx.type, ctx.isGroup, ctx.mentions)
 * })
 * ```
 */
export interface MessageContext<TTools extends object = DefaultTools> {
  /* Raw data ------------------------------------------------------------- */
  body: string
  from: ChatId
  sender: SenderInfo
  chat: ChatInfo
  type: MessageType
  isGroup: boolean
  isPrivate: boolean
  isFromMe: boolean
  mentions: UserId[]
  quoted?: { body: string; from: ChatId; sender?: UserId }
  media?: MediaPayload
  rawMessage: proto.IWebMessageInfo
  key: WAMessageKey
  timestamp: number

  /* Reply helpers — every reply targets `this.from` --------------------- */
  say(text: string): Promise<SentMessage>
  reply(text: string): Promise<SentMessage>               // alias of say
  answer(text: string): Promise<SentMessage>              // alias
  text(t: string): Promise<SentMessage>
  photo(source: MediaSource, caption?: string): Promise<SentMessage>
  video(source: MediaSource, caption?: string, opts?: MediaOptions): Promise<SentMessage>
  audio(source: MediaSource): Promise<SentMessage>
  voice(source: MediaSource): Promise<SentMessage>
  file(source: MediaSource, filename?: string, caption?: string): Promise<SentMessage>
  sticker(source: MediaSource, opts?: Pick<MediaOptions, 'pack' | 'author'>): Promise<SentMessage>
  location(lat: number, lng: number, name?: string): Promise<SentMessage>
  contact(phone: string, displayName?: string): Promise<SentMessage>
  poll(question: string, options: string[], multiSelect?: boolean): Promise<SentMessage>
  react(emoji: string): Promise<SentMessage>
  quote(text: string): Promise<SentMessage>
  replyWithTyping(text: string, msPerChar?: number): Promise<SentMessage>
  markRead(): Promise<void>
  typing(): Promise<void>
  recording(): Promise<void>
  delete(): Promise<void>

  /* Hooks/flow control -------------------------------------------------- */
  /** Abort the event pipeline (skip subsequent handlers, skip flow matching). */
  abort(): void
  /** In `before` hooks: pass control to the next middleware. */
  next?(): Promise<void>

  /* Injected tools (DI) — populated by plug() calls -------------- */
  tools: TTools
}

/* ============================================================================
 * OUTBOUND — RESULT OF SENDING
 * ========================================================================== */

export interface SentMessage {
  jid: ChatId
  messageId: string
  key: WAMessageKey
  raw: WAMessage
}

/* ============================================================================
 * TOOL INJECTION (Dependency Injection)
 * ========================================================================== */

/** Default tool registry — empty unless plugins add to it. */
export interface DefaultTools {}

/* ============================================================================
 * HOOKS & MIDDLEWARES
 * ========================================================================== */

export type HookEvent =
  | 'message'
  | 'send'
  | 'connection'
  | 'group'
  | 'call'
  | 'presence'
  | 'reaction'
  | 'poll'
  | string                // allow plugins to declare custom events

export type HookPhase = 'before' | 'after' | 'error'

export type HookHandler<TCtx = any> = (
  ctx: TCtx,
  next: () => Promise<void>
) => void | Promise<void>

export interface HookRegistration {
  event: HookEvent
  phase: HookPhase
  handler: HookHandler
  priority: number        // higher = runs first; default 0
}

/* ============================================================================
 * PLUGINS
 * ========================================================================== */

export interface PluginContext<TTools extends object = DefaultTools> {
  bot: any                // forward ref to Bot — typed at use site
  logger: Logger
  tools: TTools
  config: Record<string, unknown>
}
/**
 * Plugin spec — the shape returned by {@link definePlugin}.
 *
 * @example
 * ```ts
 * const myPlugin: PluginSpec = {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   install(ctx, config) { /* wire hooks *\/ },
 * }
 * ```
 */export interface PluginSpec<TConfig = Record<string, unknown>> {
  /** Unique plugin name. */
  name: string
  /** Semver version. */
  version: string
  /** Human-readable description. */
  description?: string
  /** Plugins this depends on (names). */
  requires?: string[]
  /** Install hook — wire up your hooks/tools/flows here. */
  install(ctx: PluginContext, config?: TConfig): void | Promise<void>
  /** Optional cleanup. */
  uninstall?(ctx: PluginContext): void | Promise<void>
}

/** A plugin is just a PluginSpec or a factory returning one. */
export type Plugin<TConfig = Record<string, unknown>> =
  | PluginSpec<TConfig>
  | ((config?: TConfig) => PluginSpec<TConfig>)

/* ============================================================================
 * FLOWS (DSL v2)
 * ========================================================================== */

/** Anything that matches message text: string, regex, array of either. */
export type KeywordMatcher = string | RegExp | (string | RegExp)[]

export type FlowMatcher = 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'regex'

export interface FlowMatchOptions {
  /** Matching strategy. Default 'contains' for strings, 'regex' for RegExp. */
  matcher?: FlowMatcher
  /** Case-sensitive match. Default false. */
  caseSensitive?: boolean
  /** Only match in groups / only in private chats. Default: both. */
  scope?: 'group' | 'private' | 'both'
  /** Only respond to specific senders. */
  from?: UserId[]
}

export interface FlowStepOptions {
  /** Capture next user message and feed it to action state. */
  capture?: boolean
  /** Validate captured body. Return string error or throw. */
  validate?: (body: string) => true | string | Promise<true | string>
  /** Delay (ms) before sending this answer for human-like pacing. */
  delay?: number
  /** Show typing indicator before sending. Default true when delay > 0. */
  typing?: boolean
  /** Sub-flow to redirect to. */
  goto?: Flow
}

export interface FlowTools {
  /** Per-user state. Auto-cleaned when flow ends (unless persistent). */
  state: FlowState
  /** Send arbitrary text/media to current user. */
  say(message: string | MediaSource): Promise<void>
  /** Jump to another flow. */
  goto(flow: Flow): void
  /** End flow explicitly. */
  end(): void
  /** Reset current flow from start. */
  reset(): void
}

export interface FlowState {
  get<T = unknown>(key: string): T | undefined
  set<T = unknown>(key: string, value: T): void
  has(key: string): boolean
  delete(key: string): void
  clear(): void
  all(): Record<string, unknown>
}

export type FlowAction = (
  ctx: MessageContext,
  tools: FlowTools
) => void | Promise<void> | string | Promise<string>

export interface FlowStep {
  kind: 'answer' | 'action' | 'choose' | 'branch'
  answers?: (string | { media: MediaSource; caption?: string } | ((ctx: any, tools: any) => Promise<string> | string))[]
  options?: FlowStepOptions
  action?: FlowAction
  /** For choose/branch steps. */
  branches?: Array<{ when: KeywordMatcher; then: Flow | FlowAction; opts?: FlowMatchOptions }>
  defaultBranch?: FlowAction
}

export interface FlowOptions {
  /** Timeout (ms) for user response; auto-exits with message when hit. */
  timeoutMs?: number
  /** Message sent when timeout fires. */
  timeoutMessage?: string
  /** Fallback action for off-topic responses during the flow. */
  fallback?: FlowAction
  /** Survive process restart (requires persistent store). */
  persistent?: boolean
  /** Max retries when validate fails. */
  maxRetries?: number
}

/** A flow built via the DSL. */
export interface Flow {
  readonly id: string
  readonly keyword: KeywordMatcher
  readonly steps: readonly FlowStep[]
  readonly options: Required<Pick<FlowOptions, 'timeoutMs' | 'maxRetries'>> & FlowOptions
  /** Test whether a message text triggers this flow. */
  test(body: string, ctx?: Pick<MessageContext, 'from' | 'isGroup'>): boolean
}

/* ============================================================================
 * BOT CONFIGURATION
 * ========================================================================== */

export type StoreKind = 'memory' | 'sqlite' | 'redis' | 'postgres' | 'mongo' | 'custom'

export interface QrConfig {
  /** Render QR in terminal. Default true. */
  terminal?: boolean
  /** Save QR to file `{session}.qr.png`. Default false. */
  file?: boolean
  /** Custom QR handler — receives raw QR string. */
  handler?: (qr: string) => void | Promise<void>
  /** Small QR in terminal. Default true. */
  small?: boolean
}

/**
 * Bot configuration passed to `new Bot(config)`.
 *
 * @example
 * ```ts
 * const bot = new Bot({
 *   session: 'demo-bot',
 *   sessionsDir: './sessions',
 *   qr: { terminal: true, small: true },
 *   markOnlineOnConnect: false,
 *   ignoreNewsletters: true,
 *   ignoreBroadcasts: true,
 *   // pairingCode: '+57300XXXXXXX',  // alternative to QR
 * })
 * ```
 */
export interface BotConfig {
  /** Session name. Default 'default'. */
  session?: string
  /** Where to store session credentials. Default './sessions'. */
  sessionsDir?: string
  /** Store kind for chats/messages/contacts. Default 'memory'. */
  store?: StoreKind | object
  /** Store-specific config (e.g. { file: './bot.db' } for sqlite). */
  storeConfig?: Record<string, unknown>
  /** QR rendering options. */
  qr?: QrConfig
  /** Phone number for pairing code login (no QR scan needed). */
  pairingCode?: string
  /** Auto reconnect on disconnect. Default true. */
  reconnect?: boolean
  /** Mark bot as offline on connect — phone keeps getting push notifications. Default true. */
  markOnlineOnConnect?: boolean
  /** Browser identity preset. Default 'macOS'. */
  browser?: 'macOS' | 'ubuntu' | 'windows' | 'appropriate' | [string, string, string]
  /** Request full chat history on first connect. Default false. */
  syncFullHistory?: boolean
  /** Verbose logging. */
  debug?: boolean
  /** Custom logger (pino-compatible). */
  logger?: Logger
  /** Filter out newsletters / broadcasts automatically. Default both true. */
  ignoreNewsletters?: boolean
  ignoreBroadcasts?: boolean
}

/* ============================================================================
 * CONNECTION STATE
 * ========================================================================== */

export type ConnectionState =
  | 'connecting'
  | 'open'
  | 'close'
  | 'qr'
  | 'disconnected'

export interface ConnectionUpdate {
  state: ConnectionState
  qr?: string
  isNewLogin?: boolean
  isOnline?: boolean
  lastDisconnect?: { statusCode?: number; reason?: string }
}

/* ============================================================================
 * SUB-API NAMESPACE TYPES (forward refs, detailed in api/*.ts)
 * ========================================================================== */

export interface GroupsAPI {
  create(name: string, participants: UserId[]): Promise<{ id: string }>
  metadata(groupId: ChatId): Promise<any>
  members(groupId: ChatId): Promise<UserId[]>
  admins(groupId: ChatId): Promise<UserId[]>
  addMember(groupId: ChatId, userId: UserId | UserId[]): Promise<void>
  removeMember(groupId: ChatId, userId: UserId | UserId[]): Promise<void>
  promote(groupId: ChatId, userId: UserId | UserId[]): Promise<void>
  demote(groupId: ChatId, userId: UserId | UserId[]): Promise<void>
  leave(groupId: ChatId): Promise<void>
  setName(groupId: ChatId, name: string): Promise<void>
  setDescription(groupId: ChatId, desc: string): Promise<void>
  setSetting(groupId: ChatId, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'): Promise<void>
  inviteLink(groupId: ChatId): Promise<string>
  revokeInviteLink(groupId: ChatId): Promise<string>
  join(inviteCode: string): Promise<string>
  infoFromInvite(inviteCode: string): Promise<any>
  listAll(): Promise<Record<string, any>>
  setEphemeral(groupId: ChatId, seconds: 0 | 86400 | 604800 | 7776000): Promise<void>
  setMemberAddMode(groupId: ChatId, mode: 'all_member_add' | 'admin_add'): Promise<void>
  listJoinRequests(groupId: ChatId): Promise<any[]>
  resolveJoinRequests(groupId: ChatId, userIds: UserId[], action: 'approve' | 'reject'): Promise<any>
}

export interface ProfileAPI {
  setName(name: string): Promise<void>
  setStatus(text: string): Promise<void>
  setPhoto(source: MediaSource): Promise<void>
  removePhoto(): Promise<void>
  getPhoto(userId: UserId, highRes?: boolean): Promise<string | null>
  getStatus(userId: UserId): Promise<string>
  getBusiness(userId: UserId): Promise<any>
  getMe(): { id: UserId; name?: string; pushName?: string }
}

export interface PrivacyAPI {
  block(userId: UserId): Promise<void>
  unblock(userId: UserId): Promise<void>
  listBlocked(): Promise<UserId[]>
  setLastSeen(visibility: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<void>
  setOnline(visibility: 'all' | 'match_last_seen'): Promise<void>
  setProfilePicture(visibility: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<void>
  setStatus(visibility: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<void>
  setReadReceipts(visibility: 'all' | 'none'): Promise<void>
  setGroupsAdd(visibility: 'all' | 'contacts' | 'contact_blacklist'): Promise<void>
  setDefaultDisappearing(seconds: 0 | 86400 | 604800 | 7776000): Promise<void>
}

export interface ChatsAPI {
  archive(chatId: ChatId, archive?: boolean): Promise<void>
  mute(chatId: ChatId, ms: number | null): Promise<void>
  pin(chatId: ChatId, pin?: boolean): Promise<void>
  unpin(chatId: ChatId): Promise<void>
  star(messageKeys: WAMessageKey[], star?: boolean): Promise<void>
  delete(chatId: ChatId): Promise<void>
  clear(chatId: ChatId, messageKeys: WAMessageKey[]): Promise<void>
  markRead(chatId: ChatId, messageKeys: WAMessageKey[]): Promise<void>
  list(): Promise<any[]>
}

export interface PresenceAPI {
  update(state: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused', chatId?: ChatId): Promise<void>
  subscribe(chatId: ChatId): Promise<void>
}

/* ============================================================================
 * SCHEDULER
 * ========================================================================== */

export interface ScheduledTask {
  id: string
  readonly cron?: string
  readonly interval?: string | number
  readonly runAt?: Date
  readonly nextRun: Date | null
  readonly isRecurring: boolean
  cancel(): void
}

/* ============================================================================
 * SENT MESSAGE BROADCAST
 * ========================================================================== */

export interface BroadcastResult {
  sent: SentMessage[]
  failed: Array<{ jid: ChatId; error: Error }>
}

/* ============================================================================
 * TRIGGER MATCHING (v2)
 * ========================================================================== */

export type MatchStrategy = 'equals' | 'contains' | 'startsWith' | 'endsWith'
export type TriggerScope = 'dm' | 'group' | 'all'

export interface TriggerObject {
  pattern: string | RegExp | Array<string | RegExp>
  match?: MatchStrategy
  scope?: TriggerScope
}

export type Trigger =
  | string
  | RegExp
  | Array<string | RegExp>
  | TriggerObject
  | ((ctx: { body: string; isGroup: boolean }) => boolean)

/* ============================================================================
 * CONVERSATIONS — CONTROLS (Task 3)
 * ========================================================================== */

/** Options shared by the conversation controls that wait for an inbound message. */
export interface WaitOptions {
  /** Timeout for this wait: ms number or duration string ('30s', '2m', '1h'). */
  timeout?: number | string
  /** Validate the captured body. Return `true` to accept, or an error string to reject and retry. */
  validate?: (body: string, ctx: RuntimeMessage) => true | string | Promise<true | string>
  /** Max invalid attempts before throwing `RetriesExceeded`. Default 3. */
  retries?: number
  /**
   * Message sent on an invalid attempt: overrides `waitMedia`'s wrong-type message,
   * `choose`'s invalid-option re-prompt, and `waitText`/`ask`'s non-text-message reply.
   */
  otherwise?: string
  /** Only resolve the wait for messages matching this predicate. */
  filter?: (ctx: RuntimeMessage) => boolean
}
