/**
 * Built-in core messages (conversation timeouts/retries/errors, wait
 * validation, slash commands, `flow().form()` prompts and errors) in Spanish
 * and English. They live under the
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
  /** A conversation was interrupted when another replica took the chat (`coordination.handover.fallback: 'notify'`). */
  conversationInterrupted: 'core.conversation.interrupted',
  /** A text wait received something that is not text. */
  waitText: 'core.wait.text',
  /** A `validate` rejection without its own message. */
  waitInvalid: 'core.wait.invalid',
  /** `c.waitMedia()` received something that is not an accepted media type. */
  waitMedia: 'core.wait.media',
  /** `c.waitLocation()` received something that is not a shared location. */
  waitLocation: 'core.wait.location',
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
  /** Native form: reminder when something other than the submission arrives. */
  formPending: 'core.form.pending',
  /** Degraded form: default word that skips an optional field. */
  formSkipWord: 'core.form.skipWord',
  /** Degraded form: hint under an optional field (`{word}`). */
  formSkipHint: 'core.form.skipHint',
  /** Degraded form: format hint under a date field. */
  formDateHint: 'core.form.dateHint',
  /** Degraded form: the opt-in menu. */
  formYesNo: 'core.form.yesNo',
  /** Degraded form: multiselect hint when only one pick is allowed. */
  formPickOne: 'core.form.pickOne',
  /** Degraded form: multiselect hint (`{max}`). */
  formPickUpTo: 'core.form.pickUpTo',
  /** Degraded form: multiselect hint (`{min}`, `{max}`). */
  formPickBetween: 'core.form.pickBetween',
  /** Empty answer to a text field (`{label}`). */
  formEmpty: 'core.form.empty',
  /** Text shorter than `minLength` (`{label}`, `{min}`). */
  formMinLength: 'core.form.minLength',
  /** Text longer than `maxLength` (`{label}`, `{max}`). */
  formMaxLength: 'core.form.maxLength',
  /** Text not matching `pattern` (`{label}`). */
  formPattern: 'core.form.pattern',
  /** Invalid email. */
  formEmail: 'core.form.email',
  /** Not a number (`{label}`). */
  formNumber: 'core.form.number',
  /** Number with thousands separators (`{label}`). */
  formAmbiguousNumber: 'core.form.ambiguousNumber',
  /** Not a whole number (`{label}`). */
  formInteger: 'core.form.integer',
  /** Number below `min` (`{label}`, `{min}`). */
  formMin: 'core.form.min',
  /** Number above `max` (`{label}`, `{max}`). */
  formMax: 'core.form.max',
  /** Unparseable date. */
  formDate: 'core.form.date',
  /** Date before `min` (`{label}`, `{min}`). */
  formDateMin: 'core.form.dateMin',
  /** Date after `max` (`{label}`, `{max}`). */
  formDateMax: 'core.form.dateMax',
  /** Answer matching no option of a select. */
  formSelect: 'core.form.select',
  /** Multiselect token matching no option (`{part}`). */
  formUnknownOption: 'core.form.unknownOption',
  /** Too few picks (`{label}`, `{min}`). */
  formPickMin: 'core.form.pickMin',
  /** Too many picks (`{label}`, `{max}`). */
  formPickMax: 'core.form.pickMax',
  /** Opt-in answer that is neither yes nor no. */
  formOptin: 'core.form.optin',
  /** Required opt-in not accepted (`{label}`). */
  formOptinRequired: 'core.form.optinRequired',
  /** Required field missing from a native submission (`{label}`). */
  formRequired: 'core.form.required',
  /** Native submission value of the wrong type (`{label}`). */
  formInvalidValue: 'core.form.invalidValue',
  /** Native submission with an unknown option (`{label}`). */
  formInvalidOption: 'core.form.invalidOption',
  /** Native submission with an invalid date (`{label}`). */
  formInvalidDate: 'core.form.invalidDate',
  /** Native form: label of the button that opens it (default of `FormDefinition.cta`). */
  formCta: 'core.form.cta',
  /** Native form: label of its submit button (default of `FormDefinition.submitLabel`). */
  formSubmit: 'core.form.submit',
  /** Native form: message body when the definition has neither `intro` nor `title`. */
  formBody: 'core.form.body',
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
        interrupted: '⚠️ La conversación anterior se interrumpió. Por favor, empieza de nuevo.',
      },
      wait: {
        text: '✍️ Escribe tu respuesta como texto.',
        invalid: '❌ Entrada inválida, intenta de nuevo.',
        media: '📎 Envía un archivo válido.',
        location: '📍 Comparte una ubicación (clip → Ubicación).',
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
      form: {
        pending: '👆 Completa el formulario de arriba para continuar.',
        cta: 'Abrir formulario',
        submit: 'Enviar',
        body: 'Completa el formulario.',
        skipWord: 'omitir',
        skipHint: '(escribe "{word}" para saltar)',
        dateHint: '(AAAA-MM-DD o DD/MM/AAAA)',
        yesNo: '1) Sí\n2) No',
        pickOne: 'Elige una.',
        pickUpTo: 'Puedes elegir hasta {max}, separadas por coma (ej. 1, 3).',
        pickBetween: 'Puedes elegir entre {min} y {max}, separadas por coma (ej. 1, 3).',
        empty: '✍️ {label}: escribe una respuesta.',
        minLength: '❌ {label}: mínimo {min} caracteres.',
        maxLength: '❌ {label}: máximo {max} caracteres.',
        pattern: '❌ {label}: formato no válido.',
        email: '❌ Escribe un correo válido (ej. nombre@dominio.com).',
        number: '❌ {label}: escribe un número.',
        ambiguousNumber: '❌ {label}: escribe el número sin separador de miles (ej. 1500 o 1,5).',
        integer: '❌ {label}: debe ser un número entero.',
        min: '❌ {label}: el mínimo es {min}.',
        max: '❌ {label}: el máximo es {max}.',
        date: '❌ Escribe una fecha válida (AAAA-MM-DD o DD/MM/AAAA).',
        dateMin: '❌ {label}: la fecha mínima es {min}.',
        dateMax: '❌ {label}: la fecha máxima es {max}.',
        select: '❌ Elige una opción de la lista (número u opción).',
        unknownOption: '❌ No reconozco "{part}". Escribe los números separados por coma (ej. 1, 3).',
        pickMin: '❌ {label}: elige al menos {min}.',
        pickMax: '❌ {label}: elige como máximo {max}.',
        optin: '❌ Responde 1 (Sí) o 2 (No).',
        optinRequired: '❌ Debes aceptar: {label}.',
        required: '❌ {label}: es obligatorio.',
        invalidValue: '❌ {label}: valor no válido.',
        invalidOption: '❌ {label}: opción no válida.',
        invalidDate: '❌ {label}: fecha no válida.',
      },
    },
  },
  en: {
    core: {
      conversation: {
        timeout: '⏰ The conversation expired due to inactivity.',
        retries: '❌ Too many attempts. Conversation ended.',
        error: '⚠️ Something went wrong. The conversation ended.',
        interrupted: '⚠️ Your previous conversation was interrupted. Please start again.',
      },
      wait: {
        text: '✍️ Please reply with text.',
        invalid: '❌ Invalid input, please try again.',
        media: '📎 Please send a valid file.',
        location: '📍 Please share a location (attach → Location).',
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
      form: {
        pending: '👆 Fill in the form above to continue.',
        cta: 'Open form',
        submit: 'Submit',
        body: 'Fill in the form.',
        skipWord: 'skip',
        skipHint: '(type "{word}" to skip)',
        dateHint: '(YYYY-MM-DD or DD/MM/YYYY)',
        yesNo: '1) Yes\n2) No',
        pickOne: 'Pick one.',
        pickUpTo: 'You can pick up to {max}, separated by commas (e.g. 1, 3).',
        pickBetween: 'You can pick between {min} and {max}, separated by commas (e.g. 1, 3).',
        empty: '✍️ {label}: please type an answer.',
        minLength: '❌ {label}: at least {min} characters.',
        maxLength: '❌ {label}: at most {max} characters.',
        pattern: '❌ {label}: invalid format.',
        email: '❌ Please type a valid email (e.g. name@domain.com).',
        number: '❌ {label}: please type a number.',
        ambiguousNumber: '❌ {label}: type the number without thousands separators (e.g. 1500 or 1.5).',
        integer: '❌ {label}: must be a whole number.',
        min: '❌ {label}: the minimum is {min}.',
        max: '❌ {label}: the maximum is {max}.',
        date: '❌ Please type a valid date (YYYY-MM-DD or DD/MM/YYYY).',
        dateMin: '❌ {label}: the earliest date is {min}.',
        dateMax: '❌ {label}: the latest date is {max}.',
        select: '❌ Pick an option from the list (number or option).',
        unknownOption: '❌ I do not recognize "{part}". Type the numbers separated by commas (e.g. 1, 3).',
        pickMin: '❌ {label}: pick at least {min}.',
        pickMax: '❌ {label}: pick at most {max}.',
        optin: '❌ Answer 1 (Yes) or 2 (No).',
        optinRequired: '❌ You must accept: {label}.',
        required: '❌ {label}: is required.',
        invalidValue: '❌ {label}: invalid value.',
        invalidOption: '❌ {label}: invalid option.',
        invalidDate: '❌ {label}: invalid date.',
      },
    },
  },
}
