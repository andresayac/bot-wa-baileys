/**
 * aiPlugin — installs a multi-provider AI autoresponder + `ctx.tools.ai` into a Bot.
 *
 * On install it resolves the provider (or accepts one already built via the
 * TEST-ONLY `__provider` hook), wires a {@link ContextManager} on top of the
 * bot's store, builds an {@link AIClient} and injects it as `ctx.tools.ai`.
 * Unless disabled it also registers a catch-all autoresponder (`onMessage`,
 * text-only) and a `/reset` command that clears the chat's AI context.
 *
 * @example
 * ```ts
 * import { aiPlugin } from '@bot-wa/ai'
 *
 * bot.plug(aiPlugin({ provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }))
 * ```
 */

import { definePlugin, type MessageContext, type PluginContext, type PluginSpec } from '@bot-wa/bot-wa-baileys'
import type { AIConfig, AIProvider } from './types.js'
import { ContextManager } from './ContextManager.js'
import { AIClient } from './AIClient.js'
import { resolveProvider } from './providers/resolve.js'
import { chatKeyOf } from './chatKey.js'

/** Public config for {@link aiPlugin}. `__provider` is a TEST-ONLY injection hook. */
export type AIPluginConfig = AIConfig & { __provider?: AIProvider }

const DEFAULT_ERROR_MESSAGE = '⚠️ Ahora no puedo responder, intenta luego.'
const DEFAULT_RESET_REPLY = '✅ Conversación reiniciada.'

export function aiPlugin(config: AIPluginConfig = {}): PluginSpec<AIPluginConfig> {
  return definePlugin<AIPluginConfig>({
    name: 'ai',
    version: '0.1.0',
    description: 'Multi-provider AI autoresponder + ctx.tools.ai',
    async install(ctx: PluginContext, cfg: AIPluginConfig = config) {
      const bot = ctx.bot
      const provider = cfg.__provider ?? (await resolveProvider(cfg))
      const ctxMgr = new ContextManager(bot.getStore(), { maxMessages: cfg.context?.maxMessages })
      const client = new AIClient(provider, ctxMgr, {
        persona: cfg.persona,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        effort: cfg.effort,
        refusalMessage: cfg.refusalMessage,
      })
      bot.provide('ai', client)

      const errorMessage = cfg.errorMessage ?? DEFAULT_ERROR_MESSAGE

      if (cfg.autoReply !== false) {
        bot.onMessage(async (mctx: MessageContext) => {
          if (mctx.type !== 'text' || !mctx.body) return
          const key = chatKeyOf(mctx)
          try {
            if (cfg.humanizeTyping !== false) await mctx.typing()
            const text = await client.replyInChat(key, mctx.body)
            await mctx.reply(text)
          } catch (err) {
            ctx.logger.warn({ err }, 'ai autoreply failed')
            await mctx.reply(errorMessage)
          }
        })
      }

      if (cfg.resetCommand !== false) {
        bot.command('reset', async (mctx: MessageContext) => {
          await ctxMgr.clear(chatKeyOf(mctx))
          bot.abortConversation(mctx)
          await mctx.reply(DEFAULT_RESET_REPLY)
        })
      }
    },
  })
}
