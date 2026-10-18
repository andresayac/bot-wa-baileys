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
  /** Confirmation prompt of a `confirm: true` tool (`{tool}`, `{args}`: a newline + the JSON arguments, or empty). */
  toolConfirm: 'ai.tools.confirm',
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
        confirm: 'Voy a ejecutar «{tool}».{args}\n¿Confirmas? (sí/no)',
        maxSteps: 'No pude completar la solicitud. Intenta de nuevo con más detalle.',
      },
      rag: { sources: 'Fuentes: {sources}' },
    },
  },
  en: {
    ai: {
      tools: {
        confirm: 'About to run «{tool}».{args}\nDo you confirm? (yes/no)',
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
  if (ctx && typeof ctx.t === 'function') {
    try {
      const out = ctx.t(key, params)
      // The core returns the key itself when no locale has it.
      if (typeof out === 'string' && out !== key) return out
    } catch { /* fall back to the built-in text */ }
  }
  return interpolate(builtin(ctx?.lang, key) ?? key, params)
}
