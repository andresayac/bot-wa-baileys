/**
 * whenDialogflowIntent — route a Dialogflow intent to a handler or a flow,
 * through a `bot.when` predicate (like `@botmesh/nlu`'s `whenIntent`).
 *
 * The predicate reads the result the plugin's `before('message')` hook stored
 * for the message, so it is synchronous and does not call Dialogflow again.
 * For flows, the intent parameters are copied into `c.state` before the first
 * step runs.
 */

import {
  FlowBuilder,
  isCompiledFlow,
  type Bot,
  type CompiledFlow,
  type CompiledStep,
  type MessageContext,
} from '@botmesh/core'
import type { DialogflowResult } from './client.js'
import type { DialogflowContext } from './context.js'

/** Handler for an intent-matched message; receives the context plus the Dialogflow result. */
export type DialogflowIntentHandler = (ctx: MessageContext, result: DialogflowResult) => unknown | Promise<unknown>

/** What an intent routes to. */
export type IntentTarget = DialogflowIntentHandler | FlowBuilder | CompiledFlow

export interface WhenDialogflowIntentOptions {
  /** Override the context's `minConfidence` for this route. */
  minConfidence?: number
  /** Flows only: nest the parameters under `c.state[stateKey]` instead of spreading them. */
  stateKey?: string
}

/**
 * Prepend a step that copies the matched parameters into `c.state`.
 *
 * The wrapped flow gets its own id (`<id>#dialogflow`, plus `:<stateKey>` when
 * nested). The runtime registers flows by id, so reusing the original id would
 * let a plain registration of the same flow (`bot.when`, `bot.use`) replace the
 * wrapped one or be replaced by it, and the extra step would shift the step
 * indices that `.persistent()` checkpoints are keyed on.
 */
export function withDialogflowState(flow: CompiledFlow, df: DialogflowContext, stateKey?: string): CompiledFlow {
  const inject: CompiledStep = {
    kind: 'do',
    fn: (ctx, c) => {
      const result = df.resultFor(ctx)
      if (!result) return
      if (stateKey) c.state[stateKey] = { ...result.parameters }
      else Object.assign(c.state, result.parameters)
    },
  }
  const id = `${flow.id}#dialogflow${stateKey ? `:${stateKey}` : ''}`
  return { ...flow, id, steps: [inject, ...flow.steps] }
}

/**
 * Run `target` when the message's Dialogflow intent is `intent` (or one of
 * `intent[]`) with confidence ≥ `minConfidence`. Returns an unsubscribe
 * function, like `bot.when`. Non-matching messages fall through.
 *
 * @example
 * ```ts
 * const df = bot.injectTools.dialogflow!
 * whenDialogflowIntent(bot, df, 'order.status', (ctx, r) => ctx.reply(`Pedido ${String(r.parameters.order)}`))
 * whenDialogflowIntent(bot, df, 'book.table', flow('book').ask('¿Para cuántas personas?', 'people'))
 * ```
 */
export function whenDialogflowIntent(
  bot: Pick<Bot, 'when'>,
  df: DialogflowContext,
  intent: string | readonly string[],
  target: IntentTarget,
  opts: WhenDialogflowIntentOptions = {},
): () => void {
  const intents = typeof intent === 'string' ? [intent] : [...intent]
  const predicate = (c: { body: string; isGroup: boolean }) => df.matches(df.resultFor(c), intents, opts.minConfidence)

  let unsub: () => void
  if (target instanceof FlowBuilder || isCompiledFlow(target)) {
    const compiled = target instanceof FlowBuilder ? target.compile() : target
    unsub = bot.when(predicate, withDialogflowState(compiled, df, opts.stateKey))
  } else {
    const handler = target
    unsub = bot.when(predicate, (ctx) => {
      const result = df.resultFor(ctx)
      if (result) return handler(ctx, result)
      ctx.pass()
    })
  }
  const unmark = intents.map((name) => df.markRouted(name))
  return () => {
    unsub()
    for (const u of unmark) u()
  }
}
