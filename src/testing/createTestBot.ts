/**
 * createTestBot — spin up a {@link Bot} wired to a {@link MockProvider} for tests.
 *
 * No sockets, no filesystem, no QR: `qr: {}` disables QR rendering and injecting a
 * provider skips BaileysProvider construction and session-dir creation entirely.
 * The returned `chat` drives a single conversation and asserts on the outbox.
 *
 * @example
 * ```ts
 * const { bot, chat } = await createTestBot()
 * bot.when('hola', async (ctx) => await ctx.reply('👋'))
 * await chat.send('hola')
 * await chat.expectReply('👋')
 * ```
 */

import { Bot } from '../core/Bot.js'
import { MockProvider } from './MockProvider.js'
import type { BotConfig, OutgoingMessage } from '../core/types.js'

export interface TestChat {
  jid: string
  /** Simulate an inbound message from this chat, then drain the dispatch microtasks. */
  send(text: string, opts?: { type?: string }): Promise<void>
  /** Resolve with the first reply matching `matcher` (already sent or arriving before the timeout). */
  expectReply(matcher: string | RegExp, timeoutMs?: number): Promise<string>
  /** Snapshot of all text replies sent to this chat so far. */
  replies(): string[]
}

export async function createTestBot(
  config: BotConfig = {},
): Promise<{ bot: Bot; provider: MockProvider; chat: TestChat }> {
  const provider = new MockProvider()
  const bot = new Bot({ session: 'test', qr: {}, ...config, provider })
  await bot.start()

  const jid = 'user@s.whatsapp.net'
  let cursor = 0
  const textOf = (m: OutgoingMessage) => String((m.content as { text?: string }).text ?? '')

  const chat: TestChat = {
    jid,
    async send(text, opts) {
      provider.incoming(text, { from: jid, type: opts?.type })
      await new Promise((r) => setTimeout(r, 0)) // drain the dispatch microtasks
    },
    replies: () => provider.outbox.filter((m) => m.jid === jid).map(textOf),
    expectReply(matcher, timeoutMs = 1000) {
      const matches = (s: string) => (typeof matcher === 'string' ? s.includes(matcher) : matcher.test(s))
      return new Promise<string>((resolve, reject) => {
        for (; cursor < provider.outbox.length; cursor++) {
          const t = textOf(provider.outbox[cursor])
          if (matches(t)) { cursor++; return resolve(t) }
        }
        const timer = setTimeout(() => {
          provider.off('sent', onSent)
          reject(new Error(`No reply matching ${String(matcher)} within ${timeoutMs}ms. Outbox: ${JSON.stringify(chat.replies())}`))
        }, timeoutMs)
        const onSent = (m: OutgoingMessage) => {
          if (m.jid !== jid) return
          const t = textOf(m)
          if (matches(t)) { clearTimeout(timer); provider.off('sent', onSent); cursor = provider.outbox.length; resolve(t) }
        }
        provider.on('sent', onSent)
      })
    },
  }
  return { bot, provider, chat }
}
