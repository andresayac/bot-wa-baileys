/**
 * moderationPlugin — group moderation for `@botmesh/core`.
 *
 * Hooks `before('message')` (priority 100 by default, so it runs before other
 * hooks and every handler): a muted sender's messages are dropped; a message
 * that breaks a rule triggers its actions and is NOT routed to handlers.
 *
 * @example
 * ```ts
 * import { moderationPlugin } from '@botmesh/moderation'
 *
 * bot.plug(moderationPlugin({
 *   provider,                                   // enables delete/kick/admin lookups when supported
 *   antiSpam: { maxMessages: 5, windowMs: 10_000, action: 'warn' },
 *   wordFilter: { banned: ['spam', 'estafa', /bit\.ly\/\w+/i], action: 'delete' },
 *   autoKickOnLink: true,
 *   groups: { [staffGroupId]: false },          // no moderation in the staff group
 * }))
 * bot.on('moderation', (report) => log.info(report))
 * ```
 */

import { definePlugin, type GroupEvent, type MessageContext, type PluginSpec } from '@botmesh/core'
import { Moderator } from './Moderator.js'
import type { ModerationConfig } from './types.js'

/** Build the moderation plugin for `bot.plug(...)`. `install` is synchronous. */
export function moderationPlugin(config: ModerationConfig = {}): PluginSpec<ModerationConfig> {
  return definePlugin<ModerationConfig>({
    name: 'moderation',
    version: '0.1.0',
    description: 'Group moderation: anti-spam, word/link filters, warn/mute/kick/delete.',
    install(ctx) {
      const { bot, logger } = ctx
      const moderator = new Moderator(config, logger, (mctx, text) =>
        bot.send(mctx.from, { kind: 'text', text }, { mentions: [mctx.sender], quoted: mctx.ref }),
      )
      ctx.tools.moderation = moderator

      // The Bot's groupMode filter runs BEFORE before('message') hooks, so with
      // 'mentions' or 'commands' most group messages never reach moderation.
      // There is no earlier hook point; tell the operator at install time.
      const groupMode = (bot as unknown as { config?: { groupMode?: unknown } }).config?.groupMode
      if (groupMode === 'mentions' || groupMode === 'commands') {
        logger.warn(
          { groupMode },
          `moderation: the bot groupMode is '${groupMode}', so group messages it filters out ` +
            "(no mention / not a command) never reach moderation; use groupMode 'all' to moderate every message",
        )
      }

      bot.before(
        'message',
        async (mctx: MessageContext & { abort(): void }, next: () => Promise<void>) => {
          const verdict = await moderator.check(mctx)
          if (verdict.kind === 'allow') return next()
          if (verdict.kind === 'violation') {
            const { report } = verdict
            logger.info(
              { rule: report.rule, results: report.results.map((r) => `${r.action}:${r.status}`) },
              'moderation violation',
            )
            bot.emit('moderation', report)
            if (config.onViolation) {
              try {
                await config.onViolation(report)
              } catch (err) {
                logger.warn({ err }, 'moderation: onViolation threw')
              }
            }
          }
          mctx.abort()
        },
        config.priority ?? 100,
      )

      const onGroup = (event: GroupEvent) => {
        if (event.action === 'promote' || event.action === 'demote') moderator.invalidateAdmins(event.chatId)
        if (event.action === 'remove') for (const userId of event.participants) moderator.forget(event.chatId, userId)
      }
      bot.on('group', onGroup)
      ctx.onDispose(() => { bot.off('group', onGroup) })
    },
  })
}
