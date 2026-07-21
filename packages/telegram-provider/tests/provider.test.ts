import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PayloadTooLargeError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
} from '@bot-wa/core'
import { TelegramProvider } from '../src/TelegramProvider.js'

interface Call { url: string; init?: RequestInit }

function mockFetch(responder: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    const r = responder(call)
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: () => null },
      json: async () => r.body ?? {},
      arrayBuffer: async () => new TextEncoder().encode('BYTES').buffer,
    }
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const waitFor = async (cond: () => boolean, ms = 1500): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const baseCfg = { token: 'TOK' }
const ana = { id: 77, first_name: 'Ana' }
const privateChat = { id: 77, type: 'private' as const }

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('TelegramProvider.send', () => {
  it('sends text via POST /bot{token}/sendMessage', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { message_id: 42, chat: { id: 77 } } } }))
    const p = new TelegramProvider(baseCfg)
    const res = await p.send('77', { kind: 'text', text: 'hola' })
    expect(calls[0].url).toBe('https://api.telegram.org/botTOK/sendMessage')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ chat_id: '77', text: 'hola' })
    expect(res.ref).toMatchObject({ id: '42', chatId: '77' })
    expect(res.ref.native).toEqual({ chat_id: 77, message_id: 42 })
  })

  it('sends a photo by URL as JSON (sendPhoto + caption)', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { message_id: 1, chat: { id: 5 } } } }))
    const p = new TelegramProvider(baseCfg)
    await p.send('5', { kind: 'image', media: 'https://x/i.png', caption: 'mira' })
    expect(calls[0].url).toContain('/sendPhoto')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ chat_id: '5', photo: 'https://x/i.png', caption: 'mira' })
  })

  it('reuses a Telegram file_id via native MediaSource', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { message_id: 1, chat: { id: 5 } } } }))
    const p = new TelegramProvider(baseCfg)
    await p.send('5', { kind: 'image', media: { native: 'AgACAg' } })
    expect(JSON.parse(calls[0].init!.body as string).photo).toBe('AgACAg')
  })

  it('uploads buffer media as multipart/form-data', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { message_id: 1, chat: { id: 5 } } } }))
    const p = new TelegramProvider(baseCfg)
    await p.send('5', { kind: 'document', media: Buffer.from('pdf'), filename: 'a.pdf', caption: 'doc' })
    expect(calls[0].url).toContain('/sendDocument')
    expect(calls[0].init!.body).toBeInstanceOf(FormData)
  })

  it('sends a native poll (sendPoll)', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { id: 'p1', question: 'q', options: [] } } }))
    const p = new TelegramProvider(baseCfg)
    const res = await p.send('77', { kind: 'poll', question: '¿Color?', options: ['Rojo', 'Azul'] })
    expect(calls[0].url).toContain('/sendPoll')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      chat_id: '77', question: '¿Color?', options: ['Rojo', 'Azul'], allows_multiple_answers: false,
    })
    expect(res.ref.chatId).toBe('77')
  })

  it('adds reply_parameters when quoted', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { message_id: 2, chat: { id: 77 } } } }))
    const p = new TelegramProvider(baseCfg)
    await p.send('77', { kind: 'text', text: 're' }, { quoted: { id: '9', chatId: '77' } })
    expect(JSON.parse(calls[0].init!.body as string).reply_parameters).toEqual({ message_id: 9 })
  })

  it('sends buttons as an inline keyboard', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { message_id: 2, chat: { id: 77 } } } }))
    const p = new TelegramProvider(baseCfg)
    await p.send('77', { kind: 'buttons', text: 'elige', buttons: [{ id: 'yes', title: 'Sí' }, { id: 'no', title: 'No' }] })
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.reply_markup.inline_keyboard).toEqual([[{ text: 'Sí', callback_data: 'yes' }], [{ text: 'No', callback_data: 'no' }]])
  })

  it('reactions target the original message chat (setMessageReaction)', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: true } }))
    const p = new TelegramProvider(baseCfg)
    const res = await p.send('77', { kind: 'reaction', emoji: '👍', target: { id: '55', chatId: '-1001' } })
    expect(calls[0].url).toContain('/setMessageReaction')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      chat_id: '-1001', message_id: 55, reaction: [{ type: 'emoji', emoji: '👍' }],
    })
    expect(res.ref.id).toBe('') // non-Message result
  })

  it('native content passes method + params through', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { message_id: 7, chat: { id: 77 } } } }))
    const p = new TelegramProvider(baseCfg)
    await p.send('77', { kind: 'native', provider: 'telegram', payload: { method: 'sendDice', params: { emoji: '🎲' } } })
    expect(calls[0].url).toContain('/sendDice')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ chat_id: '77', emoji: '🎲' })
  })

  it('spreads platformData into the params', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { message_id: 2, chat: { id: 77 } } } }))
    const p = new TelegramProvider(baseCfg)
    await p.send('77', { kind: 'text', text: 'x' }, { platformData: { message_thread_id: 3 } })
    expect(JSON.parse(calls[0].init!.body as string).message_thread_id).toBe(3)
  })
})

describe('TelegramProvider error mapping', () => {
  it('maps 429 + retry_after to RateLimitedError', async () => {
    mockFetch(() => ({ status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } } }))
    const p = new TelegramProvider(baseCfg)
    try {
      await p.send('77', { kind: 'text', text: 'x' })
      throw new Error('expected send to reject')
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitedError)
      expect(e).toMatchObject({ retryAfterMs: 3000 })
    }
  })

  it('maps 403 to RecipientUnreachableError', async () => {
    mockFetch(() => ({ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }))
    const p = new TelegramProvider(baseCfg)
    await expect(p.send('77', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(RecipientUnreachableError)
  })

  it('maps 400 "message is too long" to PayloadTooLargeError', async () => {
    mockFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message is too long' } }))
    const p = new TelegramProvider(baseCfg)
    await expect(p.send('77', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(PayloadTooLargeError)
  })
})

describe('TelegramProvider actions', () => {
  it('acknowledgeInteraction → answerCallbackQuery', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: true } }))
    const p = new TelegramProvider(baseCfg)
    await p.acknowledgeInteraction!('cq-1', { text: 'listo' })
    expect(calls[0].url).toContain('/answerCallbackQuery')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ callback_query_id: 'cq-1', text: 'listo' })
  })

  it('typing → sendChatAction (typing / record_voice; paused is a no-op)', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: true } }))
    const p = new TelegramProvider(baseCfg)
    await p.typing!('77')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ chat_id: '77', action: 'typing' })
    await p.typing!('77', 'recording')
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({ chat_id: '77', action: 'record_voice' })
    await p.typing!('77', 'paused')
    expect(calls).toHaveLength(2)
  })

  it('editMessage → editMessageText; non-text content is rejected', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: { message_id: 42, chat: { id: 77 } } } }))
    const p = new TelegramProvider(baseCfg)
    const res = await p.editMessage!({ id: '42', chatId: '77' }, { kind: 'text', text: 'nuevo' })
    expect(calls[0].url).toContain('/editMessageText')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ chat_id: '77', message_id: 42, text: 'nuevo' })
    expect(res.ref.id).toBe('42')
    await expect(p.editMessage!({ id: '42', chatId: '77' }, { kind: 'location', lat: 0, lng: 0 })).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  it('markRead is a documented no-op (no API call)', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, result: true } }))
    const p = new TelegramProvider(baseCfg)
    await p.markRead!([{ id: '1', chatId: 'x' }])
    expect(calls).toHaveLength(0)
  })

  it('downloadMedia resolves getFile then fetches the file bytes', async () => {
    const calls = mockFetch((call) =>
      call.url.endsWith('/getFile')
        ? { body: { ok: true, result: { file_id: 'f1', file_path: 'photos/1.jpg' } } }
        : { body: {} })
    const p = new TelegramProvider(baseCfg)
    const buf = (await p.downloadMedia!({ kind: 'image', token: 'f1' })) as Buffer
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ file_id: 'f1' })
    expect(calls[1].url).toBe('https://api.telegram.org/file/botTOK/photos/1.jpg')
    expect(buf.toString()).toBe('BYTES')
  })
})

describe('TelegramProvider long-poll', () => {
  it('resolves selfId via getMe, advances the offset, and stops cleanly', async () => {
    const batches: unknown[][] = [
      [
        { update_id: 100, message: { message_id: 1, date: 1, from: ana, chat: privateChat, text: 'a' } },
        { update_id: 101, callback_query: { id: 'cq', from: ana, data: 'go', message: { message_id: 2, date: 1, chat: privateChat } } },
      ],
      [],
    ]
    let i = 0
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/getMe')) return { body: { ok: true, result: { id: 9, is_bot: true, first_name: 'B', username: 'bot' } } }
      if (call.url.includes('/getUpdates')) return { body: { ok: true, result: batches[Math.min(i++, batches.length - 1)] } }
      return { body: { ok: true, result: {} } }
    })
    const p = new TelegramProvider({ token: 'TOK', pollTimeout: 1, pollIdleMs: 5 })
    const seen: string[] = []
    const conn: string[] = []
    p.onEvent((e) => {
      if (e.kind === 'message') seen.push(`msg:${e.message.body}`)
      else if (e.kind === 'interaction') seen.push(`btn:${e.interaction.data}`)
      else if (e.kind === 'connection') conn.push(e.update.state)
    })
    await p.start()
    expect(p.selfId).toBe('9')
    const gu = () => calls.filter((c) => c.url.includes('/getUpdates'))
    await waitFor(() => gu().length >= 2)
    expect(JSON.parse(gu()[0].init!.body as string).offset).toBeUndefined()
    expect(JSON.parse(gu()[1].init!.body as string).offset).toBe(102)
    expect(JSON.parse(gu()[0].init!.body as string).allowed_updates).toEqual(['message', 'edited_message', 'callback_query'])
    expect(seen).toEqual(['msg:a', 'btn:go'])
    expect(conn).toContain('connecting')
    expect(conn).toContain('ready')
    await p.stop()
    const n = gu().length
    await new Promise((r) => setTimeout(r, 40))
    expect(gu().length).toBe(n) // loop really stopped
    expect(conn[conn.length - 1]).toBe('closed')
  })

  it('emits sessionTakenOver and stops on 409 conflict (another poller)', async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/getMe')) return { body: { ok: true, result: { id: 9 } } }
      if (call.url.includes('/getUpdates')) return { status: 409, body: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } }
      return { body: { ok: true, result: {} } }
    })
    const p = new TelegramProvider({ token: 'TOK', errorBackoffMs: 5, pollIdleMs: 5 })
    const reasons: Array<string | undefined> = []
    p.onEvent((e) => { if (e.kind === 'connection') reasons.push(e.update.reason) })
    await p.start()
    await waitFor(() => reasons.includes('sessionTakenOver'))
    await p.stop()
    const n = calls.filter((c) => c.url.includes('/getUpdates')).length
    await new Promise((r) => setTimeout(r, 40))
    expect(calls.filter((c) => c.url.includes('/getUpdates')).length).toBe(n)
  })
})

describe('TelegramProvider webhook ingest', () => {
  it('parses an Update object and fans out normalized events', () => {
    const p = new TelegramProvider({ token: 'TOK', polling: false, selfId: '9' })
    const seen: string[] = []
    p.onEvent((e) => { if (e.kind === 'message') seen.push(e.message.body) })
    const code = p.ingest({ update_id: 1, message: { message_id: 1, date: 1, from: ana, chat: privateChat, text: 'hey' } })
    expect(code).toBe(200)
    expect(seen).toEqual(['hey'])
  })

  it('accepts a JSON string body; rejects garbage with 400', () => {
    const p = new TelegramProvider({ token: 'TOK', polling: false, selfId: '9' })
    expect(p.ingest(JSON.stringify({ update_id: 2, message: { message_id: 1, date: 1, chat: privateChat, text: 'x' } }))).toBe(200)
    expect(p.ingest('nope{')).toBe(400)
    expect(p.ingest({ foo: 1 })).toBe(400)
  })
})
