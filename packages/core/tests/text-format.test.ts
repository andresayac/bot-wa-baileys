import { describe, it, expect } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { MockProvider, type MockProviderOptions } from '../src/testing/MockProvider.js'
import { ChaosProvider } from '../src/testing/chaos.js'
import type { ChatId, MessageContext, TextFormat } from '../src/core/provider.js'

/** Twilio-like routing: `whatsapp:` chats render WhatsApp markup, the rest is unknown. */
const perChat = (chatId: ChatId): TextFormat | undefined => (chatId.startsWith('whatsapp:') ? 'whatsapp' : undefined)

async function formatsSeen(options: MockProviderOptions, chats: string[]): Promise<Array<TextFormat | undefined>> {
  const provider = new MockProvider(options)
  const bot = new Bot({ provider })
  const seen: Array<TextFormat | undefined> = []
  bot.onMessage((ctx: MessageContext) => { seen.push(ctx.textFormat) })
  await bot.start()
  for (const from of chats) {
    provider.incoming('hola', { from })
    await new Promise((r) => setTimeout(r, 0))
  }
  await bot.stop()
  return seen
}

describe('per-chat text format (IProvider.textFormatFor → ctx.textFormat)', () => {
  it('MockProvider exposes textFormatFor only when given', () => {
    expect(new MockProvider().textFormatFor).toBeUndefined()
    const p = new MockProvider({ textFormatFor: perChat })
    expect(p.textFormatFor?.('whatsapp:+1')).toBe('whatsapp')
    expect(p.textFormatFor?.('+1')).toBeUndefined()
  })

  it('ctx.textFormat is the chat format, falling back to capabilities.textFormat', async () => {
    const seen = await formatsSeen({ textFormat: 'plain', textFormatFor: perChat }, ['whatsapp:+1', '+1'])
    expect(seen).toEqual(['whatsapp', 'plain'])
  })

  it('without textFormatFor ctx.textFormat mirrors capabilities.textFormat (or is unset)', async () => {
    expect(await formatsSeen({ textFormat: 'whatsapp' }, ['a'])).toEqual(['whatsapp'])
    expect(await formatsSeen({}, ['a'])).toEqual([undefined])
    expect(await formatsSeen({ textFormatFor: perChat }, ['a'])).toEqual([undefined])
  })

  it('ChaosProvider forwards textFormatFor', () => {
    const chaos = new ChaosProvider(new MockProvider({ textFormatFor: perChat }))
    expect(chaos.textFormatFor?.('whatsapp:+1')).toBe('whatsapp')
    expect(new ChaosProvider(new MockProvider()).textFormatFor).toBeUndefined()
  })
})
