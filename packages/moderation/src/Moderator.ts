/**
 * Moderator — the rule engine behind {@link moderationPlugin}. Holds the
 * per-chat state (rate windows, warnings, mutes, admin cache) and runs the
 * actions. Transport-agnostic: chat and user ids are opaque keys, links are
 * detected in the message TEXT, and every provider capability is optional.
 */

import type { ChatId, MessageContext, UserId } from '@botmesh/core'
import { allowedInviteCodes, findInviteLinks, findLinks, hostMatches, isAllowedInviteLink, linkHost } from './links.js'
import { RateWindow } from './rateWindow.js'
import { compileTerms, firstMatch, type CompiledTerm } from './words.js'
import type {
  ActionResult,
  ActionSpec,
  LinkFilterRule,
  ModerationAction,
  ModerationConfig,
  ModerationController,
  ModerationReport,
  ModerationRule,
  ModerationRules,
  WarningPolicy,
} from './types.js'

/** Minimal logger surface (pino-compatible). */
export interface ModeratorLogger {
  warn(obj: unknown, msg?: string): void
  info?(obj: unknown, msg?: string): void
}

/** Sends the warning text; the plugin wires it to `bot.send` with a mention. */
export type WarnSender = (ctx: MessageContext, text: string) => Promise<unknown>

/** Verdict for one inbound message. */
export type Verdict =
  | { kind: 'allow' }
  | { kind: 'ignore'; reason: 'muted' }
  | { kind: 'violation'; report: ModerationReport }

/** Default `'mute'` duration: 10 minutes. */
export const DEFAULT_MUTE_MS = 10 * 60_000
/** Default TTL of a provider admin list: 5 minutes. */
export const DEFAULT_ADMIN_CACHE_MS = 5 * 60_000
const DEFAULT_WARNINGS: WarningPolicy = { max: 3, then: 'kick' }
const DEFAULT_WARN_TEXT = '⚠️ {name}: {reason}. Advertencia {count}/{max}.'
const DEFAULT_REASONS: Record<ModerationRule, string> = {
  antiSpam: 'no envíes tantos mensajes seguidos',
  wordFilter: 'ese lenguaje no está permitido',
  linkFilter: 'no se permiten enlaces de otros grupos',
}

interface Resolved {
  rules: ModerationRules
  words: CompiledTerm[]
}

type InternalResult = ActionResult & { escalate?: ModerationAction }

const SEP = '\u0000'
const keyOf = (chatId: ChatId, userId: UserId) => `${chatId}${SEP}${userId}`

function actionsOf(spec: ActionSpec | undefined, fallback: readonly ModerationAction[]): ModerationAction[] {
  if (spec === undefined) return [...fallback]
  return typeof spec === 'string' ? [spec] : [...spec]
}

export class Moderator implements ModerationController {
  private readonly windows = new RateWindow()
  private readonly warnCounts = new Map<string, number>()
  private readonly mutes = new Map<string, number>()
  private readonly adminCache = new Map<ChatId, { at: number; admins: Set<UserId> }>()
  private readonly groupOverrides = new Map<ChatId, ModerationRules | false>()
  private readonly resolvedCache = new Map<ChatId, Resolved | false>()
  private readonly warnedUnsupported = new Set<string>()
  private readonly now: () => number

  constructor(
    private readonly config: ModerationConfig,
    private readonly logger: ModeratorLogger,
    private readonly sendWarning: WarnSender,
  ) {
    this.now = config.now ?? Date.now
    for (const [chatId, rules] of Object.entries(config.groups ?? {})) this.groupOverrides.set(chatId, rules)
  }

  /* ---------------------------------------------------------------- rules */

  /** Effective rules for a chat (global rules shallow-merged with its override), or `false`. */
  private resolve(chatId: ChatId): Resolved | false {
    const cached = this.resolvedCache.get(chatId)
    if (cached !== undefined) return cached
    const override = this.groupOverrides.get(chatId)
    let resolved: Resolved | false = false
    if (override !== false) {
      const {
        groups: _groups, provider: _provider, isAdmin: _isAdmin, onViolation: _onViolation, now: _now,
        applyTo: _applyTo, adminCacheMs: _adminCacheMs, kickFallback: _kickFallback, priority: _priority,
        ...base
      } = this.config
      const rules: ModerationRules = { ...base, ...(override ?? {}) }
      if (rules.enabled !== false) {
        if (rules.autoKickOnLink && !rules.linkFilter) rules.linkFilter = { action: ['delete', 'kick'] }
        const wf = rules.wordFilter
        resolved = { rules, words: wf ? compileTerms(wf.banned, wf.wholeWord ?? true) : [] }
      }
    }
    this.resolvedCache.set(chatId, resolved)
    return resolved
  }

  setGroupRules(chatId: ChatId, rules: ModerationRules | false | undefined): void {
    if (rules === undefined) this.groupOverrides.delete(chatId)
    else this.groupOverrides.set(chatId, rules)
    this.resolvedCache.delete(chatId)
  }

  /* ---------------------------------------------------------------- state */

  mute(chatId: ChatId, userId: UserId, ms?: number): void {
    const resolved = this.resolve(chatId)
    const duration = ms ?? (resolved ? resolved.rules.muteMs : undefined) ?? this.config.muteMs ?? DEFAULT_MUTE_MS
    this.mutes.set(keyOf(chatId, userId), this.now() + duration)
  }

  unmute(chatId: ChatId, userId: UserId): boolean {
    return this.mutes.delete(keyOf(chatId, userId))
  }

  isMuted(chatId: ChatId, userId: UserId): boolean {
    const key = keyOf(chatId, userId)
    const until = this.mutes.get(key)
    if (until === undefined) return false
    if (until <= this.now()) {
      this.mutes.delete(key)
      return false
    }
    return true
  }

  warnings(chatId: ChatId, userId: UserId): number {
    return this.warnCounts.get(keyOf(chatId, userId)) ?? 0
  }

  resetWarnings(chatId: ChatId, userId?: UserId): void {
    if (userId !== undefined) {
      this.warnCounts.delete(keyOf(chatId, userId))
      return
    }
    const prefix = `${chatId}${SEP}`
    for (const key of this.warnCounts.keys()) if (key.startsWith(prefix)) this.warnCounts.delete(key)
  }

  invalidateAdmins(chatId?: ChatId): void {
    if (chatId === undefined) this.adminCache.clear()
    else this.adminCache.delete(chatId)
  }

  /** Forget everything about a user in a chat (they left or were removed). */
  forget(chatId: ChatId, userId: UserId): void {
    const key = keyOf(chatId, userId)
    this.windows.reset(key)
    this.warnCounts.delete(key)
    this.mutes.delete(key)
  }

  async kick(chatId: ChatId, userId: UserId): Promise<ActionResult> {
    const groups = this.config.provider?.groups
    if (!groups?.removeParticipants) {
      this.reportUnsupported('kick')
      return { action: 'kick', status: 'unsupported' }
    }
    try {
      await groups.removeParticipants(chatId, [userId])
      this.forget(chatId, userId)
      return { action: 'kick', status: 'done' }
    } catch (error) {
      return { action: 'kick', status: 'failed', error }
    }
  }

  /* ---------------------------------------------------------------- admin */

  private async isAdmin(chatId: ChatId, userId: UserId, rules: ModerationRules): Promise<boolean> {
    if (rules.admins?.includes(userId)) return true
    if (this.config.isAdmin && (await this.config.isAdmin(chatId, userId))) return true
    const groups = this.config.provider?.groups
    if (!groups?.getAdmins) return false
    const ttl = this.config.adminCacheMs ?? DEFAULT_ADMIN_CACHE_MS
    let entry = this.adminCache.get(chatId)
    if (!entry || this.now() - entry.at > ttl) {
      try {
        const admins = await groups.getAdmins(chatId)
        entry = { at: this.now(), admins: new Set(admins) }
        this.adminCache.set(chatId, entry)
      } catch (err) {
        this.logger.warn({ err }, 'moderation: could not fetch group admins; treating sender as non-admin')
        return false
      }
    }
    return entry.admins.has(userId)
  }

  /* ---------------------------------------------------------------- check */

  /** Evaluate one inbound message and run the actions of the rule that fired. */
  async check(ctx: MessageContext): Promise<Verdict> {
    if (ctx.interaction || ctx.isFromMe) return { kind: 'allow' }
    if (!ctx.isGroup && (this.config.applyTo ?? 'groups') === 'groups') return { kind: 'allow' }
    const resolved = this.resolve(ctx.from)
    if (!resolved) return { kind: 'allow' }
    const { rules } = resolved
    const chatId = ctx.from
    const userId = ctx.sender
    const bypass = rules.adminBypass ?? true

    if (this.isMuted(chatId, userId)) {
      if (bypass && (await this.isAdmin(chatId, userId, rules))) {
        this.unmute(chatId, userId)
      } else {
        if (rules.deleteWhileMuted) await this.runDelete(ctx)
        return { kind: 'ignore', reason: 'muted' }
      }
    }
    if (bypass && (await this.isAdmin(chatId, userId, rules))) return { kind: 'allow' }

    const hit = this.findViolation(ctx, resolved)
    if (!hit) return { kind: 'allow' }
    const report = await this.enforce(ctx, rules, hit.rule, hit.detail, hit.actions)
    return { kind: 'violation', report }
  }

  private findViolation(
    ctx: MessageContext,
    { rules, words }: Resolved,
  ): { rule: ModerationRule; detail: string; actions: ModerationAction[] } | undefined {
    const body = ctx.body ?? ''
    if (rules.linkFilter) {
      const link = this.checkLinks(body, rules.linkFilter)
      if (link) return { rule: 'linkFilter', detail: link, actions: actionsOf(rules.linkFilter.action, ['delete', 'warn']) }
    }
    if (rules.wordFilter && words.length > 0) {
      const term = firstMatch(words, body)
      if (term) return { rule: 'wordFilter', detail: term.label, actions: actionsOf(rules.wordFilter.action, ['delete']) }
    }
    const spam = rules.antiSpam
    if (spam && spam.maxMessages > 0 && spam.windowMs > 0) {
      const key = keyOf(ctx.from, ctx.sender)
      const count = this.windows.hit(key, this.now(), spam.windowMs)
      if (count > spam.maxMessages) {
        // One burst → one action: start counting afresh after a violation.
        this.windows.reset(key)
        return { rule: 'antiSpam', detail: `${count} msgs / ${spam.windowMs}ms`, actions: actionsOf(spam.action, ['warn']) }
      }
    }
    return undefined
  }

  private checkLinks(body: string, rule: LinkFilterRule): string | undefined {
    if (!body) return undefined
    const patterns = rule.invitePatterns ?? []
    // Exact code match only: a substring match would let any URL that merely
    // contains an allowed code through.
    const allowed = allowedInviteCodes(rule.allowInvites ?? [], patterns)
    if (rule.groupInvites ?? true) {
      for (const invite of findInviteLinks(body, patterns)) {
        if (!allowed.has(invite.code)) return invite.url
      }
    }
    if (rule.allLinks) {
      const domains = rule.allowDomains ?? []
      for (const link of findLinks(body)) {
        if (isAllowedInviteLink(link, allowed, patterns)) continue
        const host = linkHost(link)
        if (host && domains.some((d) => hostMatches(host, d))) continue
        return link
      }
    }
    return undefined
  }

  /* -------------------------------------------------------------- actions */

  private async enforce(
    ctx: MessageContext,
    rules: ModerationRules,
    rule: ModerationRule,
    detail: string,
    actions: ModerationAction[],
  ): Promise<ModerationReport> {
    const results: ActionResult[] = []
    const queue = [...actions]
    const done = new Set<ModerationAction>()
    while (queue.length > 0) {
      const action = queue.shift()!
      if (done.has(action)) continue
      done.add(action)
      const { escalate, ...result } = await this.runAction(ctx, rules, rule, action)
      results.push(result)
      // Warn escalation: the max-th warning turns into mute/kick.
      if (escalate) queue.push(escalate)
      // Degrade: an unsupported kick becomes a mute so the offender is at least ignored.
      if (
        action === 'kick' && result.status === 'unsupported' &&
        (this.config.kickFallback ?? 'mute') === 'mute' && !done.has('mute')
      ) {
        done.add('mute')
        this.mute(ctx.from, ctx.sender, rules.muteMs)
        results.push({ action: 'mute', status: 'done', fallbackFor: 'kick' })
      }
    }
    return {
      chatId: ctx.from,
      senderId: ctx.sender,
      rule,
      detail,
      ref: ctx.ref,
      results,
      warnings: this.warnings(ctx.from, ctx.sender),
    }
  }

  private async runAction(
    ctx: MessageContext,
    rules: ModerationRules,
    rule: ModerationRule,
    action: ModerationAction,
  ): Promise<InternalResult> {
    switch (action) {
      case 'delete':
        return this.runDelete(ctx)
      case 'mute':
        this.mute(ctx.from, ctx.sender, rules.muteMs)
        return { action, status: 'done' }
      case 'kick':
        return this.kick(ctx.from, ctx.sender)
      case 'warn':
        return this.runWarn(ctx, rules, rule)
    }
  }

  private async runDelete(ctx: MessageContext): Promise<ActionResult> {
    const provider = this.config.provider
    try {
      if (provider) {
        if (!provider.deleteMessage) {
          this.reportUnsupported('delete')
          return { action: 'delete', status: 'unsupported' }
        }
        await provider.deleteMessage(ctx.ref)
        return { action: 'delete', status: 'done' }
      }
      // No provider handle: ctx.delete() degrades to a silent no-op when the
      // transport cannot delete, so support cannot be verified.
      await ctx.delete()
      return { action: 'delete', status: 'attempted' }
    } catch (error) {
      return { action: 'delete', status: 'failed', error }
    }
  }

  private async runWarn(ctx: MessageContext, rules: ModerationRules, rule: ModerationRule): Promise<InternalResult> {
    const policy = rules.warnings === undefined ? DEFAULT_WARNINGS : rules.warnings
    const key = keyOf(ctx.from, ctx.sender)
    const count = (this.warnCounts.get(key) ?? 0) + 1
    const escalate = policy && count >= policy.max ? policy.then : undefined
    if (escalate) this.warnCounts.delete(key)
    else this.warnCounts.set(key, count)

    const reason = rules.messages?.reasons?.[rule] ?? DEFAULT_REASONS[rule]
    const text = (rules.messages?.warn ?? DEFAULT_WARN_TEXT)
      .replaceAll('{name}', ctx.senderInfo?.displayName ?? ctx.pushName ?? 'usuario')
      .replaceAll('{reason}', reason)
      .replaceAll('{count}', String(count))
      .replaceAll('{max}', policy ? String(policy.max) : '∞')
    const extra = escalate ? { escalate } : {}
    try {
      await this.sendWarning(ctx, text)
      return { action: 'warn', status: 'done', ...extra }
    } catch (error) {
      return { action: 'warn', status: 'failed', error, ...extra }
    }
  }

  private reportUnsupported(action: ModerationAction): void {
    if (this.warnedUnsupported.has(action)) return
    this.warnedUnsupported.add(action)
    this.logger.warn(
      { action },
      action === 'kick'
        ? 'moderation: provider has no groups.removeParticipants, kick is unsupported (degrading)'
        : 'moderation: provider has no deleteMessage, delete is unsupported',
    )
  }
}
