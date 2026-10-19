/**
 * I18n — the locale registry behind `bot.locale()`, `ctx.t()` and `c.t()`.
 *
 * - **Registry:** `add(code, messages)` deep-merges a message tree into a
 *   locale (codes are normalized: `'EN_us'` → `'en-us'`). The built-in core
 *   messages (`core.*`, see `builtins.ts`) are pre-registered for `es` and `en`.
 * - **Lookup:** nested keys by dot path (`'menu.title'`), or a literal dotted
 *   key. `{param}` placeholders are interpolated; unknown ones stay verbatim.
 *   {@link PluralForms} leaves are picked with `params.count`.
 * - **Fallback:** requested locale → its base language (`es-ar` → `es`) →
 *   default locale (and its base) → the key itself. Every fallback is logged at
 *   debug level. `core.*` keys finally fall back to the built-in Spanish text.
 * - **Resolution** ({@link I18n.resolve}): `ctx.user` preference → provider-
 *   reported language (an update without one reuses the sender's last report) →
 *   custom detector → default, each limited to the `locales` allow-list when one
 *   is configured. Only active once the bot
 *   opted in (a `bot.locale()` call or `BotConfig.i18n`), so bots that never
 *   touch i18n keep their historical Spanish defaults without extra store reads.
 *
 * Transport-agnostic: the provider language is read from `SenderInfo`, never
 * inferred from ids.
 */

import type { MessageContext, SenderInfo } from '../core/provider.js'
import type { UserData } from '../user/types.js'
import { BUILTIN_LOCALES } from './builtins.js'
import type {
  I18nConfig,
  LanguageDetector,
  LangSource,
  LocaleMessages,
  PluralCategory,
  PluralForms,
  TranslateParams,
} from './types.js'

/** Minimal logger the registry needs (pino-compatible). */
export interface I18nLogger {
  debug?(...args: unknown[]): void
}

/** Options of the {@link I18n} constructor. */
export interface I18nOptions extends I18nConfig {
  logger?: I18nLogger
}

const DEFAULT_LOCALE = 'es'
const DEFAULT_USER_KEY = 'lang'
/** Senders whose last provider-reported language is remembered. */
const MAX_REPORTED = 10_000
const PLURAL_CATEGORIES: ReadonlySet<string> = new Set<PluralCategory>(['zero', 'one', 'two', 'few', 'many', 'other'])
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

type Leaf = string | PluralForms
type Tree = { [key: string]: Leaf | Tree }

/**
 * Normalize a locale code: trimmed, lower-case, `_` → `-` (`' EN_us '` → `'en-us'`).
 * Returns `undefined` for anything that is not a non-empty string.
 */
export function normalizeLocale(code: unknown): string | undefined {
  if (typeof code !== 'string') return undefined
  const n = code.trim().toLowerCase().replace(/_/g, '-')
  return n.length > 0 ? n : undefined
}

/** `'es-ar'` → `'es'`; `undefined` when the code has no region/script part. */
function baseOf(code: string): string | undefined {
  const i = code.indexOf('-')
  return i > 0 ? code.slice(0, i) : undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A leaf object whose keys are all CLDR plural categories with string values, `other` included. */
function isPluralForms(v: unknown): v is PluralForms {
  if (!isObject(v) || typeof v.other !== 'string') return false
  for (const [k, val] of Object.entries(v)) {
    if (!PLURAL_CATEGORIES.has(k) || typeof val !== 'string') return false
  }
  return true
}

/** Validate + deep-copy a user message tree (throws `TypeError` with the offending path). */
function cloneTree(input: unknown, path: string): Tree {
  if (!isObject(input)) throw new TypeError(`i18n: messages${path ? ` at "${path}"` : ''} must be a plain object`)
  const out: Tree = {}
  for (const [k, v] of Object.entries(input)) {
    const at = path ? `${path}.${k}` : k
    if (k === '' || FORBIDDEN_KEYS.has(k)) throw new TypeError(`i18n: invalid message key "${at}"`)
    if (typeof v === 'string') out[k] = v
    else if (isPluralForms(v)) out[k] = { ...v }
    else if (isObject(v)) out[k] = cloneTree(v, at)
    else throw new TypeError(`i18n: message "${at}" must be a string, plural forms or a nested object`)
  }
  return out
}

function mergeInto(target: Tree, source: Tree): void {
  for (const [k, v] of Object.entries(source)) {
    const cur = Object.hasOwn(target, k) ? target[k] : undefined
    if (isObject(cur) && !isPluralForms(cur) && isObject(v) && !isPluralForms(v)) mergeInto(cur as Tree, v as Tree)
    else target[k] = v
  }
}

/** Dot-path lookup that also honours literal dotted keys at any level. */
function lookup(node: Tree, parts: string[]): Leaf | undefined {
  for (let i = parts.length; i >= 1; i--) {
    const k = parts.slice(0, i).join('.')
    if (!Object.hasOwn(node, k)) continue
    const v = node[k]
    if (i === parts.length) {
      if (typeof v === 'string' || isPluralForms(v)) return v
      continue
    }
    if (isObject(v) && !isPluralForms(v)) {
      const found = lookup(v as Tree, parts.slice(i))
      if (found !== undefined) return found
    }
  }
  return undefined
}

function interpolate(text: string, params?: TranslateParams): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match
    const v = params[name]
    return v === undefined || v === null ? match : String(v)
  })
}

/**
 * The language the transport reported for the sender: `SenderInfo.language`,
 * else `platformData.languageCode` / `language` / `locale` (e.g. Telegram's
 * `language_code`). Normalized; `undefined` when absent.
 */
export function providerLanguageOf(sender: SenderInfo | undefined): string | undefined {
  if (!sender) return undefined
  const pd = sender.platformData
  return normalizeLocale(sender.language)
    ?? normalizeLocale(pd?.languageCode)
    ?? normalizeLocale(pd?.language)
    ?? normalizeLocale(pd?.locale)
}

export class I18n {
  private tree = new Map<string, Tree>()
  private pluralRules = new Map<string, Intl.PluralRules>()
  private logger?: I18nLogger
  private userLocaleCount = 0
  private configured = false
  private defaultCode = DEFAULT_LOCALE
  private detector?: LanguageDetector
  private useProviderLanguage = true
  private preferenceKey = DEFAULT_USER_KEY
  private allowed?: ReadonlySet<string>
  /** Last language the provider reported per sender, for updates that report none. */
  private reported = new Map<string, string>()

  constructor(options: I18nOptions = {}) {
    this.logger = options.logger
    for (const [code, messages] of Object.entries(BUILTIN_LOCALES)) {
      this.tree.set(code, cloneTree(messages, ''))
    }
    const { logger: _logger, ...config } = options
    if (Object.keys(config).length > 0) this.configure(config)
    // A bare `new I18n()` / `new I18n({ logger })` is not an opt-in for resolution.
    this.configured = Object.keys(config).length > 0
  }

  /** Apply i18n options (marks the registry as enabled). Throws `TypeError` on invalid values. */
  configure(config: I18nConfig): this {
    if (typeof config !== 'object' || config === null) throw new TypeError('i18n: options must be an object')
    if (config.defaultLocale !== undefined) {
      const code = normalizeLocale(config.defaultLocale)
      if (!code) throw new TypeError('i18n: defaultLocale must be a non-empty string')
      this.defaultCode = code
    }
    if (config.detect !== undefined) {
      if (typeof config.detect !== 'function') throw new TypeError('i18n: detect must be a function')
      this.detector = config.detect
    }
    if (config.providerLanguage !== undefined) this.useProviderLanguage = config.providerLanguage !== false
    if (config.userKey !== undefined) {
      if (typeof config.userKey !== 'string' || !/^[^.]+$/.test(config.userKey)) {
        throw new TypeError('i18n: userKey must be a non-empty top-level ctx.user key (no dots)')
      }
      this.preferenceKey = config.userKey
    }
    if (config.locales !== undefined) {
      if (!Array.isArray(config.locales)) throw new TypeError('i18n: locales must be an array of locale codes')
      const allowed = new Set<string>()
      for (const code of config.locales as readonly unknown[]) {
        const n = normalizeLocale(code)
        if (!n) throw new TypeError('i18n: locales must contain non-empty locale codes')
        allowed.add(n)
      }
      this.allowed = allowed
    }
    this.configured = true
    return this
  }

  /** Deep-merge `messages` into locale `code`. Throws `TypeError` on an invalid code or tree. */
  add(code: string, messages: LocaleMessages): this {
    const locale = normalizeLocale(code)
    if (!locale) throw new TypeError('i18n: locale code must be a non-empty string')
    const incoming = cloneTree(messages, '')
    const existing = this.tree.get(locale)
    if (existing) mergeInto(existing, incoming)
    else this.tree.set(locale, incoming)
    this.userLocaleCount++
    return this
  }

  /** The default locale (normalized). */
  get defaultLocale(): string { return this.defaultCode }

  /** `ctx.user` key holding the language preference. */
  get userKey(): string { return this.preferenceKey }

  /** True once locales were registered or options configured — language resolution is active. */
  get enabled(): boolean { return this.configured || this.userLocaleCount > 0 }

  /** Registered locale codes (built-ins included). */
  locales(): string[] { return [...this.tree.keys()] }

  /**
   * The registered locale serving `code`: itself, else its base language
   * (`'es-AR'` → `'es'`). `undefined` when neither is registered, or when the
   * `locales` allow-list leaves it out (the default locale is always served).
   */
  supported(code: unknown): string | undefined {
    const n = normalizeLocale(code)
    if (!n) return undefined
    const base = baseOf(n)
    const served = this.tree.has(n) ? n : base && this.tree.has(base) ? base : undefined
    if (!served || !this.allowed) return served
    const ok = served === this.defaultCode || this.allowed.has(served) || this.allowed.has(n) || (base !== undefined && this.allowed.has(base))
    return ok ? served : undefined
  }

  /**
   * Translate `key` for `lang` (see the class docs for the fallback chain).
   * Never throws: a key missing everywhere comes back as the key itself.
   */
  translate(lang: string | undefined, key: string, params?: TranslateParams): string {
    const requested = normalizeLocale(lang) ?? this.defaultCode
    const primary = [requested, baseOf(requested)]
    const chain = [...primary, this.defaultCode, baseOf(this.defaultCode)]
    if (key.startsWith('core.')) chain.push(DEFAULT_LOCALE)
    const parts = key.split('.')
    const seen = new Set<string>()
    for (const code of chain) {
      if (!code || seen.has(code)) continue
      seen.add(code)
      const tree = this.tree.get(code)
      const leaf = tree ? lookup(tree, parts) : undefined
      if (leaf === undefined) continue
      if (!primary.includes(code)) {
        this.logger?.debug?.({ key, lang: requested, fallback: code }, 'i18n: missing key, using fallback locale')
      }
      return this.render(leaf, code === requested || code === baseOf(requested) ? requested : code, params)
    }
    this.logger?.debug?.({ key, lang: requested }, 'i18n: missing key')
    return interpolate(key, params)
  }

  /**
   * Resolve the language of an inbound context: the `ctx.user` preference →
   * the provider-reported language → the detector's answer → the default. Each
   * candidate only counts when a registered locale serves it ({@link supported}),
   * so the result is always a registered locale or the default. Never rejects. Returns the default
   * immediately while i18n is not {@link enabled}.
   */
  async resolve(ctx: MessageContext): Promise<string> {
    return (await this.resolveDetailed(ctx)).lang
  }

  /** {@link resolve} plus where the language came from (see {@link LangSource}). Never rejects. */
  async resolveDetailed(ctx: MessageContext): Promise<{ lang: string; source: LangSource }> {
    if (!this.enabled) return { lang: this.defaultCode, source: 'default' }
    const stored = this.supported(await this.preferenceOf(ctx.user))
    if (stored) return { lang: stored, source: 'user' }
    if (this.useProviderLanguage) {
      const fromProvider = this.supported(this.reportedLanguage(ctx))
      if (fromProvider) return { lang: fromProvider, source: 'provider' }
    }
    if (this.detector) {
      try {
        const detected = this.supported(await this.detector(ctx))
        if (detected) return { lang: detected, source: 'detector' }
      } catch (err) {
        this.logger?.debug?.({ err }, 'i18n: language detector failed')
      }
    }
    return { lang: this.defaultCode, source: 'default' }
  }

  /** Whether a custom detector is configured (its answer may depend on `ctx.body`). */
  get hasDetector(): boolean { return this.detector !== undefined }

  /**
   * The stored preference of a profile (the registered locale serving it), else
   * the default locale. Agrees with {@link resolve}: while i18n is not
   * {@link enabled} it is always the default. Never rejects.
   */
  async languageOf(user: UserData): Promise<string> {
    if (!this.enabled) return this.defaultCode
    return this.supported(await this.preferenceOf(user)) ?? this.defaultCode
  }

  /**
   * The language the provider reports for this update, else the last one it reported
   * for the same sender: some transports omit it on some updates (Telegram's optional
   * `language_code`), and a chat must not flip to the default between turns. Kept in
   * memory, bounded (least recently seen senders are forgotten first).
   */
  private reportedLanguage(ctx: MessageContext): string | undefined {
    const sender = typeof ctx.sender === 'string' && ctx.sender !== '' ? ctx.sender : undefined
    const now = providerLanguageOf(ctx.senderInfo)
    if (sender === undefined) return now
    const lang = now ?? this.reported.get(sender)
    if (lang !== undefined) {
      this.reported.delete(sender)
      this.reported.set(sender, lang)
      if (this.reported.size > MAX_REPORTED) this.reported.delete(this.reported.keys().next().value as string)
    }
    return lang
  }

  private async preferenceOf(user: UserData | undefined): Promise<string | undefined> {
    if (!user) return undefined
    try {
      return normalizeLocale(await user.get(this.preferenceKey))
    } catch (err) {
      this.logger?.debug?.({ err }, 'i18n: could not read the stored language')
      return undefined
    }
  }

  private render(leaf: Leaf, lang: string, params?: TranslateParams): string {
    if (typeof leaf === 'string') return interpolate(leaf, params)
    const count = params?.count
    let text = leaf.other
    if (typeof count === 'number' && Number.isFinite(count)) {
      if (count === 0 && leaf.zero !== undefined) text = leaf.zero
      else text = leaf[this.pluralOf(lang).select(count)] ?? leaf.other
    }
    return interpolate(text, params)
  }

  private pluralOf(lang: string): Intl.PluralRules {
    let rules = this.pluralRules.get(lang)
    if (!rules) {
      try { rules = new Intl.PluralRules(lang) }
      catch { rules = new Intl.PluralRules('en') }
      this.pluralRules.set(lang, rules)
    }
    return rules
  }
}

/** Registry used by contexts and conversations built without a Bot (built-ins only, `es`). */
export const defaultI18n = new I18n()

/** Something that may carry a bound translator (a `MessageContext`, a `RuntimeMessage`). */
export interface Translatable {
  lang?: string
  t?(key: string, params?: TranslateParams): string
}

/** Translate through `msg.t` when present, else the built-in registry in `msg.lang`. */
export function translateFor(msg: Translatable | undefined, key: string, params?: TranslateParams): string {
  if (msg && typeof msg.t === 'function') return msg.t(key, params)
  return defaultI18n.translate(msg?.lang, key, params)
}
