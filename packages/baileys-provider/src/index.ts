/**
 * @bot-wa/baileys — WhatsApp transport for @bot-wa/core (Baileys 7, IProvider v2).
 *
 * @example
 * ```ts
 * import { Bot } from '@bot-wa/core'
 * import { BaileysProvider } from '@bot-wa/baileys'
 *
 * const bot = new Bot({ provider: new BaileysProvider({ session: 'demo', qr: { terminal: true } }) })
 * await bot.start()
 * ```
 */

export { BaileysProvider } from './BaileysProvider.js'
export type { BaileysProviderConfig, QrConfig } from './BaileysProvider.js'
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
export { toMediaUpload, toBuffer as mediaToBuffer, makeSticker, transcodeToOpus } from './MediaProcessor.js'
export type { StickerOptions } from './MediaProcessor.js'

// Low-level normalizers (advanced)
export { toInbound } from './toInbound.js'
export { toOutbound } from './toOutbound.js'

// reconnect classification (advanced)
export { classifyDisconnect, backoffDelay, MAX_RECONNECT_ATTEMPTS } from './reconnect.js'

// Session path validation (advanced/self-hosted tooling)
export {
  assertSessionDirectorySafe,
  removeSessionDirectory,
  resolveSessionDirectory,
} from './sessionPath.js'
