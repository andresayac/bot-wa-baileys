import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProviderError, streamText } from '@botmesh/core'
import { TelegramProvider } from '../src/TelegramProvider.js'

interface Call { url: string; body: Record<string, unknown> }

function mockFetch(responder: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, body: init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {} }
    calls.push(call)
    const r = responder(call)
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: { get: () => null }, json: async () => r.body ?? {} }
  }))
  return calls
}

const ok = (result: unknown = true) => ({ body: { ok: true, result } })
const method = (c: Call) => c.url.slice(c.url.lastIndexOf('/') + 1)

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('TelegramProvider streaming', () => {
  it("declares streaming: 'draft' and the 4096 limit", () => {
    const p = new TelegramProvider({ token: 'T' })
    expect(p.capabilities.streaming).toBe('draft')
    expect(p.capabilities.maxTextLength).toBe(4096)
  })

  it('declares an exclusive session only in long-polling mode (multi-replica coordination)', () => {
    expect(new TelegramProvider({ token: 'T' }).capabilities.exclusiveSession).toBe(true)
    expect(new TelegramProvider({ token: 'T', polling: false, webhookSecret: 's' }).capabilities.exclusiveSession).toBe(false)
  })

  it('sendDraft → sendMessageDraft with draft_id, text, can_stop, keep_on_stop and passthrough', async () => {
    const calls = mockFetch(() => ok())
    const p = new TelegramProvider({ token: 'T' })
    await p.sendDraft('77', 5, 'Hola', { canStop: true, keepOnStop: true, platformData: { message_thread_id: 3 } })
    expect(method(calls[0])).toBe('sendMessageDraft')
    expect(calls[0].body).toEqual({ chat_id: '77', draft_id: 5, text: 'Hola', can_stop: true, keep_on_stop: true, message_thread_id: 3 })
  })

  it('omits can_stop/keep_on_stop when not requested', async () => {
    const calls = mockFetch(() => ok())
    const p = new TelegramProvider({ token: 'T' })
    await p.sendDraft('77', 1, '')
    expect(calls[0].body).toEqual({ chat_id: '77', draft_id: 1, text: '' })
  })

  it('a stopped_message_generation update fires the matching onStop once (webhook)', async () => {
    mockFetch(() => ok())
    const p = new TelegramProvider({ token: 'T', polling: false, allowUnsignedWebhooks: true })
    const onStop = vi.fn()
    const other = vi.fn()
    await p.sendDraft('77', 9, 'a', { canStop: true, onStop })
    await p.sendDraft('77', 10, 'b', { canStop: true, onStop: other })
    const events: unknown[] = []
    p.onEvent((e) => { events.push(e) })
    const update = { update_id: 1, stopped_message_generation: { chat: { id: 77, type: 'private' }, draft_id: 9 } }
    expect(p.ingest(update)).toBe(200)
    expect(p.ingest({ ...update, update_id: 2 })).toBe(200)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    expect(events).toEqual([]) // not projected as a message
  })

  it('long-poll asks for stopped_message_generation updates and routes them', async () => {
    let served = false
    const onStop = vi.fn()
    const calls = mockFetch((c) => {
      if (method(c) === 'getUpdates') {
        if (served) return ok([])
        served = true
        return ok([{ update_id: 5, stopped_message_generation: { chat: { id: 77, type: 'private' }, draft_id: 4 } }])
      }
      return ok()
    })
    const p = new TelegramProvider({ token: 'T', selfId: '1', pollTimeout: 1, pollIdleMs: 5 })
    await p.sendDraft('77', 4, 'x', { canStop: true, onStop })
    await p.start()
    await vi.waitFor(() => expect(onStop).toHaveBeenCalledTimes(1))
    await p.stop()
    const gu = calls.find((c) => method(c) === 'getUpdates')!
    expect(gu.body.allowed_updates).toContain('stopped_message_generation')
  })

  it('editMessage treats "message is not modified" as success', async () => {
    mockFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message is not modified' } }))
    const p = new TelegramProvider({ token: 'T' })
    await expect(p.editMessage({ id: '1', chatId: '77' }, { kind: 'text', text: 'x' })).resolves.toMatchObject({ ref: { id: '1' } })
  })

  it('a rejected draft (group chat) is a typed ProviderError', async () => {
    mockFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat must be private' } }))
    const p = new TelegramProvider({ token: 'T' })
    await expect(p.sendDraft('-100', 1, 'x')).rejects.toBeInstanceOf(ProviderError)
  })

  it('end-to-end with streamText: drafts then one final sendMessage', async () => {
    let id = 0
    const calls = mockFetch((c) => method(c) === 'sendMessage' ? ok({ message_id: ++id, chat: { id: 77 } }) : ok())
    const p = new TelegramProvider({ token: 'T' })
    async function* src() { for (const t of ['Hola', ' desde', ' Telegram']) { await new Promise((r) => setTimeout(r, 5)); yield t } }
    const res = await streamText({
      capabilities: p.capabilities,
      isPrivate: true,
      send: async (content) => { const r = await p.send('77', content); return { ...r, id: r.ref.id, chatId: r.ref.chatId } },
      edit: (ref, content) => p.editMessage(ref, content),
      draft: (draftId, text, o) => p.sendDraft('77', draftId, text, o),
    }, src(), { throttleMs: 0 })
    expect(res.strategy).toBe('draft')
    const methods = calls.map(method)
    expect(methods.filter((m) => m === 'sendMessageDraft').length).toBeGreaterThan(0)
    expect(methods.at(-1)).toBe('sendMessage')
    expect(calls.at(-1)!.body.text).toBe('Hola desde Telegram')
  })
})
