/**
 * nluPlugin — install an {@link IntentEngine} on a Bot.
 *
 * Exposes the engine as `ctx.tools.nlu` (typed via module augmentation of
 * `@bot-wa/core`'s `DefaultTools`) and optionally seeds it with intents from
 * config. Pair it with {@link whenIntent} to route messages by intent.
 *
 * @example
 * ```ts
 * import { nluPlugin, whenIntent, type IntentEngine } from '@bot-wa/nlu'
 *
 * bot.plug(nluPlugin, {
 *   threshold: 0.5,
 *   intents: {
 *     greeting: ['hola', 'buenas'],
 *     'order.status': ['mi pedido {id}', 'estado de mi pedido'],
 *   },
 * })
 *
 * const nlu = bot.injectTools.nlu as IntentEngine
 * whenIntent(bot, nlu, 'greeting', (ctx) => ctx.reply('¡Hola! 👋'))
 * ```
 */

import { definePlugin } from '@bot-wa/core'
import { IntentEngine } from './IntentEngine.js'

export interface NluPluginConfig {
  /** Minimum confidence for matches (default `0.5`). */
  threshold?: number
  /** Seed intents: `{ intentName: [utterance, ...] }`. Slot syntax `{name}` is supported. */
  intents?: Record<string, string[]>
}

export const nluPlugin = definePlugin<NluPluginConfig>({
  name: 'nlu',
  version: '0.1.0',
  description: 'Lightweight local intent matching for @bot-wa/core — no external services.',
  install(ctx, config = {}) {
    const engine = new IntentEngine({ threshold: config.threshold })
    for (const [intent, utterances] of Object.entries(config.intents ?? {})) {
      engine.define(intent, utterances)
    }
    ctx.tools.nlu = engine
    ctx.logger.debug({ intents: engine.intents(), threshold: engine.threshold }, 'nlu engine installed')
  },
})
