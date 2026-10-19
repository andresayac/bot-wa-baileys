/**
 * The public handler type of `bot.conversation()` (`ConversationHandler`): the full
 * `MessageContext` view of the runtime's minimal conversation function. Types only.
 */
import type { DefaultTools, MessageContext } from '../core/provider.js'
import type { ConversationControls } from './controls.js'

/**
 * Handler of `bot.conversation()`: an async function that drives one conversation.
 *
 * `ctx` is the full `MessageContext` of the message that started it — reply helpers
 * (`photo`, `poll`, `react`, `quote`…), `senderInfo`, `chat`, and `ctx.tools` typed with every
 * `DefaultTools` augmentation (e.g. `ctx.tools.nlu` once `@bot-wa/nlu` is imported). The
 * low-level `ConversationRuntime` keeps working with the minimal `RuntimeMessage`;
 * handlers written against that older, narrower type remain assignable to this one.
 * The resolved value is ignored, so `async (c, ctx) => ctx.reply('…')` is fine; the
 * conversation ends when the returned promise settles.
 *
 * @typeParam TTools - Shape of `ctx.tools`; defaults to the (augmentable) `DefaultTools`.
 *
 * @example
 * ```ts
 * bot.conversation('foto', async (c, ctx) => {
 *   const img = await c.waitMedia(['image'], { timeout: '2m' })
 *   await ctx.react('📸')
 *   await ctx.reply(`Recibida (${img.type})`)
 * })
 * ```
 */
export type ConversationHandler<TTools extends object = DefaultTools> =
  (c: ConversationControls, ctx: MessageContext<TTools>) => Promise<unknown>
