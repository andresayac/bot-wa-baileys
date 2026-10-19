/**
 * Public types of the native i18n support (FEATURES.md #13): `bot.locale()`,
 * `ctx.t()` / `c.t()`, `ctx.setLang()`.
 */

import type { MessageContext } from '../core/provider.js'

/** CLDR plural categories, as returned by `Intl.PluralRules#select`. */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

/**
 * Plural variants of one message, picked with `params.count`
 * (`Intl.PluralRules` of the active language). `other` is required; `zero`
 * also matches an exact `count === 0` even in languages whose rules have no
 * zero category (es, en).
 *
 * @example
 * ```ts
 * { zero: 'Sin artículos', one: '{count} artículo', other: '{count} artículos' }
 * ```
 */
export interface PluralForms {
  zero?: string
  one?: string
  two?: string
  few?: string
  many?: string
  other: string
}

/**
 * A locale's message tree: leaves are strings (with `{param}` placeholders) or
 * {@link PluralForms}; objects nest (`ctx.t('menu.title')`). A key may also
 * contain dots literally (`{ 'menu.title': '…' }`).
 */
export interface LocaleMessages {
  [key: string]: string | PluralForms | LocaleMessages
}

/** Values interpolated into `{param}` placeholders; `count` also selects the plural form. */
export type TranslateParams = Record<string, string | number | boolean | bigint | null | undefined>

/** `ctx.t` / `c.t` / `bot.t` shape (bound to a language). */
export type Translate = (key: string, params?: TranslateParams) => string

/**
 * Custom language detector — step 3 of the resolution order (after the
 * `ctx.user` preference and the provider-reported language). Return a locale
 * code, or nothing to fall through to the default. Errors are logged (debug)
 * and treated as "no answer". A code with no registered locale is ignored.
 */
export type LanguageDetector = (ctx: MessageContext) => string | null | undefined | Promise<string | null | undefined>

/**
 * Where `ctx.lang` came from: the `ctx.user` preference (or `ctx.setLang()`), the
 * provider-reported language, the custom detector, or the default fallback.
 */
export type LangSource = 'user' | 'provider' | 'detector' | 'default'

/** i18n options — `BotConfig.i18n` or `bot.locale({ ... })`. */
export interface I18nConfig {
  /** Language used when nothing else resolves, and the fallback for missing keys. Default `'es'`. */
  defaultLocale?: string
  /** Custom detector (see {@link LanguageDetector}). */
  detect?: LanguageDetector
  /**
   * Use the language the provider reports for the sender (`SenderInfo.language`,
   * or `platformData.languageCode` / `language` / `locale`, e.g. Telegram's
   * `language_code`). Default `true`.
   */
  providerLanguage?: boolean
  /** `ctx.user` key holding the user's preference (read on every message, written by `ctx.setLang`). Default `'lang'`. */
  userKey?: string
  /**
   * Allow-list of the languages the bot serves (e.g. `['en']` for a bot whose
   * content — persona, flows, button titles — is only in English). A stored
   * preference, provider-reported or detected language outside it is ignored, so
   * resolution falls back to `defaultLocale` (always served); `ctx.setLang()`
   * refuses it. Regional variants follow their base (`'en'` serves `'en-GB'`).
   * Default: every registered locale (the built-in `es` and `en` included).
   */
  locales?: readonly string[]
}
