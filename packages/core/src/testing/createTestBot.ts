/**
 * createTestBot — spin up a {@link Bot} wired to a {@link MockProvider} for tests.
 *
 * No sockets, no filesystem. The returned `chat` drives one DM (`user@s.whatsapp.net`)
 * and asserts on what the bot sent back; `dm()` and `group()` open other chats and
 * `chat.as(userId)` is the same chat seen by another participant.
 *
 * @example
 * ```ts
 * const { bot, chat } = await createTestBot()
 * bot.when('hola', async (ctx) => await ctx.reply('👋'))
 * await chat.send('hola')
 * await chat.expectReply('👋')
 * await chat.expectNoReply()
 * expect(chat.transcript()).toMatchSnapshot()
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
import { MockProvider, type MockProviderOptions } from './MockProvider.js'
import { ChaosProvider, type ChaosOptions } from './chaos.js'
import { DEFAULT_TEST_USER, TestChatFactory, type TestChat } from './testChat.js'
import type { BotConfig } from '../core/provider.js'

export type { TestChat } from './testChat.js'

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
  /** The MockProvider (drive inbound traffic and read `outbox` / `journal` here). */
  provider: MockProvider
  /** The default DM (`user@s.whatsapp.net`). */
  chat: TestChat
  /** The chaos wrapper the bot talks to — present only when `options.chaos` was given. */
  chaos?: ChaosProvider<MockProvider>
  /** Another DM chat (`chatId === senderId === userId`). */
  dm(userId: string, opts?: { displayName?: string }): TestChat
  /** A group chat driven by participant `as` (default `'user@s.whatsapp.net'`); `chat.as(other)` adds participants. */
  group(groupId: string, opts?: { as?: string; displayName?: string }): TestChat
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

  const chats = new TestChatFactory(provider)
  const base: TestBot = {
    bot,
    provider,
    chat: chats.dm(DEFAULT_TEST_USER),
    dm: (userId, opts) => chats.dm(userId, opts),
    group: (groupId, opts) => chats.group(groupId, opts),
  }
  return chaos ? { ...base, chaos } : base
}
