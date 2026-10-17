/**
 * aiPlugin — installs a multi-provider AI autoresponder + `ctx.tools.ai` into a Bot.
 *
 * `install` is **synchronous**: it wires a {@link ContextManager} on top of the
 * bot's store, builds an {@link AIClient} on a {@link LazyProvider} and injects
 * it as `ctx.tools.ai` immediately (so `unplug()` is honoured and `ctx.tools.ai`
 * is never briefly undefined). The real provider is resolved lazily on first use
 * and, at startup, warmed up eagerly: a misconfiguration (missing SDK, unknown
 * provider, bad api key) is **logged as an error** and then degrades to the
 * configured `errorMessage` on each message — the process never crashes. A
 * pre-built provider can be injected via the TEST-ONLY `__provider` hook.
 *
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

import { definePlugin, type MessageContext, type PluginContext, type PluginSpec } from '@bot-wa/core'
import type { AIConfig, AIProvider, AIStreamConfig } from './types.js'
import { ContextManager } from './ContextManager.js'
import { AIClient } from './AIClient.js'
import { resolveProvider } from './providers/resolve.js'
import { LazyProvider } from './providers/LazyProvider.js'
import { chatKeyOf } from './chatKey.js'

/** Public config for {@link aiPlugin}. */
export type AIPluginConfig = AIConfig & {
  /** @internal test-only injection hook — pre-built provider, bypasses lazy resolution. */
  __provider?: AIProvider
}

const DEFAULT_ERROR_MESSAGE = '⚠️ Ahora no puedo responder, intenta luego.'
const DEFAULT_RESET_REPLY = '✅ Conversación reiniciada.'

export function aiPlugin(config: AIPluginConfig = {}): PluginSpec<AIPluginConfig> {
  return definePlugin<AIPluginConfig>({
    name: 'ai',
    version: '0.1.0',
    description: 'Multi-provider AI autoresponder + ctx.tools.ai',
    install(ctx: PluginContext, cfg: AIPluginConfig = config) {
      const bot = ctx.bot
      // Resolve lazily so install stays sync: a bad config can't crash the process.
      const lazy = cfg.__provider ? undefined : new LazyProvider(() => resolveProvider(cfg))
      const provider: AIProvider = cfg.__provider ?? lazy!
      const ctxMgr = new ContextManager(bot.getStore(), { maxMessages: cfg.context?.maxMessages })
      const client = new AIClient(provider, ctxMgr, {
        persona: cfg.persona,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        effort: cfg.effort,
        refusalMessage: cfg.refusalMessage,
        timeoutMs: cfg.timeoutMs,
      })
      bot.provide('ai', client)
      // Remove the injected tool on unplug so `ctx.tools.ai` doesn't outlive the plugin.
      // (Reflect: the DefaultTools augmentation types `ai` as required, so `delete` won't type-check.)
      ctx.onDispose(() => { Reflect.deleteProperty(ctx.tools, 'ai') })

      const errorMessage = cfg.errorMessage ?? DEFAULT_ERROR_MESSAGE
      const streamCfg = resolveStreamConfig(cfg.stream)

      if (cfg.autoReply !== false) {
        bot.onMessage(async (mctx: MessageContext) => {
          if (mctx.type !== 'text' || !mctx.body) return
          const key = chatKeyOf(mctx)
          if (streamCfg && typeof mctx.stream === 'function') {
            try {
              await mctx.stream(client.streamReplyInChat(key, mctx.body), {
                typing: cfg.humanizeTyping !== false,
                ...streamCfg,
              })
            } catch (err) {
              ctx.logger.warn({ err }, 'ai streamed autoreply failed')
              await mctx.reply(errorMessage)
            }
            return
          }
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

      // Surface a misconfigured provider loudly-but-non-fatally at startup: warm
      // the lazy provider so a missing SDK / unknown provider / failing SDK ctor
      // is logged now instead of silently waiting for the first message. It stays
      // non-fatal — the autoreply try/catch replies `errorMessage` per message.
      if (lazy) {
        void lazy.warmup().catch((err) => ctx.logger.error({ err }, 'ai provider failed to resolve'))
      }
    },
  })
}

/** `stream` option → the StreamOptions to use, or `undefined` when streaming is off. */
function resolveStreamConfig(stream: AIConfig['stream']): Omit<AIStreamConfig, 'enabled'> | undefined {
  if (!stream) return undefined
  if (stream === true) return {}
  const { enabled, ...opts } = stream
  return enabled === false ? undefined : opts
}
