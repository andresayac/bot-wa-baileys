/**
 * @botmesh/baileys — WhatsApp transport for @botmesh/core (Baileys 7, IProvider v2).
 *
 * @example
 * ```ts
 * import { Bot } from '@botmesh/core'
 * import { BaileysProvider } from '@botmesh/baileys'
 *
 * const bot = new Bot({ provider: new BaileysProvider({ session: 'demo', qr: { terminal: true } }) })
 * await bot.start()
 * ```
 */

export { BaileysProvider } from './BaileysProvider.js'
export type { BaileysProviderConfig, QrConfig } from './BaileysProvider.js'
export { toBaileysLogger, isBaileysLogger } from './logger.js'
export type { BaileysLogger } from './logger.js'
export type { BrowserConfig, BrowserPreset } from './browser.js'
export type { PollStore, StoredPoll, PollOption } from './polls.js'

// Identity + JID helpers (WhatsApp-specific; advanced users)
export { IdentityStore } from './identity.js'
export {
  toJid, sanitizeNumber, normalize as normalizeJid, parseJid, buildJid, shortJid,
  isGroup, isBroadcast, isStatus, isNewsletter, isPn, isLid, sameUser,
  toUserId, toChatId, isValidJid,
} from './jid.js'
export type { JID, JidInput } from './jid.js'

// Anti-ban rate limiter
export { RateLimiter, RateLimiterTimeout } from './RateLimiter.js'
export type { RateLimitConfig, RateLimitBucketConfig, RateLimitJitterConfig } from './RateLimiter.js'

// Media processing (sticker/opus/upload)
export { toMediaUpload, toBuffer as mediaToBuffer, makeSticker, transcodeToOpus, resolveRemoteMedia, REMOTE_MEDIA_MAX_BYTES } from './MediaProcessor.js'
export type { StickerOptions, RemoteMediaConfig, WAMediaUpload } from './MediaProcessor.js'

// Low-level normalizers (advanced)
export { toInbound } from './toInbound.js'
export { toOutbound } from './toOutbound.js'

// reconnect classification (advanced)
export { classifyDisconnect, backoffDelay, MAX_RECONNECT_ATTEMPTS } from './reconnect.js'
export type { DisconnectAction } from './reconnect.js'

// Session path validation (advanced/self-hosted tooling)
export {
  assertSessionDirectorySafe,
  removeSessionDirectory,
  resolveSessionDirectory,
} from './sessionPath.js'
