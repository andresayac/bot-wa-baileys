/**
 * Per-message language resolution (`ctx.lang` / `ctx.langSource`) of one bot: the
 * resolver shared by inbound messages and `bot.trigger()`, and the Dispatcher's
 * `prepare` / `reprepare` seams. No-ops while i18n is off; no routing.
 */
import type { I18n } from '../../i18n/I18n.js'
import type { DispatcherDeps } from '../Dispatcher.js'
import type { MessageContext } from '../types.js'
import { asMessage, type BotKernel } from './kernel.js'

/** Resolve `ctx.lang` / `ctx.langSource` (i18n must be enabled). Never rejects. */
export async function resolveLang(i18n: I18n, ctx: MessageContext): Promise<void> {
  const { lang, source } = await i18n.resolveDetailed(ctx)
  ctx.lang = lang
  ctx.langSource = source
}

/** The Dispatcher's language seams, over the kernel's `i18n` (read at call time). */
export function createLangSeams(k: Pick<BotKernel, 'i18n'>): Required<Pick<DispatcherDeps, 'prepare' | 'reprepare'>> {
  /** `ctx.lang` as `prepare` resolved it, to tell whether a hook overrode it. */
  const preparedLang = new WeakMap<object, string>()
  return {
    prepare: async (ctx) => {
      if (!k.i18n.enabled) return
      const mctx = asMessage(ctx)
      await resolveLang(k.i18n, mctx)
      preparedLang.set(mctx, mctx.lang)
    },
    // A before('message') hook rewrote ctx.body (e.g. a voice transcript): let a
    // body-based detector see the final text. Skipped when the language came from a
    // signal the body cannot change (stored preference, provider) or when a hook
    // already set ctx.lang itself.
    reprepare: async (ctx) => {
      if (!k.i18n.enabled || !k.i18n.hasDetector) return
      const mctx = asMessage(ctx)
      if (mctx.langSource !== 'detector' && mctx.langSource !== 'default') return
      if (preparedLang.get(mctx) !== mctx.lang) return
      await resolveLang(k.i18n, mctx)
    },
  }
}
