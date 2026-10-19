/**
 * Leak regressions for the AI autoreply with tool confirmations (see the core
 * soak harness, `pnpm bench:soak`): pending confirmations, timeouts, presses and
 * `/reset` must leave no live conversation, and `bot.stop()` no active timer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutboundContent } from '@bot-wa/core'
import { createTestBot } from '@bot-wa/core/testing'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { aiPlugin } from '../src/plugin.js'
import type { GenerateInput } from '../src/types.js'

type ButtonsContent = Extract<OutboundContent, { kind: 'buttons' }>

const model = () => new MockAIProvider({
  reply: (input: GenerateInput) => {
    const last = input.messages[input.messages.length - 1]
    if (last?.role === 'tool') return `resultado: ${last.results.map((r) => r.content).join(' | ')}`
    if (last?.role === 'user' && last.content.includes('borra')) return { toolCalls: [{ name: 'borrar', args: { n: last.content.length } }] }
    return `eco: ${last?.content ?? ''}`
  },
})

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => { vi.useRealTimers() })

async function setup() {
  vi.useFakeTimers()
  const { bot, provider } = await createTestBot()
  bot.plug(aiPlugin({
    __provider: model(),
    tools: { borrar: { description: 'Borra', confirm: true, handler: () => 'borrado' } },
    toolConfirm: { timeout: '1m' },
  }))
  const buttonsFor = (chat: string) => provider.outbox
    .filter((m) => m.chatId === chat && m.content.kind === 'buttons')
    .map((m) => m.content as ButtonsContent)
  return { bot, provider, buttonsFor }
}

describe('ai soak regressions', () => {
  it('many confirmation turns (yes / no / typed / timeout / reset / stale press) leave nothing live', async () => {
    const { bot, provider, buttonsFor } = await setup()
    const chats = Array.from({ length: 60 }, (_, i) => `chat-${i}`)
    for (const chat of chats) provider.incoming('borra el pedido', { from: chat })
    await settle()
    chats.forEach((chat, i) => {
      const b = buttonsFor(chat)[0]
      expect(b).toBeDefined()
      switch (i % 6) {
        case 0: provider.interaction(b!.buttons[0]!.id, { from: chat }); break
        case 1: provider.interaction(b!.buttons[1]!.id, { from: chat }); break
        case 2: provider.incoming('sí', { from: chat }); break
        case 3: break // left to time out
        case 4: provider.incoming('/reset', { from: chat }); break
        case 5: provider.interaction(b!.buttons[0]!.id, { from: chat }); provider.interaction(b!.buttons[1]!.id, { from: chat }); break
      }
    })
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(bot.listConversations()).toEqual([])
    expect(bot.isBusy()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await bot.stop()
  })

  it('bot.stop() with confirmations pending leaves no timers and no conversations', async () => {
    const { bot, provider } = await setup()
    for (let i = 0; i < 20; i++) provider.incoming('borra', { from: `c-${i}` })
    await settle()
    expect(bot.listConversations()).toHaveLength(20)
    await bot.stop()
    await settle()
    expect(bot.listConversations()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
