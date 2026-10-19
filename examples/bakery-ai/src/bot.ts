/**
 * createBakeryBot — the channel-agnostic bot. The entry points build a
 * provider (Baileys or Twilio) and hand it here; tests hand a MockProvider.
 */
import { Bot, slashCommandsPlugin, type IProvider, type LoggerLike } from '@bot-wa/core'
import { aiPlugin, type AIProvider, type AIProviderName, type AIToolEvent } from '@bot-wa/ai'
import { createBakeryTools } from './tools.js'
import { InMemoryOrderStore, type Order, type OrderStore } from './shop.js'

export const BAKERY_NAME = 'Demo Bakery'

/**
 * The assistant's instructions. Scoped to the business on purpose: since
 * 2026-01-15 WhatsApp only allows AI that serves the business (support,
 * sales, bookings), not general-purpose chatbots. To localize the bot, write
 * this in the customers' language (and see README → Localization).
 */
export const PERSONA = [
  `You are the WhatsApp assistant of "${BAKERY_NAME}", a neighborhood bakery.`,
  'Answer briefly and in English, and only about the bakery: menu, prices, orders and opening hours',
  '(Monday to Saturday, 7am to 7pm; closed on Sunday).',
  'Use the tools to look up the menu and to quote, place, list, change and cancel orders.',
  'Never calculate prices or totals yourself: use quote_order and repeat the totals the tools return.',
  'Refer to products by their names (for example "Cheese bread"), never by their ids.',
  'If the customer asks for something unrelated to the bakery, politely say you can only help with the bakery.',
].join(' ')

export const GREETING = `Hi! I'm the ${BAKERY_NAME} assistant 🥐 Ask me about the menu or tell me what you'd like to order.`

export interface BakeryAIOptions {
  /** `@bot-wa/ai` provider name or preset (`ollama`, `anthropic`, `openai`, `gemini`, `deepseek`, `groq`...). Default `'ollama'`. */
  provider?: AIProviderName
  model?: string
  apiKey?: string
  baseUrl?: string
  /** Per model call, ms. Default 120 000 (local models can be slow). */
  timeoutMs?: number
  /** Long-term per-user memory (facts like "prefers decaf"). Default true. */
  memory?: boolean
}

export interface BakeryBotOptions {
  ai?: BakeryAIOptions
  /** Pre-built AI provider (tests use `MockAIProvider`); wins over `ai.provider`. */
  aiProvider?: AIProvider
  /** Where orders live. Default: a fresh {@link InMemoryOrderStore}. */
  orders?: OrderStore
  /**
   * Allow-list of sender/chat ids (exactly as the channel reports them). When
   * non-empty, everybody else is ignored, before any handler or AI call.
   */
  allowedUsers?: readonly string[]
  /** How the bot behaves in groups. Default `'commands'` (only `/commands`, no AI). */
  groupMode?: 'all' | 'mentions' | 'commands'
  logger?: LoggerLike
}

/** Build the bakery bot on `provider`. Call `bot.start()` to connect. */
export function createBakeryBot(provider: IProvider, options: BakeryBotOptions = {}): Bot {
  const ai = options.ai ?? {}
  const orders = options.orders ?? new InMemoryOrderStore()
  const log = options.logger

  const bot = new Bot({
    provider,
    groupMode: options.groupMode ?? 'commands',
    // English built-in texts (slash commands, AI confirmation prompts, Yes/No buttons...),
    // pinned so they always match the English persona: a client that reports another
    // language (e.g. Telegram's language_code "es") still gets English. To make the bot
    // bilingual, see README → Localization.
    i18n: { defaultLocale: 'en', locales: ['en'] },
    ...(log ? { logger: log } : {}),
  })

  const allowed = options.allowedUsers ?? []
  if (allowed.length > 0) bot.whitelist.add(allowed).enable()

  // Order matters: the slash commands go first, the AI catch-all last.
  bot.plug(slashCommandsPlugin, {
    greeting: GREETING,
    unknownMessage: 'Unknown command. Try /help, or just tell me what you would like.',
  })

  bot.plug(aiPlugin({
    ...(options.aiProvider ? { __provider: options.aiProvider } : {}),
    provider: ai.provider ?? 'ollama',
    ...(ai.model ? { model: ai.model } : {}),
    ...(ai.apiKey ? { apiKey: ai.apiKey } : {}),
    ...(ai.baseUrl ? { baseUrl: ai.baseUrl } : {}),
    persona: PERSONA,
    timeoutMs: ai.timeoutMs ?? 120_000,
    maxSteps: 5,
    memory: ai.memory === false ? false : { autoExtract: true, maxFacts: 20 },
    errorMessage: "⚠️ Sorry, I can't answer right now. Please try again in a moment.",
    refusalMessage: "Sorry, I can't help with that. I can help you with our menu and your orders.",
    tools: createBakeryTools(orders, { onOrderChange: (change) => logOrder(log, change) }),
    onToolEvent: (event) => logToolEvent(log, event),
  }))

  return bot
}

/** Audit trail of the tool loop. Metadata only: tool arguments can carry user data. */
function logToolEvent(log: LoggerLike | undefined, event: AIToolEvent): void {
  log?.info({ type: event.type, tool: event.tool, step: event.step, durationMs: event.durationMs, error: event.error }, 'ai tool')
}

function logOrder(log: LoggerLike | undefined, change: { action: string; order: Order }): void {
  log?.info({ action: change.action, orderId: change.order.id, total: change.order.total }, 'order changed')
}
