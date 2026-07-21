/**
 * @bot-wa/nlu — lightweight, fully-local intent matching for `@bot-wa/core`.
 *
 * - {@link IntentEngine} — register intents with utterances, `match()` incoming text.
 * - {@link nluPlugin} — installs an engine as `ctx.tools.nlu` on a Bot.
 * - {@link whenIntent} — sugar over `bot.when` that fires on intent matches;
 *   unmatched messages fall through to other handlers / `onMessage`.
 *
 * @example
 * ```ts
 * import { nluPlugin, whenIntent, IntentEngine } from '@bot-wa/nlu'
 *
 * bot.plug(nluPlugin, { intents: { greeting: ['hola', 'buenas'] } })
 * whenIntent(bot, bot.injectTools.nlu as IntentEngine, 'greeting', (ctx) => ctx.reply('👋'))
 * ```
 */

import type { IntentEngine } from './IntentEngine.js'

export { IntentEngine, normalizeText } from './IntentEngine.js'
export type { IntentMatch, IntentEngineOptions } from './IntentEngine.js'
export { nluPlugin } from './nluPlugin.js'
export type { NluPluginConfig } from './nluPlugin.js'
export { whenIntent } from './whenIntent.js'
export type { IntentHandler } from './whenIntent.js'

/**
 * Augment `@bot-wa/core` so `ctx.tools.nlu` is typed once `nluPlugin` is
 * installed — no casts needed in handlers.
 */
declare module '@bot-wa/core' {
  interface DefaultTools {
    /** Present when `nluPlugin` is plugged into the Bot. */
    nlu?: IntentEngine
  }
}
