/**
 * @bot-wa/moderation — group moderation plugin for `@bot-wa/core`.
 *
 * - {@link moderationPlugin} — anti-spam windows, word/regex filters, foreign
 *   invite-link filtering and warn/mute/kick/delete actions, with per-group
 *   config and admin bypass. Provider capabilities (delete, group admin) are
 *   optional: unsupported actions degrade and are reported.
 * - {@link Moderator} — the engine, usable without a Bot.
 */

import type { ModerationController } from './types.js'

export { moderationPlugin } from './plugin.js'
export { Moderator, DEFAULT_MUTE_MS, DEFAULT_ADMIN_CACHE_MS } from './Moderator.js'
export type { ModeratorLogger, WarnSender, Verdict } from './Moderator.js'
export { findInviteLinks, findLinks } from './links.js'
export type { InviteLink } from './links.js'
export { compileTerms, foldText } from './words.js'
export type { CompiledTerm } from './words.js'
export type {
  ActionResult,
  ActionSpec,
  AntiSpamRule,
  GroupAdminApi,
  LinkFilterRule,
  ModerationAction,
  ModerationConfig,
  ModerationController,
  ModerationMessages,
  ModerationProvider,
  ModerationReport,
  ModerationRule,
  ModerationRules,
  WarningPolicy,
  WordFilterRule,
} from './types.js'

/**
 * Augment `@bot-wa/core` so `ctx.tools.moderation` is typed once
 * `moderationPlugin` is installed.
 */
declare module '@bot-wa/core' {
  interface DefaultTools {
    /** Present when `moderationPlugin` is plugged into the Bot. */
    moderation?: ModerationController
  }
}
