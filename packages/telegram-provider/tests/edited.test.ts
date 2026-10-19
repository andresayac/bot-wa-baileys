import { describe, it, expect, vi, afterEach } from 'vitest'
import { InboundDeduper } from '@bot-wa/core'
import type { InboundEvent, InboundMessage } from '@bot-wa/core'
import { TelegramProvider, isEditedMessage, parseUpdate } from '../src/index.js'

const ana = { id: 77, first_name: 'Ana' }
const privateChat = { id: 77, type: 'private' as const }
const original = { message_id: 12, date: 100, from: ana, chat: privateChat, text: 'helo' }
const edit = { ...original, text: 'hello', edit_date: 160 }

function message(ev: InboundEvent | undefined): InboundMessage {
  if (ev?.kind !== 'message') throw new Error('expected a message')
  return ev.message
}

afterEach(() => vi.unstubAllGlobals())

describe('Telegram edited_message', () => {
  it('is delivered as a message that keeps the original (targetable) id and is marked as an edit', () => {
    const m = message(parseUpdate({ update_id: 2, edited_message: edit }))
    expect(m.ref.id).toBe('12')
    expect(m.ref.native).toEqual({ chat_id: 77, message_id: 12, edit_date: 160 })
    expect(m.body).toBe('hello')
    expect(m.timestamp).toBe(100_000) // the original send time; the edit time is edit_date
    expect(isEditedMessage(m)).toBe(true)
    expect(isEditedMessage(message(parseUpdate({ update_id: 1, message: original })))).toBe(false)
  })

  it('the core deduper lets an edit through but drops a redelivery of the same edit', () => {
    const dedupe = new InboundDeduper()
    const key = (ev: InboundEvent | undefined) => {
      const m = message(ev)
      return [`${m.chatId}:${m.ref.id}`, `${m.type}:${m.body}`] as const
    }
    const seen = (ev: InboundEvent | undefined) => {
      const [k, f] = key(ev)
      return dedupe.isDuplicate(k, f)
    }
    expect(seen(parseUpdate({ update_id: 1, message: original }))).toBe(false)
    expect(seen(parseUpdate({ update_id: 2, edited_message: edit }))).toBe(false)
    expect(seen(parseUpdate({ update_id: 2, edited_message: edit }))).toBe(true)
  })

  it('editedMessages: "ignore" drops edits in webhook mode and stops requesting them while polling', async () => {
    const p = new TelegramProvider({ token: 'TOK', polling: false, allowUnsignedWebhooks: true, editedMessages: 'ignore' })
    const bodies: string[] = []
    p.onEvent((e) => { if (e.kind === 'message') bodies.push(e.message.body) })
    expect(p.ingest({ update_id: 1, message: original })).toBe(200)
    expect(p.ingest({ update_id: 2, edited_message: edit })).toBe(200)
    expect(bodies).toEqual(['helo'])

    const urls: Array<{ url: string; body: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      urls.push({ url, body: String(init?.body ?? '') })
      const result = url.endsWith('/getMe') ? { id: 9, is_bot: true, first_name: 'B' } : []
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, result }) }
    }))
    const polling = new TelegramProvider({ token: 'TOK', pollTimeout: 1, pollIdleMs: 5, editedMessages: 'ignore' })
    await polling.start()
    const t0 = Date.now()
    while (!urls.some((u) => u.url.includes('/getUpdates')) && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 5))
    await polling.stop()
    const gu = urls.find((u) => u.url.includes('/getUpdates'))!
    expect(JSON.parse(gu.body).allowed_updates).toEqual(['message', 'callback_query', 'stopped_message_generation'])
  })

  it('rejects an invalid editedMessages value', () => {
    expect(() => new TelegramProvider({ token: 'TOK', editedMessages: 'drop' as never })).toThrow(/editedMessages/)
  })
})
