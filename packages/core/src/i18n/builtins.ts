/**
 * Built-in core messages (conversation timeouts/retries/errors, wait
 * validation, slash commands) in Spanish and English. They live under the
 * `core.` namespace of every locale, so `bot.locale('en', { core: { … } })`
 * overrides them and a new locale can translate them.
 */

import type { LocaleMessages } from './types.js'

/** Keys of the built-in core messages (pass them to `ctx.t()` or override them in `bot.locale()`). */
export const CORE_MESSAGES = {
  /** A conversation wait timed out. */
  timeout: 'core.conversation.timeout',
  /** A wait exhausted its `retries`. */
  retries: 'core.conversation.retries',
  /** A conversation threw an unexpected error. */
  error: 'core.conversation.error',
  /** A text wait received something that is not text. */
  waitText: 'core.wait.text',
  /** A `validate` rejection without its own message. */
  waitInvalid: 'core.wait.invalid',
  /** `c.waitMedia()` received something that is not an accepted media type. */
  waitMedia: 'core.wait.media',
  /** `/start` and `/help` text of `slashCommandsPlugin`. */
  commandsHelp: 'core.commands.help',
  /** `/reset` reply. */
  commandsReset: 'core.commands.reset',
  /** `/cancel` reply. */
  commandsCancel: 'core.commands.cancel',
  /** `/id` reply (`{id}`). */
  commandsId: 'core.commands.id',
  /** `/id` reply in a group (`{id}`). */
  commandsIdGroup: 'core.commands.idGroup',
  /** `/ping` reply. */
  commandsPing: 'core.commands.ping',
  /** Reply to an unknown `/command`. */
  commandsUnknown: 'core.commands.unknown',
} as const

/** Union of the built-in core message keys. */
export type CoreMessageKey = (typeof CORE_MESSAGES)[keyof typeof CORE_MESSAGES]

/** The built-in locales: `es` (historical defaults, byte for byte) and `en`. */
export const BUILTIN_LOCALES: Readonly<Record<'es' | 'en', LocaleMessages>> = {
  es: {
    core: {
      conversation: {
        timeout: '⏰ La conversación expiró por inactividad.',
        retries: '❌ Demasiados intentos. Conversación terminada.',
        error: '⚠️ Ocurrió un error. La conversación terminó.',
      },
      wait: {
        text: '✍️ Escribe tu respuesta como texto.',
        invalid: '❌ Entrada inválida, intenta de nuevo.',
        media: '📎 Envía un archivo válido.',
      },
      commands: {
        help: [
          '🤖 *Comandos*',
          '',
          '/help — este mensaje',
          '/reset — cancelar conversación activa',
          '/id — ID de este chat',
          '/ping — comprobar vida',
        ].join('\n'),
        reset: '✅ Conversación reiniciada.',
        cancel: '✅ Conversación reiniciada.',
        id: '🆔 {id}',
        idGroup: '🆔 {id} (grupo)',
        ping: 'pong 🏓',
        unknown: '🤔 Comando desconocido. Envía /help.',
      },
    },
  },
  en: {
    core: {
      conversation: {
        timeout: '⏰ The conversation expired due to inactivity.',
        retries: '❌ Too many attempts. Conversation ended.',
        error: '⚠️ Something went wrong. The conversation ended.',
      },
      wait: {
        text: '✍️ Please reply with text.',
        invalid: '❌ Invalid input, please try again.',
        media: '📎 Please send a valid file.',
      },
      commands: {
        help: [
          '🤖 *Commands*',
          '',
          '/help — this message',
          '/reset — cancel the active conversation',
          '/id — this chat ID',
          '/ping — health check',
        ].join('\n'),
        reset: '✅ Conversation restarted.',
        cancel: '✅ Conversation restarted.',
        id: '🆔 {id}',
        idGroup: '🆔 {id} (group)',
        ping: 'pong 🏓',
        unknown: '🤔 Unknown command. Send /help.',
      },
    },
  },
}
