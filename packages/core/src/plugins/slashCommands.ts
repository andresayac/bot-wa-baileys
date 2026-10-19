/**
 * Built-in slash commands plugin.
 *
 * Registers on the Dispatcher's *command route* (`bot.command`) rather than as a
 * `when()` matcher, so `/reset` and friends always beat active conversations —
 * see `Dispatcher.run()` step 7 ("commands — always beat an active conversation").
 *
 * Commands:
 *   /start     — show greeting + command list
 *   /help      — same as /start
 *   /reset     — abort any active conversation in this chat (group-aware) and
 *                re-arm the WELCOME trigger for this user (`bot.resetWelcome`)
 *   /cancel    — abort the active conversation only (WELCOME stays spent)
 *   /id        — print this chat's JID (useful for devs)
 *   /ping      — health check (replies 'pong 🏓')
 *
 * Also listens for the Dispatcher's `command:unknown` event (emitted for any
 * `/xyz` with no registered handler) and answers with a help hint — only for
 * messages that actually used the command prefix.
 *
 * Every reply is localized through `ctx.t` (`core.commands.*`, built-in `es`/`en`,
 * overridable with `bot.locale()`); an explicit `greeting`/`unknownMessage` wins.
 *
 * Designed to be intentionally tiny — users can disable + roll their own.
 */

import { definePlugin } from './definePlugin.js'
import type { MessageContext } from '../core/types.js'
import { CORE_MESSAGES } from '../i18n/builtins.js'

export interface SlashCommandsConfig {
  /** Greeting/help text shown on /start and /help. Defaults to the localized `core.commands.help`. */
  greeting?: string
  /** Reply sent for an unrecognized `/command`. Defaults to the localized `core.commands.unknown`. */
  unknownMessage?: string
}

interface CommandUnknownPayload {
  ctx: MessageContext
  command: string
}

export const slashCommandsPlugin = definePlugin<SlashCommandsConfig>({
  name: 'slash-commands',
  version: '2.0.0',
  description: '/start /help /reset /cancel /id /ping + aviso de comando desconocido',

  install(pluginCtx, config = {}) {
    const bot = pluginCtx.bot
    const help = (ctx: MessageContext) => config.greeting ?? ctx.t(CORE_MESSAGES.commandsHelp)

    bot.command('start', async (ctx) => {
      await ctx.reply(help(ctx))
    })
    bot.command('help', async (ctx) => {
      await ctx.reply(help(ctx))
    })
    bot.command('reset', async (ctx) => {
      bot.abortConversation(ctx)
      // A full restart: the user's next message is a first contact again (WELCOME).
      // Same granularity as the abort: the DM, or this participant of a group.
      try {
        await bot.resetWelcome(ctx.from, ctx.isGroup ? ctx.sender : undefined)
      } catch (err) {
        pluginCtx.logger.warn({ err }, 'could not re-arm WELCOME on /reset')
      }
      await ctx.reply(ctx.t(CORE_MESSAGES.commandsReset))
    })
    bot.command('cancel', async (ctx) => {
      bot.abortConversation(ctx)
      await ctx.reply(ctx.t(CORE_MESSAGES.commandsCancel))
    })
    bot.command('id', async (ctx) => {
      await ctx.reply(ctx.t(ctx.isGroup ? CORE_MESSAGES.commandsIdGroup : CORE_MESSAGES.commandsId, { id: ctx.from }))
    })
    bot.command('ping', async (ctx) => {
      await ctx.reply(ctx.t(CORE_MESSAGES.commandsPing))
    })

    const onUnknown = ({ ctx }: CommandUnknownPayload) => {
      void ctx.reply(config.unknownMessage ?? ctx.t(CORE_MESSAGES.commandsUnknown))
    }
    bot.on('command:unknown', onUnknown)
    pluginCtx.onDispose(() => bot.off('command:unknown', onUnknown))
  },
})
