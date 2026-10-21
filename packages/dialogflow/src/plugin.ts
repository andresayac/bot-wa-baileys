/**
 * dialogflowPlugin (alias `dialogflowContext`) — run every inbound text
 * through Dialogflow ES/CX in a `before('message')` hook and route intents to
 * handlers or flows.
 *
 * `install` is synchronous: it only validates the config and builds the
 * client (the private key is parsed here, so a broken key fails at `plug()`
 * time). The access token is fetched lazily on the first message.
 *
 * @example
 * ```ts
 * import { dialogflowContext, whenDialogflowIntent } from '@botmesh/dialogflow'
 *
 * bot.plug(dialogflowContext({
 *   credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS!),
 *   languageCode: 'es',
 *   routes: { 'order.status': orderFlow },
 *   fulfillment: 'unrouted',
 * }))
 * ```
 */

import { definePlugin, type MessageContext, type PluginSpec } from '@botmesh/core'
import type { DialogflowClient, DialogflowClientConfig } from './client.js'
import { DialogflowContext, type DialogflowContextOptions } from './context.js'
import { whenDialogflowIntent, type IntentTarget } from './whenDialogflowIntent.js'

export interface DialogflowPluginConfig extends DialogflowClientConfig, DialogflowContextOptions {
  /** A prebuilt client (otherwise one is built from this config). */
  client?: DialogflowClient
  /** Intent display name → handler / flow. Same as calling `whenDialogflowIntent` for each. */
  routes?: Record<string, IntentTarget>
  /**
   * Auto-reply with Dialogflow's own text responses: `'off'` (default),
   * `'unrouted'` (matched intents without a route) or `'all'` (also the
   * fallback / no-match responses — this swallows messages your `onMessage` would get).
   */
  fulfillment?: 'off' | 'unrouted' | 'all'
  /** Skip messages starting with this prefix (default `'/'`); `false` sends commands too. */
  commandPrefix?: string | false
  /** Skip messages while the sender is inside a conversation (default `true`). Chats in handoff are always skipped. */
  skipActiveConversation?: boolean
  /** Return `false` to skip Dialogflow for a message. */
  filter?: (ctx: MessageContext) => boolean
  /** Before-hook priority (default `0`; moderation runs at `100`). */
  priority?: number
  /** Called when detectIntent fails (the message still flows to other handlers). */
  onError?: (error: unknown, ctx: MessageContext) => void
}

/** Build the Dialogflow plugin for `bot.plug(...)`. */
export function dialogflowPlugin(config: DialogflowPluginConfig): PluginSpec<DialogflowPluginConfig> {
  return definePlugin<DialogflowPluginConfig>({
    name: 'dialogflow',
    version: '0.1.0',
    description: 'Dialogflow ES/CX intent detection and intent-to-flow routing.',
    install(ctx) {
      const { bot, logger } = ctx
      const df = new DialogflowContext(config.client ?? config, config)
      ctx.tools.dialogflow = df
      const prefix = config.commandPrefix ?? '/'

      bot.before(
        'message',
        async (mctx: MessageContext, next: () => Promise<void>) => {
          if (shouldDetect(mctx)) {
            try {
              await df.detect(mctx)
            } catch (error) {
              logger.warn({ err: error }, 'dialogflow: detectIntent failed')
              try { config.onError?.(error, mctx) } catch { /* reporting must not break routing */ }
            }
          }
          await next()
        },
        config.priority ?? 0,
      )

      function shouldDetect(mctx: MessageContext): boolean {
        if (!mctx.body || !mctx.body.trim() || mctx.interaction) return false
        if (prefix !== false && mctx.body.startsWith(prefix)) return false
        // A human owns a handed-off chat: the dispatcher will not route the message, so
        // spending a detectIntent call (and leaking the text to Google) is pointless.
        if (bot.isHandedOff(mctx.from)) return false
        if (config.filter && !config.filter(mctx)) return false
        if ((config.skipActiveConversation ?? true) && bot.inspectConversation({ from: mctx.from, sender: mctx.sender, isGroup: mctx.isGroup })) {
          return false
        }
        return true
      }

      for (const [intent, target] of Object.entries(config.routes ?? {})) {
        whenDialogflowIntent(bot, df, intent, target)
      }

      const mode = config.fulfillment ?? 'off'
      if (mode !== 'off') {
        bot.when(
          (c) => {
            const r = df.resultFor(c)
            if (!r || r.messages.length === 0) return false
            if (r.intent === null || r.isFallback) return mode === 'all'
            return !df.isRouted(r.intent) && r.confidence >= df.minConfidence
          },
          async (mctx) => {
            for (const text of df.resultFor(mctx)?.messages ?? []) await mctx.reply(text)
          },
        )
      }
    },
  })
}

/** FEATURES #31 naming: `bot.plug(dialogflowContext({...}))`. */
export const dialogflowContext = dialogflowPlugin
