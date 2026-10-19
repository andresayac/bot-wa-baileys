import { describe, it, expect, vi, afterEach } from 'vitest'
import { Bot } from '@bot-wa/core'
import { TelegramProvider } from '@bot-wa/telegram'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { aiPlugin } from '../src/plugin.js'
import type { GenerateInput } from '../src/types.js'

interface Call { method: string; body: Record<string, unknown> }

/** Fake Bot API: records every call; sendMessage returns a fresh message_id. */
function fakeTelegram() {
  const calls: Call[] = []
  let nextId = 500
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = url.slice(url.lastIndexOf('/') + 1)
    const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {}
    calls.push({ method, body })
    const result = method === 'sendMessage' ? { message_id: ++nextId, date: 1, chat: { id: 77, type: 'private' } } : true
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, result }) }
  }))
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const ana = { id: 77, is_bot: false, first_name: 'Ana' }
const chat = { id: 77, type: 'private', first_name: 'Ana' }

describe('tool confirmation on Telegram', () => {
  it('is an inline keyboard; the callback resolves it, is answered and the keyboard is removed', async () => {
    const calls = fakeTelegram()
    const provider = new TelegramProvider({ token: 'T', polling: false, allowUnsignedWebhooks: true, selfId: '9' })
    const bot = new Bot({ provider })
    const ran: unknown[] = []
    bot.plug(aiPlugin({
      __provider: new MockAIProvider({
        reply: (input: GenerateInput) => {
          const last = input.messages[input.messages.length - 1]
          if (last?.role === 'tool') return `Listo: ${last.results.map((r) => r.content).join(' | ')}`
          return { toolCalls: [{ name: 'place_order', args: {} }] }
        },
      }),
      humanizeTyping: false,
      tools: { place_order: { description: 'Place the order', title: 'Place order', confirm: true, handler: () => { ran.push(1); return 'pedido #1' } } },
    }))
    await bot.start()

    provider.ingest({ update_id: 1, message: { message_id: 10, date: 1, from: ana, chat, text: 'quiero pedir' } })
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'sendMessage')).toBe(true))
    const ask = calls.find((c) => c.method === 'sendMessage')!
    expect(ask.body.text).toBe('Voy a: Place order\n¿Confirmas?')
    const keyboard = (ask.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard
    expect(keyboard.flat().map((b) => b.text)).toEqual(['Sí', 'No'])
    const yes = keyboard[0]![0]!.callback_data
    expect(ran).toEqual([])

    provider.ingest({ update_id: 2, callback_query: { id: 'cq-1', from: ana, data: yes, message: { message_id: 501, date: 1, chat } } })
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'sendMessage' && c.body.text === 'Listo: pedido #1')).toBe(true))
    expect(ran).toEqual([1])
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body).toEqual({ callback_query_id: 'cq-1' })
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(edit?.body).toEqual({ chat_id: 77, message_id: 501, text: 'Voy a: Place order\n¿Confirmas?\n\n→ Sí' })

    // A second tap on the same (now answered) keyboard: answered, nothing runs again.
    provider.ingest({ update_id: 3, callback_query: { id: 'cq-2', from: ana, data: yes, message: { message_id: 501, date: 1, chat } } })
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(2))
    expect(ran).toEqual([1])
    await bot.stop()
  })
})
