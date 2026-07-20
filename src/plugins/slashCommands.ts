/**
 * Built-in slash commands plugin.
 *
 * Registers on the Dispatcher's *command route* (`bot.command`) rather than as a
 * `when()` matcher, so `/reset` and friends always beat active conversations —
 * see `Dispatcher.run()` step 1 ("comandos — SIEMPRE antes que la conversación activa").
 *
 * Commands:
 *   /start     — show greeting + command list
 *   /help      — same as /start
 *   /reset     — abort any active conversation in this chat (group-aware)
 *   /cancel    — same as /reset
 *   /id        — print this chat's JID (useful for devs)
 *   /ping      — health check (replies 'pong 🏓')
 *
 * Also listens for the Dispatcher's `command:unknown` event (emitted for any
 * `/xyz` with no registered handler) and answers with a help hint — only for
 * messages that actually used the command prefix.
 *
 * Designed to be intentionally tiny — users can disable + roll their own.
 */

import { definePlugin } from './definePlugin.js'
import type { MessageContext } from '../core/types.js'

export interface SlashCommandsConfig {
  /** Greeting/help text shown on /start and /help. Defaults to a Spanish command list. */
  greeting?: string
  /** Reply sent for an unrecognized `/command`. Defaults to a Spanish hint. */
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
    const help =
      config.greeting ??
      [
        '🤖 *Comandos*',
        '',
        '/help — este mensaje',
        '/reset — cancelar conversación activa',
        '/id — ID de este chat',
        '/ping — comprobar vida',
      ].join('\n')

    bot.command('start', async (ctx) => {
      await ctx.reply(help)
    })
    bot.command('help', async (ctx) => {
      await ctx.reply(help)
    })
    bot.command('reset', async (ctx) => {
      bot.abortConversation(ctx)
      await ctx.reply('✅ Conversación reiniciada.')
    })
    bot.command('cancel', async (ctx) => {
      bot.abortConversation(ctx)
      await ctx.reply('✅ Conversación reiniciada.')
    })
    bot.command('id', async (ctx) => {
      await ctx.reply(`🆔 ${ctx.from}${ctx.isGroup ? ' (grupo)' : ''}`)
    })
    bot.command('ping', async (ctx) => {
      await ctx.reply('pong 🏓')
    })

    const onUnknown = ({ ctx }: CommandUnknownPayload) => {
      void ctx.reply(config.unknownMessage ?? '🤔 Comando desconocido. Envía /help.')
    }
    bot.on('command:unknown', onUnknown)
    pluginCtx.onDispose(() => bot.off('command:unknown', onUnknown))
  },
})
