/**
 * Built-in slash commands plugin.
 *
 * Enabled by default with `includeSlashCommands` (opt-out via Bot config).
 *
 * Commands:
 *   /start     — show greeting + command list
 *   /help      — list commands
 *   /reset     — abort any active flow in this chat
 *   /cancel    — same as /reset
 *   /id        — print this chat's JID (useful for devs)
 *   /ping      — health check (replies 'pong 🏓')
 *
 * Designed to be intentionally tiny — users can disable + roll their own.
 */

import { definePlugin } from './definePlugin'
import type { Bot } from '../core/Bot'

export interface SlashCommandsConfig {
  /** Prefix for commands. Default '/'. */
  prefix?: string
  /** Greeting message shown on /start. */
  greeting?: string | ((ctx: any) => string | Promise<string>)
  /** Help formatter. Return the text reply. */
  help?: (ctx: any) => string | Promise<string>
}

export const slashCommandsPlugin = definePlugin<SlashCommandsConfig>({
  name: 'slash-commands',
  version: '1.0.0',
  description: 'Built-in /start, /help, /reset, /cancel, /id, /ping commands',

  install(pluginCtx, config = {}) {
    const bot = pluginCtx.bot as Bot
    const prefix = config.prefix ?? '/'
    const logger = pluginCtx.logger

    bot.when(
      [
        `${prefix}start`,
        `${prefix}help`,
        `${prefix}reset`,
        `${prefix}cancel`,
        `${prefix}id`,
        `${prefix}ping`,
      ],
      async (ctx) => {
        const cmd = ctx.body.trim().toLowerCase().split(/\s+/)[0]
        try {
          switch (cmd) {
            case `${prefix}start`:
            case `${prefix}help`: {
              const helpText =
                typeof config.help === 'function'
                  ? await config.help(ctx)
                  : (config.greeting
                      ? (typeof config.greeting === 'function' ? await config.greeting(ctx) : config.greeting)
                      : [
                          '🤖 *Bot commands*',
                          '',
                          `${prefix}start — show this message`,
                          `${prefix}help  — alias of /start`,
                          `${prefix}reset — cancel any active conversation`,
                          `${prefix}id    — show this chat's ID`,
                          `${prefix}ping  — health check`,
                        ].join('\n'))
              await ctx.say(helpText)
              break
            }
            case `${prefix}reset`:
            case `${prefix}cancel`: {
              bot.abortFlow(ctx.from)
              await ctx.say('✅ Conversación reiniciada.')
              break
            }
            case `${prefix}id`: {
              await ctx.say(`🆔 JID: \`${ctx.from}\`\n💬 ${ctx.isGroup ? 'Grupo' : 'Chat privado'}`)
              break
            }
            case `${prefix}ping`: {
              await ctx.say('pong 🏓')
              break
            }
          }
        } catch (err) {
          logger.error({ err, cmd }, 'slash command failed')
        }
        ctx.abort() // don't continue to other handlers
      }
    )
  },
})
