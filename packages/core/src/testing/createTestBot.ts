/**
 * createTestBot — spin up a {@link Bot} wired to a {@link MockProvider} for tests.
 *
 * No sockets, no filesystem. The returned `chat` drives a single conversation and
 * asserts on the outbox (text + captions).
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
import { MockProvider, type MockOutgoing } from './MockProvider.js'
import type { BotConfig } from '../core/provider.js'

export interface TestChat {
  jid: string
  /** Simulate an inbound message from this chat, then drain the dispatch microtasks. */
  send(text: string, opts?: { type?: string }): Promise<void>
  /** Resolve with the first reply matching `matcher` (already sent or arriving before the timeout). */
  expectReply(matcher: string | RegExp, timeoutMs?: number): Promise<string>
  /** Snapshot of all text/caption replies sent to this chat so far. */
  replies(): string[]
}

/** Extract the human-readable text/caption from an outbound content descriptor. */
function textOf(m: MockOutgoing): string {
  const c = m.content
  if (c.kind === 'text') return c.text
  if ('caption' in c && typeof c.caption === 'string') return c.caption
  return ''
}

export async function createTestBot(
  config: Omit<BotConfig, 'provider'> = {},
): Promise<{ bot: Bot; provider: MockProvider; chat: TestChat }> {
  const provider = new MockProvider()
  const bot = new Bot({ ...config, provider })
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
  return { bot, provider, chat }
}
