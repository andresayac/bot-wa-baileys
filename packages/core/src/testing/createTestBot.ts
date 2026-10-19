/**
 * createTestBot — spin up a {@link Bot} wired to a {@link MockProvider} for tests.
 *
 * No sockets, no filesystem. The returned `chat` drives a single conversation and
 * asserts on the outbox (text, captions and the text of buttons/lists).
 *
 * @example
 * ```ts
 * const { bot, chat } = await createTestBot()
 * bot.when('hola', async (ctx) => await ctx.reply('👋'))
 * await chat.send('hola')
 * await chat.expectReply('👋')
 * ```
 *
 * Pass `{ chaos }` to put a seeded {@link ChaosProvider} between the mock and
 * the bot (duplicates, reordering, latency, send failures, drops, aliases):
 *
 * ```ts
 * const { bot, provider, chaos } = await createTestBot({}, { chaos: { seed: 7, duplicates: 1 } })
 * provider.incoming('hola')   // drive the mock as usual; chaos sits in between
 * await chaos.settle()
 * ```
 */

import { Bot } from '../core/Bot.js'
import { MockProvider, type MockOutgoing, type MockProviderOptions } from './MockProvider.js'
import { ChaosProvider, type ChaosOptions } from './chaos.js'
import type { BotConfig } from '../core/provider.js'

/** Extra knobs for {@link createTestBot}. */
export interface CreateTestBotOptions {
  /** Wrap the MockProvider in a {@link ChaosProvider} with these options. */
  chaos?: ChaosOptions
  /** Options for the underlying {@link MockProvider} (e.g. `{ streaming: 'edit' }`). */
  provider?: MockProviderOptions
}

/** What {@link createTestBot} returns. */
export interface TestBot {
  bot: Bot
  /** The MockProvider (drive inbound traffic and read `outbox` here). */
  provider: MockProvider
  chat: TestChat
  /** The chaos wrapper the bot talks to — present only when `options.chaos` was given. */
  chaos?: ChaosProvider<MockProvider>
}

export interface TestChat {
  jid: string
  /** Simulate an inbound message from this chat, then drain the dispatch microtasks. */
  send(text: string, opts?: { type?: string }): Promise<void>
  /** Resolve with the first reply matching `matcher` (already sent or arriving before the timeout). */
  expectReply(matcher: string | RegExp, timeoutMs?: number): Promise<string>
  /** Snapshot of all text/caption replies sent to this chat so far (buttons and lists: their text). */
  replies(): string[]
}

/** Extract the human-readable text/caption from an outbound content descriptor (the body of buttons and lists too). */
function textOf(m: MockOutgoing): string {
  const c = m.content
  if (c.kind === 'text' || c.kind === 'buttons' || c.kind === 'list') return c.text
  if ('caption' in c && typeof c.caption === 'string') return c.caption
  return ''
}

export async function createTestBot(config?: Omit<BotConfig, 'provider'>, options?: CreateTestBotOptions & { chaos?: undefined }): Promise<TestBot>
export async function createTestBot(
  config: Omit<BotConfig, 'provider'> | undefined,
  options: CreateTestBotOptions & { chaos: ChaosOptions },
): Promise<TestBot & { chaos: ChaosProvider<MockProvider> }>
export async function createTestBot(
  config: Omit<BotConfig, 'provider'> = {},
  options: CreateTestBotOptions = {},
): Promise<TestBot> {
  const provider = new MockProvider(options.provider)
  const chaos = options.chaos ? new ChaosProvider(provider, options.chaos) : undefined
  const bot = new Bot({ ...config, provider: chaos ?? provider })
  await bot.start()

  const jid = 'user@s.whatsapp.net'
  let cursor = 0
  const forJid = () => provider.outbox.filter((m) => m.chatId === jid)

  const chat: TestChat = {
    jid,
    async send(text, opts) {
      provider.incoming(text, { from: jid, type: opts?.type as never })
      await new Promise((r) => setTimeout(r, 0))
    },
    replies: () => forJid().map(textOf),
    expectReply(matcher, timeoutMs = 1000) {
      const matches = (s: string) => (typeof matcher === 'string' ? s.includes(matcher) : matcher.test(s))
      return new Promise<string>((resolve, reject) => {
        const scan = forJid()
        for (; cursor < scan.length; cursor++) {
          const t = textOf(scan[cursor])
          if (matches(t)) { cursor++; return resolve(t) }
        }
        const timer = setTimeout(() => {
          reject(new Error(`No reply matching ${String(matcher)} within ${timeoutMs}ms. Outbox: ${JSON.stringify(chat.replies())}`))
        }, timeoutMs)
        const iv = setInterval(() => {
          const s = forJid()
          for (; cursor < s.length; cursor++) {
            const t = textOf(s[cursor])
            if (matches(t)) { cursor++; clearTimeout(timer); clearInterval(iv); return resolve(t) }
          }
        }, 5)
      })
    },
  }
  return chaos ? { bot, provider, chat, chaos } : { bot, provider, chat }
}
