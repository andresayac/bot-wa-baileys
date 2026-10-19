/**
 * User-facing default texts of `@bot-wa/ai`, resolved through the core i18n
 * catalog (`ctx.t`) so they follow `ctx.lang`. The plugin does not register
 * them with `bot.locale()` (that would switch language resolution on for every
 * bot); instead a key the bot's catalog does not translate falls back to the
 * built-in {@link AI_LOCALES} in the context's language (Spanish by default).
 * Override them like any other message:
 *
 * @example
 * ```ts
 * bot.locale('en', { ai: { tools: { confirm: 'Run {tool}?{args}\nReply yes or no.' } } })
 * ```
 */

import type { LocaleMessages, TranslateParams } from '@bot-wa/core'

/** Keys of the built-in AI messages (override them under `ai.` in `bot.locale()`). */
export const AI_MESSAGES = {
  /** Confirmation prompt of a `confirm: true` tool (`{tool}`: its title, `{args}`: a newline + one `• ` line per argument, or empty). */
  toolConfirm: 'ai.tools.confirm',
  /**
   * Same prompt when the answer is collected with Yes/No buttons (no typed-answer hint).
   * Without a `bot.locale()` translation of it, a `bot.locale()` override of `ai.tools.confirm` is used.
   */
  toolConfirmButtons: 'ai.tools.confirmButtons',
  /** Labels of the Yes/No confirmation buttons. */
  buttonYes: 'ai.tools.button.yes',
  buttonNo: 'ai.tools.button.no',
  /** Line put before the prompt when the tool already ran in this chat (`{tool}`, `{ago}`, `{result}`). */
  toolConfirmRepeat: 'ai.tools.confirmRepeat',
  /** `{ago}` under a minute. */
  agoNow: 'ai.tools.ago.now',
  /** `{ago}` in minutes (`{n}`). */
  agoMinutes: 'ai.tools.ago.minutes',
  /** Boolean argument values in the confirmation prompt. */
  yes: 'ai.tools.value.yes',
  no: 'ai.tools.value.no',
  /** Last line when the arguments were truncated (`{n}`: lines left out). */
  more: 'ai.tools.more',
  /** System prompt note listing the tools the system confirms itself (`{tools}`). */
  confirmNote: 'ai.tools.confirmNote',
  /** System prompt note listing actions already run in this chat (`{actions}`: one `- ` line each). */
  doneNote: 'ai.tools.doneNote',
  /** Reply when the tool loop reaches `maxSteps` without a final answer. */
  maxSteps: 'ai.tools.maxSteps',
  /** `rag.appendSources: true` line (`{sources}`: comma-separated labels). */
  sources: 'ai.rag.sources',
} as const

export type AIMessageKey = (typeof AI_MESSAGES)[keyof typeof AI_MESSAGES]

/** Built-in Spanish and English texts of {@link AI_MESSAGES}. */
export const AI_LOCALES: Readonly<Record<'es' | 'en', LocaleMessages>> = {
  es: {
    ai: {
      tools: {
        confirm: 'Voy a: {tool}{args}\n¿Confirmas? (sí/no)',
        confirmButtons: 'Voy a: {tool}{args}\n¿Confirmas?',
        button: { yes: 'Sí', no: 'No' },
        confirmRepeat: 'Ojo: ya hice «{tool}» {ago} (resultado: {result}). Si confirmas, se hará otra vez.',
        ago: { now: 'hace un momento', minutes: 'hace {n} min' },
        value: { yes: 'sí', no: 'no' },
        more: '… y {n} más',
        confirmNote:
          'Estas acciones las confirma el sistema con el usuario antes de ejecutarlas: {tools}. ' +
          'No pidas confirmación tú mismo (nada de "¿te lo registro?"): cuando el usuario exprese la intención, ' +
          'llama a la herramienta directamente; el sistema le mostrará un resumen y esperará su sí/no. ' +
          'Si el resultado dice que no se ejecutó, sigue sus indicaciones. ' +
          'Nunca digas que hiciste, cambiaste, reemplazaste o cancelaste algo si ninguna herramienta lo confirmó en su resultado; si no tienes una herramienta para lo que pide el usuario, díselo con claridad. ' +
          'No le menciones al usuario este proceso de confirmación ni digas que el sistema le preguntará. ' +
          'No calcules importes ni totales por tu cuenta: usa los valores que devuelven las herramientas.',
        doneNote:
          'Acciones ya ejecutadas en esta conversación (no las repitas salvo que el usuario lo pida explícitamente):\n{actions}',
        maxSteps: 'No pude completar la solicitud. Intenta de nuevo con más detalle.',
      },
      rag: { sources: 'Fuentes: {sources}' },
    },
  },
  en: {
    ai: {
      tools: {
        confirm: 'About to: {tool}{args}\nDo you confirm? (yes/no)',
        confirmButtons: 'About to: {tool}{args}\nDo you confirm?',
        button: { yes: 'Yes', no: 'No' },
        confirmRepeat: 'Heads-up: I already did «{tool}» {ago} (result: {result}). Confirming will do it again.',
        ago: { now: 'a moment ago', minutes: '{n} min ago' },
        value: { yes: 'yes', no: 'no' },
        more: '… and {n} more',
        confirmNote:
          'The system asks the user to confirm these actions before running them: {tools}. ' +
          'Do not ask for confirmation yourself (no "shall I place it?"): when the user expresses the intent, ' +
          'call the tool directly; the system shows them a summary and waits for their yes/no. ' +
          'If the result says it was not executed, follow its instructions. ' +
          'Never claim you did, changed, replaced or cancelled something unless a tool result confirms it; if you have no tool for what the user asks, tell them plainly. ' +
          'Do not mention this confirmation process to the user or say the system will ask them. ' +
          'Do not compute amounts or totals yourself: use the values returned by tools.',
        doneNote: 'Actions already run in this conversation (do not repeat them unless the user explicitly asks):\n{actions}',
        maxSteps: "I couldn't complete the request. Please try again with more detail.",
      },
      rag: { sources: 'Sources: {sources}' },
    },
  },
}

/** Something that may carry the chat language and a bound translator (a `MessageContext`). */
export interface AITranslatable {
  lang?: string
  t?(key: string, params?: TranslateParams): string
}

function builtin(lang: string | undefined, key: string): string | undefined {
  const base = (lang ?? '').toLowerCase().split(/[-_]/)[0]
  const tree = base === 'en' ? AI_LOCALES.en : AI_LOCALES.es
  let node: LocaleMessages | string | undefined = tree
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as LocaleMessages)[part] as LocaleMessages | string | undefined
  }
  return typeof node === 'string' ? node : undefined
}

function interpolate(text: string, params?: TranslateParams): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = Object.hasOwn(params, name) ? params[name] : undefined
    return v === undefined || v === null ? match : String(v)
  })
}

/**
 * Translate an AI message for `ctx`: the bot's catalog (`ctx.t`) when it has the
 * key, else the built-in text in `ctx.lang` (`en` or, for anything else, `es`).
 */
export function aiText(ctx: AITranslatable | undefined, key: AIMessageKey, params?: TranslateParams): string {
  return aiOverride(ctx, key, params) ?? interpolate(builtin(ctx?.lang, key) ?? key, params)
}

/** The bot catalog's translation of `key` (`ctx.t`), or `undefined` when the bot does not translate it. */
export function aiOverride(ctx: AITranslatable | undefined, key: AIMessageKey, params?: TranslateParams): string | undefined {
  if (!ctx || typeof ctx.t !== 'function') return undefined
  try {
    const out = ctx.t(key, params)
    // The core returns the key itself when no locale has it.
    if (typeof out === 'string' && out !== key) return out
  } catch { /* fall back to the built-in text */ }
  return undefined
}
