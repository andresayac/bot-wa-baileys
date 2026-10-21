/**
 * @botmesh/discord — types for the Discord transport (gateway websocket for
 * inbound events + REST for outbound sends).
 */

import type { SecureFetchOptions } from '@botmesh/http'
import type { LoggerLike } from '@botmesh/core'

/* --- Socket seam (injectable for hermetic tests) ------------------------- */

/**
 * Minimal websocket surface the gateway needs. `ws`' WebSocket satisfies it at
 * runtime; tests inject a fake that never opens a real connection.
 */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  /** Hard drop (no close frame) — used to kill zombie connections. Optional. */
  terminate?(): void
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void
  removeAllListeners?(): void
}

/** Builds a socket for a gateway URL. Default: the `ws` package. */
export type SocketFactory = (url: string) => SocketLike

/* --- Provider config ------------------------------------------------------ */

export interface DiscordProviderConfig {
  /** Bot token (Discord Developer Portal → Bot → Reset Token). */
  token: string
  /**
   * Gateway intents bitmask. Default: Guilds | GuildMessages | MessageContent.
   * Add `GatewayIntents.DirectMessages` to receive DMs.
   */
  intents?: number
  /** Application id — required to send interaction followups via `SendOptions.interactionId`. */
  appId?: string
  /** The bot's own user id (for `fromMe`); auto-detected from gateway READY when omitted. */
  selfId?: string
  /** Gateway base URL. Default 'wss://gateway.discord.gg'. */
  gatewayUrl?: string
  /** REST base URL (without version). Default 'https://discord.com/api'. */
  apiUrl?: string
  /** REST API version. Default 'v10'. */
  apiVersion?: string
  /** Safe-download policy for Discord CDN URLs. */
  mediaDownload?: Omit<SecureFetchOptions, 'fetch'>
  /**
   * Durable inbox (`BotConfig.durability`): hosts whose attachment URLs are journaled so a
   * replayed message can download its media again. A name also allows its subdomains.
   * Default: the Discord CDNs (`DISCORD_MEDIA_HOSTS`). Plain `http:` URLs are only accepted
   * with `mediaDownload.allowHttp`.
   */
  mediaRefHosts?: string[]
  /** Injectable websocket factory — tests pass a fake; production uses `ws`. */
  socketFactory?: SocketFactory
  /** Base delay between gateway reconnects (ms, exponential backoff on top). Default 500. */
  reconnectDelayMs?: number
  /**
   * How many messages the provider remembers the bot's own reaction for
   * (bounded LRU, in memory). Discord removes a reaction by emoji, so this is
   * what makes `ctx.react('')` remove it and a new emoji replace the previous
   * one. Default 1000; `0` keeps every reaction (no replace) and makes removal
   * unsupported.
   */
  reactionMemory?: number
  debug?: boolean
  logger?: LoggerLike
}

/* --- Gateway protocol ------------------------------------------------------ */

export const GatewayOpcode = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  PresenceUpdate: 3,
  VoiceStateUpdate: 4,
  Resume: 6,
  Reconnect: 7,
  RequestGuildMembers: 8,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const

export interface GatewayPayload {
  op: number
  d?: unknown
  /** Sequence number (DISPATCH frames). */
  s?: number | null
  /** Event name (DISPATCH frames). */
  t?: string | null
}

/** Privileged intents must also be toggled in the Developer Portal. */
export const GatewayIntents = {
  Guilds: 1 << 0,
  GuildMembers: 1 << 1,
  GuildModeration: 1 << 2,
  GuildEmojisAndStickers: 1 << 3,
  GuildIntegrations: 1 << 4,
  GuildWebhooks: 1 << 5,
  GuildInvites: 1 << 6,
  GuildVoiceStates: 1 << 7,
  GuildPresences: 1 << 8,
  GuildMessages: 1 << 9,
  GuildMessageReactions: 1 << 10,
  GuildMessageTyping: 1 << 11,
  DirectMessages: 1 << 12,
  DirectMessageReactions: 1 << 13,
  DirectMessageTyping: 1 << 14,
  MessageContent: 1 << 15,
} as const

/** Default: Guilds | GuildMessages | MessageContent (what a text bot needs in servers). */
export const DEFAULT_INTENTS =
  GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.MessageContent

/** Close codes that mean "do not reconnect" (bad credentials / configuration). */
export const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
/** Close codes that invalidate the session (reconnect with a fresh IDENTIFY). */
export const FRESH_SESSION_CODES = new Set([4007, 4009])

/* --- Discord REST / gateway payload shapes (subset we read) --------------- */

export interface DiscordUser {
  id: string
  username?: string
  global_name?: string | null
  bot?: boolean
  discriminator?: string
}

export interface DiscordAttachment {
  id: string
  filename: string
  content_type?: string
  size?: number
  url: string
  proxy_url?: string
}

export interface DiscordMessagePayload {
  id: string
  channel_id: string
  guild_id?: string
  author: DiscordUser
  member?: { nick?: string | null }
  content?: string
  /** ISO 8601 timestamp. */
  timestamp?: string
  mentions?: DiscordUser[]
  attachments?: DiscordAttachment[]
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string }
  referenced_message?: DiscordMessagePayload | null
  webhook_id?: string
}

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ModalSubmit: 4,
  ApplicationCommandAutocomplete: 5,
} as const

export const ComponentType = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  UserSelect: 5,
  RoleSelect: 6,
  MentionableSelect: 7,
  ChannelSelect: 8,
} as const

export interface DiscordInteractionData {
  id?: string
  /** Command name (application commands). */
  name?: string
  type?: number
  custom_id?: string
  component_type?: number
  /** Selected values (select menus). */
  values?: string[]
  options?: Array<{ name?: string; type?: number; value?: unknown }>
}

export interface DiscordInteractionPayload {
  id: string
  application_id?: string
  type: number
  token: string
  channel_id?: string
  /** Partial channel object (newer payloads); `id` mirrors `channel_id`. */
  channel?: { id?: string }
  guild_id?: string
  /** Present in guilds. */
  member?: { user: DiscordUser; nick?: string | null }
  /** Present in DMs. */
  user?: DiscordUser
  data?: DiscordInteractionData
  /** The message a component interaction was triggered from. */
  message?: { id: string }
}

/* --- REST shapes ------------------------------------------------------------ */

export interface DiscordApiErrorBody {
  message?: string
  code?: number
  /** Seconds (float) — present on 429. */
  retry_after?: number
}

export interface DiscordMessageResponse {
  id?: string
  channel_id?: string
}
