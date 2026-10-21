import type { ChatId, MessageRef, UserId } from '@botmesh/core'

/** What the plugin can do to an offender. */
export type ModerationAction = 'warn' | 'mute' | 'kick' | 'delete'
/** One action or several, run in order (e.g. `['delete', 'warn']`). */
export type ActionSpec = ModerationAction | readonly ModerationAction[]
/** Which rule fired. */
export type ModerationRule = 'antiSpam' | 'wordFilter' | 'linkFilter'

/** Anti-spam: more than `maxMessages` messages within `windowMs` is a violation. */
export interface AntiSpamRule {
  maxMessages: number
  windowMs: number
  /** Default `'warn'`. */
  action?: ActionSpec
}

/** Banned words (case/diacritic-insensitive) or RegExps. */
export interface WordFilterRule {
  banned: ReadonlyArray<string | RegExp>
  /** Default `'delete'`. */
  action?: ActionSpec
  /** Strings match only as whole words (default `true`). */
  wholeWord?: boolean
}

/** Link filtering. By default only FOREIGN group invite links are violations. */
export interface LinkFilterRule {
  /** Default `['delete', 'warn']`. */
  action?: ActionSpec
  /** Flag group invite links (WhatsApp/Telegram/Discord). Default `true`. */
  groupInvites?: boolean
  /** Flag every link, not only invites. Default `false`. */
  allLinks?: boolean
  /**
   * Invite codes (or full invite links) that are allowed, e.g. your own groups.
   * Matched by exact code: a link entry is reduced to its code, so it matches
   * with or without scheme, and a URL that merely contains the code is not allowed.
   */
  allowInvites?: readonly string[]
  /** Domains allowed when `allLinks` is on (subdomains included). */
  allowDomains?: readonly string[]
  /** Extra invite patterns; the first capture group is the code. */
  invitePatterns?: readonly RegExp[]
}

/** Warn-count escalation. */
export interface WarningPolicy {
  /** Warnings before escalating (default `3`). */
  max: number
  /** What happens on the `max`-th warning (default `'kick'`). */
  then: 'mute' | 'kick'
}

/** User-visible texts. `{name}`, `{reason}`, `{count}` and `{max}` are replaced. */
export interface ModerationMessages {
  warn?: string
  reasons?: Partial<Record<ModerationRule, string>>
}

/** The rule set. Every field can be overridden per group via `groups[chatId]`. */
export interface ModerationRules {
  /** Master switch (default `true`). */
  enabled?: boolean
  antiSpam?: AntiSpamRule | false
  wordFilter?: WordFilterRule | false
  linkFilter?: LinkFilterRule | false
  /** Shorthand for `linkFilter: { action: ['delete', 'kick'] }` (FEATURES #34). */
  autoKickOnLink?: boolean
  /** Users exempt from every rule (in addition to provider-reported admins). */
  admins?: readonly UserId[]
  /** Admins skip every rule (default `true`). */
  adminBypass?: boolean
  /** How long `'mute'` ignores a user (default 10 minutes). */
  muteMs?: number
  /** Also delete messages a muted user keeps sending (default `false`). */
  deleteWhileMuted?: boolean
  /** Escalate after N warnings (default `{ max: 3, then: 'kick' }`); `false` disables. */
  warnings?: WarningPolicy | false
  messages?: ModerationMessages
}

/** Optional group-admin namespace a provider MAY expose. Every method is optional. */
export interface GroupAdminApi {
  /** Remove (kick) participants from a group. */
  removeParticipants?(chatId: ChatId, userIds: UserId[]): Promise<unknown>
  /** Current admins of a group (used for admin bypass). */
  getAdmins?(chatId: ChatId): Promise<readonly UserId[]>
}

/**
 * The subset of a provider the plugin feature-detects. Pass your provider
 * instance as `provider`; missing methods degrade to `'unsupported'`.
 */
export interface ModerationProvider {
  /** Transport tag (every `IProvider` has one), used in logs. */
  readonly id?: string
  deleteMessage?(ref: MessageRef): Promise<void>
  groups?: GroupAdminApi
}

/** Outcome of one action. */
export interface ActionResult {
  action: ModerationAction
  /**
   * `done` — executed; `attempted` — sent through `ctx.delete()` without a
   * provider handle, so support could not be verified; `unsupported` — the
   * provider lacks the capability; `failed` — it threw (see `error`).
   */
  status: 'done' | 'attempted' | 'unsupported' | 'failed'
  /** Set when this action replaced an unsupported one (kick → mute). */
  fallbackFor?: ModerationAction
  error?: unknown
}

/** Emitted (as the `'moderation'` bot event and to `onViolation`) for every violation. */
export interface ModerationReport {
  chatId: ChatId
  senderId: UserId
  rule: ModerationRule
  /** Human-readable cause: the banned term, the link, `'6 msgs / 10000ms'`… */
  detail: string
  ref: MessageRef
  results: ActionResult[]
  /** Warnings the sender has in this chat after this violation. */
  warnings: number
}

/** Plugin config: global rules + per-group overrides + wiring. */
export interface ModerationConfig extends ModerationRules {
  /** Per-group overrides, shallow-merged over the global rules; `false` disables moderation there. */
  groups?: Record<ChatId, ModerationRules | false>
  /** Moderate only groups (default) or every chat. */
  applyTo?: 'groups' | 'all'
  /** Provider handle for delete/kick/admin lookups. */
  provider?: ModerationProvider
  /** Extra admin check (e.g. your own staff list in a DB). */
  isAdmin?: (chatId: ChatId, userId: UserId) => boolean | Promise<boolean>
  /** How long provider admin lists are cached (default 5 minutes). */
  adminCacheMs?: number
  /** When `'kick'` is unsupported, fall back to `'mute'` (default) or do nothing. */
  kickFallback?: 'mute' | 'none'
  /** Before-hook priority (default `100`, so moderation runs before other hooks). */
  priority?: number
  /** Called for every violation, after the actions ran. Errors are logged. */
  onViolation?: (report: ModerationReport) => void | Promise<void>
  /** Clock override (tests). */
  now?: () => number
}

/** `ctx.tools.moderation` — runtime control over the plugin's state. */
export interface ModerationController {
  mute(chatId: ChatId, userId: UserId, ms?: number): void
  unmute(chatId: ChatId, userId: UserId): boolean
  isMuted(chatId: ChatId, userId: UserId): boolean
  warnings(chatId: ChatId, userId: UserId): number
  resetWarnings(chatId: ChatId, userId?: UserId): void
  /** Kick through the provider; reports `'unsupported'` when it cannot. */
  kick(chatId: ChatId, userId: UserId): Promise<ActionResult>
  /** Replace (or with `undefined`, remove) a group's override at runtime. */
  setGroupRules(chatId: ChatId, rules: ModerationRules | false | undefined): void
  /** Forget the cached admin list of a group (or of every group). */
  invalidateAdmins(chatId?: ChatId): void
}
