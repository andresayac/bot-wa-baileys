/**
 * whenIntent — bind an intent handler to a Bot via a predicate trigger.
 *
 * `bot.when` accepts a predicate `(ctx: { body, isGroup }) => boolean`; this
 * helper builds that predicate from an {@link IntentEngine} so the handler
 * runs ONLY when the incoming text's best match is the given intent (above
 * the engine threshold). Messages that don't match — or whose best match is
 * a different intent — simply fall through to other matchers / `onMessage`.
 */

import type { Bot, MessageContext } from '@bot-wa/core'
import type { IntentEngine, IntentMatch } from './IntentEngine.js'

/** Handler for an intent-matched message; receives the context plus the match result. */
export type IntentHandler = (ctx: MessageContext, match: IntentMatch) => unknown | Promise<unknown>

/**
 * Register `handler` to run when the best intent match of the incoming text
 * is `intent` (confidence ≥ the engine threshold). Returns an unsubscribe
 * function, just like `bot.when`.
 *
 * @example
 * ```ts
 * const nlu = new IntentEngine()
 * nlu.define('greeting', ['hola', 'buenas'])
 *
 * whenIntent(bot, nlu, 'greeting', async (ctx, match) => {
 *   await ctx.reply(`¡Hola! (confianza ${match.confidence.toFixed(2)})`)
 * })
 * bot.onMessage((ctx) => ctx.reply('No entendí 🤔')) // unmatched falls through to here
 * ```
 */
export function whenIntent(
  bot: Pick<Bot, 'when'>,
  engine: IntentEngine,
  intent: string,
  handler: IntentHandler,
): () => void {
  return bot.when(
    (c) => engine.match(c.body)?.intent === intent,
    (ctx) => {
      const match = engine.match(ctx.body)
      if (match && match.intent === intent) return handler(ctx, match)
      ctx.pass() // defensive: predicate and match disagree (cannot happen with a deterministic engine)
    },
  )
}
