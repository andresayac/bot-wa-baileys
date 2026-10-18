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
 * With `tools`, the model can call bot functions natively (multi-step loop with
 * `maxSteps`, per-tool timeout, errors fed back to the model, audit events on
 * `bot.on('ai.tool')`). `confirm: true` tools ask the user first through a
 * runtime conversation, so the chat's FIFO queue is never blocked while waiting.
 *
 * @example
 * ```ts
 * import { aiPlugin } from '@bot-wa/ai'
 *
 * bot.plug(aiPlugin({ provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }))
 * ```
 */

import { definePlugin, type MessageContext, type PluginContext, type PluginSpec } from '@bot-wa/core'
import type { AIConfig, AIProvider } from './types.js'
import { ContextManager } from './ContextManager.js'
import { AIClient } from './AIClient.js'
import { resolveProvider } from './providers/resolve.js'
import { LazyProvider } from './providers/LazyProvider.js'
import { chatKeyOf } from './chatKey.js'
import { AIToolCancelledError, type AIToolEvent } from './tools/types.js'
import { suspendingConfirmer } from './tools/autoreplyConfirm.js'

/** Public config for {@link aiPlugin}. */
export type AIPluginConfig = AIConfig & {
  /** @internal test-only injection hook — pre-built provider, bypasses lazy resolution. */
  __provider?: AIProvider
}

const DEFAULT_ERROR_MESSAGE = '⚠️ Ahora no puedo responder, intenta luego.'
const DEFAULT_RESET_REPLY = '✅ Conversación reiniciada.'
const DEFAULT_CONFIRM_TIMEOUT = '2m'

interface InflightTurn {
  done: Promise<void>
  waiting: () => boolean
  abort: () => void
}

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
        tools: cfg.tools,
        maxSteps: cfg.maxSteps,
        toolTimeoutMs: cfg.toolTimeoutMs,
        maxStepsMessage: cfg.maxStepsMessage,
        onToolEvent: (event: AIToolEvent) => {
          // Audit trail: metadata only in the log (no args / results), full event to sinks.
          ctx.logger.debug({ tool: event.tool, type: event.type, step: event.step, durationMs: event.durationMs }, 'ai tool event')
          bot.emit('ai.tool', event)
          cfg.onToolEvent?.(event)
        },
      })
      bot.provide('ai', client)
      // Remove the injected tool on unplug so `ctx.tools.ai` doesn't outlive the plugin.
      // (Reflect: the DefaultTools augmentation types `ai` as required, so `delete` won't type-check.)
      ctx.onDispose(() => { Reflect.deleteProperty(ctx.tools, 'ai') })

      const errorMessage = cfg.errorMessage ?? DEFAULT_ERROR_MESSAGE

      // Tool turns that may outlive their handler (detached after a confirmation), per chat key.
      const inflight = new Map<string, InflightTurn>()
      // Latest autoreply turn per chat key: an older detached turn must not ask again.
      const generation = new Map<string, number>()
      // Global, monotonic turn counter: ids are never reused, even after `/reset` drops a key.
      let turnSeq = 0

      if (cfg.autoReply !== false) {

        bot.onMessage(async (mctx: MessageContext) => {
          if (mctx.type !== 'text' || !mctx.body) return
          const key = chatKeyOf(mctx)
          const body = mctx.body
          const gen = ++turnSeq
          if (client.hasTools) generation.set(key, gen)
          // Serialise turns per chat: let a detached turn finish before starting a new one
          // on the same history. It cannot deadlock: once superseded it no longer asks for
          // confirmations (and one already waiting would have received this message).
          const prev = inflight.get(key)
          if (prev && !prev.waiting()) await prev.done
          // With tools, a `confirm: true` call must wait for the user's answer. That wait
          // happens in a runtime conversation, so the turn may outlive this handler: race
          // the turn against "suspended" and return as soon as a confirmation is pending,
          // releasing the chat's FIFO queue (awaiting here would deadlock it).
          const confirmer = client.hasTools
            ? suspendingConfirmer(bot, mctx, {
                yes: cfg.toolConfirm?.yes,
                timeout: cfg.toolConfirm?.timeout ?? DEFAULT_CONFIRM_TIMEOUT,
                canAsk: () => generation.get(key) === gen,
              })
            : undefined
          // Lets `/reset` cancel the turn even after its confirmation was answered.
          const abort = new AbortController()
          const turn = (async () => {
            try {
              if (cfg.humanizeTyping !== false) await mctx.typing()
              const text = await client.replyInChat(key, body, {
                ctx: mctx,
                confirm: confirmer?.confirm,
                ...(confirmer ? { signal: abort.signal } : {}),
              })
              // A detached turn must not talk over a flow the user started meanwhile.
              if (confirmer?.isDetached() && bot.inspectConversation(mctx) !== undefined) {
                ctx.logger.debug('ai autoreply dropped: a conversation is active on the chat')
                return
              }
              await mctx.reply(text)
            } catch (err) {
              // Cancelled confirmation or turn (/reset, timeout, superseded turn): nothing to say.
              if (err instanceof AIToolCancelledError || abort.signal.aborted) return
              ctx.logger.warn({ err }, 'ai autoreply failed')
              await mctx.reply(errorMessage).catch(() => {})
            }
          })()
          if (!confirmer) return turn
          const entry: InflightTurn = {
            done: turn.finally(() => {
              if (inflight.get(key) === entry) inflight.delete(key)
              if (generation.get(key) === gen) generation.delete(key)
            }),
            waiting: () => confirmer.isWaiting(),
            abort: () => abort.abort(),
          }
          inflight.set(key, entry)
          await Promise.race([entry.done, confirmer.suspended])
        })
      }

      if (cfg.resetCommand !== false) {
        bot.command('reset', async (mctx: MessageContext) => {
          const key = chatKeyOf(mctx)
          // Cancel a detached tool turn first, so it neither asks again, nor writes the
          // stale turn into the history cleared below, nor replies.
          inflight.get(key)?.abort()
          generation.delete(key)
          await ctxMgr.clear(key)
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
