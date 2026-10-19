/**
 * DiscordProvider — hermetic: the gateway socket is a fake (no real
 * websocket) and `fetch` is stubbed (no real network).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { InboundEvent, InboundInteraction } from '@bot-wa/core'
import { ProviderError, RecipientUnreachableError, UnsupportedContentError } from '@bot-wa/core'
import { DiscordProvider } from '../src/DiscordProvider.js'
import { fakeSocketFactory, wait } from './_fakeSocket.js'

interface Call { url: string; init?: RequestInit }

function mockFetch(responder: (call: Call) => { status?: number; body?: unknown } = () => ({})): Call[] {
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
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const live: DiscordProvider[] = []
function provider(over: Record<string, unknown> = {}): DiscordProvider {
  const { sockets, factory } = fakeSocketFactory()
  const p = new DiscordProvider({ token: 'TOK', socketFactory: factory, reconnectDelayMs: 0, ...over } as never)
  live.push(p)
  ;(p as unknown as { _testSockets: unknown })._testSockets = sockets
  return p
}
const socketsOf = (p: DiscordProvider) =>
  (p as unknown as { _testSockets: ReturnType<typeof fakeSocketFactory>['sockets'] })._testSockets

/** Start + HELLO so the gateway session is up (fake socket, no network). */
async function boot(p: DiscordProvider): Promise<void> {
  await p.start()
  socketsOf(p)[0].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
}

afterEach(async () => {
  while (live.length) await live.pop()!.stop()
  vi.unstubAllGlobals()
})

describe('DiscordProvider — gateway ingress', () => {
  it('start performs the handshake; READY sets selfId and emits ready', async () => {
    mockFetch()
    const p = provider()
    const states: string[] = []
    p.onEvent((e) => { if (e.kind === 'connection') states.push(e.update.state) })

    await boot(p)
    expect(socketsOf(p)[0].sent.some((s) => s.op === 2)).toBe(true) // IDENTIFY

    socketsOf(p)[0].serverSend({ op: 0, t: 'READY', s: 1, d: { session_id: 'S', user: { id: 'BOT1' } } })
    expect(p.selfId).toBe('BOT1')
    expect(states).toEqual(['connecting', 'authenticating', 'ready'])
  })

  it('MESSAGE_CREATE → normalized InboundMessage; bot authors ignored', async () => {
    mockFetch()
    const p = provider({ selfId: 'BOT1' })
    const events: InboundEvent[] = []
    p.onEvent((e) => { events.push(e) })
    await boot(p)

    socketsOf(p)[0].serverSend({
      op: 0, t: 'MESSAGE_CREATE', s: 1,
      d: {
        id: 'M1', channel_id: 'C1', guild_id: 'G1',
        author: { id: 'U1', username: 'ana', global_name: 'Ana' },
        content: 'hola bot', timestamp: '2024-01-01T00:00:00.000Z',
        mentions: [], attachments: [],
      },
    })
    const messages = () => events.flatMap((e) => (e.kind === 'message' ? [e.message] : []))
    expect(messages()).toHaveLength(1)
    const m = messages()[0]
    expect(m.chatId).toBe('C1')
    expect(m.senderId).toBe('U1')
    expect(m.body).toBe('hola bot')
    expect(m.isGroup).toBe(true)
    expect(m.type).toBe('text')

    // The bot's own (or any bot's) MESSAGE_CREATE is dropped.
    socketsOf(p)[0].serverSend({
      op: 0, t: 'MESSAGE_CREATE', s: 2,
      d: {
        id: 'M2', channel_id: 'C1', guild_id: 'G1',
        author: { id: 'BOT1', bot: true },
        content: 'eco', timestamp: '2024-01-01T00:00:01.000Z',
        mentions: [], attachments: [],
      },
    })
    expect(messages()).toHaveLength(1)
  })

  it('INTERACTION_CREATE → interaction with "<id>:<token>" for ack', async () => {
    mockFetch()
    const p = provider()
    const events: Array<{ kind: string }> = []
    p.onEvent((e) => { events.push(e as { kind: string }) })
    await boot(p)

    socketsOf(p)[0].serverSend({
      op: 0, t: 'INTERACTION_CREATE', s: 1,
      d: {
        id: '175928847299117063', type: 3, token: 'ITOK',
        channel_id: 'C1', guild_id: 'G1',
        member: { user: { id: 'U1', username: 'ana' } },
        data: { custom_id: 'btn_yes', component_type: 2 },
        message: { id: 'M9' },
      },
    })
    const inter = (events.find((e) => e.kind === 'interaction') as { interaction: InboundInteraction } | undefined)?.interaction
    expect(inter).toBeDefined()
    expect(inter!.kind).toBe('button')
    expect(inter!.data).toBe('btn_yes')
    expect(inter!.interactionId).toBe('175928847299117063:ITOK')
    expect(inter!.respondBy).toBe(inter!.timestamp + 3000)
  })
})

describe('DiscordProvider — REST outbound', () => {
  it('send text POSTs to the channel messages endpoint with Bot auth', async () => {
    const calls = mockFetch(() => ({ body: { id: 'M2' } }))
    const p = provider()
    const res = await p.send('C1', { kind: 'text', text: 'hola' })

    expect(res.ref).toEqual({ id: 'M2', chatId: 'C1' })
    expect(calls[0].url).toBe('https://discord.com/api/v10/channels/C1/messages')
    const headers = calls[0].init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bot TOK')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ content: 'hola' })
  })

  it('applies message_reference and allowed_mentions from SendOptions', async () => {
    const calls = mockFetch(() => ({ body: { id: 'M3' } }))
    const p = provider()
    await p.send('C1', { kind: 'text', text: 're' }, { quoted: { id: 'M1', chatId: 'C1' }, mentions: ['U1'] })
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.message_reference).toMatchObject({ message_id: 'M1', channel_id: 'C1' })
    expect(body.allowed_mentions).toEqual({ users: ['U1'] })
  })

  it('send image uploads multipart (files[0] + payload_json)', async () => {
    const calls = mockFetch(() => ({ body: { id: 'M4' } }))
    const p = provider()
    await p.send('C1', { kind: 'image', media: Buffer.from('pix'), caption: 'mira' })

    const form = calls[0].init!.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const payload = JSON.parse(form.get('payload_json') as string)
    expect(payload.content).toBe('mira')
    expect(payload.attachments[0]).toMatchObject({ id: 0, filename: 'image.png' })
    const f = form.get('files[0]')
    expect(f).toBeInstanceOf(Blob)
    expect((f as Blob).size).toBe(3)
  })

  it('send buttons maps to Discord components', async () => {
    const calls = mockFetch(() => ({ body: { id: 'M5' } }))
    const p = provider()
    await p.send('C1', { kind: 'buttons', text: 'elige', buttons: [{ id: 'yes', title: 'Sí' }] })
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.components[0].type).toBe(1)
    expect(body.components[0].components[0]).toMatchObject({ type: 2, style: 1, custom_id: 'yes', label: 'Sí' })
  })

  it('send reaction uses the PUT reactions route (URL-encoded emoji)', async () => {
    const calls = mockFetch(() => ({ body: {} }))
    const p = provider()
    const res = await p.send('C1', { kind: 'reaction', emoji: '👍', target: { id: 'M1', chatId: 'C1' } })

    expect(calls[0].init!.method).toBe('PUT')
    expect(calls[0].url).toBe(`https://discord.com/api/v10/channels/C1/messages/M1/reactions/${encodeURIComponent('👍')}/@me`)
    expect(res.ref).toEqual({ id: 'M1', chatId: 'C1' })
  })

  it('typing POSTs /channels/{id}/typing', async () => {
    const calls = mockFetch(() => ({ body: {} }))
    const p = provider()
    await p.typing!('C1')
    expect(calls[0].init!.method).toBe('POST')
    expect(calls[0].url).toBe('https://discord.com/api/v10/channels/C1/typing')
  })

  it('acknowledgeInteraction POSTs the callback: defer (type 6) or immediate (type 4)', async () => {
    const calls = mockFetch(() => ({ body: {} }))
    const p = provider()
    await p.acknowledgeInteraction!('IID:TT')
    expect(calls[0].url).toBe('https://discord.com/api/v10/interactions/IID/TT/callback')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ type: 6 })

    await p.acknowledgeInteraction!('IID:TT', { text: 'ya' })
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({ type: 4, data: { content: 'ya' } })
  })

  it('maps HTTP 429 to RateLimitedError (retry_after seconds → ms)', async () => {
    mockFetch(() => ({ status: 429, body: { message: 'slow down', retry_after: 1.5, code: 0 } }))
    const p = provider()
    await expect(p.send('C1', { kind: 'text', text: 'x' }))
      .rejects.toMatchObject({ name: 'RateLimitedError', retryAfterMs: 1500 })
  })

  it('maps HTTP 400 with {message} to ProviderError', async () => {
    mockFetch(() => ({ status: 400, body: { message: 'Invalid Form Body', code: 50035 } }))
    const p = provider()
    await expect(p.send('C1', { kind: 'text', text: 'x' })).rejects.toThrow(ProviderError)
    await expect(p.send('C1', { kind: 'text', text: 'x' })).rejects.toThrow('Invalid Form Body')
  })

  it('markRead is a no-op (Discord has no read receipts)', async () => {
    const calls = mockFetch()
    const p = provider()
    await p.markRead([{ id: 'M1', chatId: 'C1' }])
    expect(calls).toHaveLength(0)
  })
})

describe('DiscordProvider — misc', () => {
  it('exposes id "discord" and the documented capabilities', () => {
    const p = provider()
    expect(p.id).toBe('discord')
    expect(p.capabilities).toMatchObject({
      buttons: true, lists: true, polls: true, reactions: true, edit: true, typing: true,
      presence: false, readReceipts: false, groups: true, templates: false,
      interactionsRequireAck: true, pushIngress: false,
    })
  })

  it('stop closes the gateway socket', async () => {
    mockFetch()
    const p = provider()
    await boot(p)
    await p.stop()
    expect(socketsOf(p)[0].closedWith).toHaveLength(1)
  })

  it('reconnects the gateway with RESUME after a dropped connection', async () => {
    mockFetch()
    const p = provider()
    await boot(p)
    socketsOf(p)[0].serverSend({ op: 0, t: 'READY', s: 1, d: { session_id: 'S' } })
    socketsOf(p)[0].close(4000)
    await wait(40)
    const sockets = socketsOf(p)
    expect(sockets).toHaveLength(2)
    sockets[1].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
    expect(sockets[1].sent.some((s) => s.op === 6)).toBe(true)
  })
})

describe('DiscordProvider — hardening', () => {
  it('emits ready again after a successful RESUME (RESUMED dispatch)', async () => {
    mockFetch()
    const p = provider()
    const states: string[] = []
    p.onEvent((e) => { if (e.kind === 'connection') states.push(e.update.state) })
    await boot(p)
    socketsOf(p)[0].serverSend({ op: 0, t: 'READY', s: 1, d: { session_id: 'S' } })
    socketsOf(p)[0].close(4000)
    await wait(40)
    states.length = 0
    const s1 = socketsOf(p)[1]
    s1.serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
    s1.serverSend({ op: 0, t: 'RESUMED', s: 2, d: null })
    expect(states[states.length - 1]).toBe('ready')
  })

  it('maps 404 Unknown Channel (10003) and 50007 to RecipientUnreachableError', async () => {
    const p = provider()
    mockFetch(() => ({ status: 404, body: { message: 'Unknown Channel', code: 10003 } }))
    const e1 = await p.send('C404', { kind: 'text', text: 'x' }).catch((e: unknown) => e)
    expect(e1).toBeInstanceOf(RecipientUnreachableError)
    expect((e1 as RecipientUnreachableError).chatId).toBe('C404')
    mockFetch(() => ({ status: 400, body: { message: 'Cannot send messages to this user', code: 50007 } }))
    await expect(p.send('C1', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(RecipientUnreachableError)
  })

  it('an empty reaction emoji with no remembered reaction is rejected with UnsupportedContentError (no API call)', async () => {
    const calls = mockFetch()
    const p = provider()
    await expect(p.send('C1', { kind: 'reaction', emoji: '', target: { id: 'M1', chatId: 'C1' } })).rejects.toBeInstanceOf(UnsupportedContentError)
    expect(calls).toHaveLength(0)
  })

  it('editMessage keeps the filename of a document', async () => {
    const calls = mockFetch(() => ({ body: { id: 'M1' } }))
    const p = provider()
    await p.editMessage({ id: 'M1', chatId: 'C1' }, { kind: 'document', media: Buffer.from('x'), filename: 'factura.pdf' })
    const form = calls[0].init!.body as FormData
    expect((form.get('files[0]') as File).name).toBe('factura.pdf')
  })
})

describe('DiscordProvider — removing and replacing the bot own reaction', () => {
  const route = (emoji: string, msg = 'M1') => `https://discord.com/api/v10/channels/C1/messages/${msg}/reactions/${encodeURIComponent(emoji)}/@me`
  const target = (id = 'M1') => ({ id, chatId: 'C1' })
  const ops = (calls: Call[]) => calls.map((c) => `${c.init!.method} ${c.url}`)

  it('an empty emoji removes the reaction the bot set on that message', async () => {
    const calls = mockFetch()
    const p = provider()
    await p.send('C1', { kind: 'reaction', emoji: '👍', target: target() })
    await p.send('C1', { kind: 'reaction', emoji: '', target: target() })
    expect(ops(calls)).toEqual([`PUT ${route('👍')}`, `DELETE ${route('👍')}`])
    // Forgotten after removal: a second removal has nothing to remove.
    await expect(p.send('C1', { kind: 'reaction', emoji: '', target: target() })).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  it('a new emoji replaces the previous one (one reaction per message, like WhatsApp/Telegram)', async () => {
    const calls = mockFetch()
    const p = provider()
    await p.send('C1', { kind: 'reaction', emoji: '⏳', target: target() })
    await p.send('C1', { kind: 'reaction', emoji: '✅', target: target() })
    await p.send('C1', { kind: 'reaction', emoji: '✅', target: target() })
    expect(ops(calls)).toEqual([`PUT ${route('⏳')}`, `PUT ${route('✅')}`, `DELETE ${route('⏳')}`, `PUT ${route('✅')}`])
  })

  it('a failed PUT does not forget the previous reaction', async () => {
    const calls = mockFetch((c) => (c.url.includes(encodeURIComponent('❌')) ? { status: 400, body: { message: 'Unknown Emoji', code: 10014 } } : {}))
    const p = provider()
    await p.send('C1', { kind: 'reaction', emoji: '👍', target: target() })
    await expect(p.send('C1', { kind: 'reaction', emoji: '❌', target: target() })).rejects.toBeInstanceOf(ProviderError)
    await p.send('C1', { kind: 'reaction', emoji: '', target: target() })
    expect(ops(calls).at(-1)).toBe(`DELETE ${route('👍')}`)
  })

  it('the memory is bounded (reactionMemory) and can be turned off', async () => {
    mockFetch()
    const p = provider({ reactionMemory: 2 })
    for (const id of ['M1', 'M2', 'M3']) await p.send('C1', { kind: 'reaction', emoji: '👍', target: target(id) })
    await expect(p.send('C1', { kind: 'reaction', emoji: '', target: target('M1') })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(p.send('C1', { kind: 'reaction', emoji: '', target: target('M3') })).resolves.toBeDefined()

    const calls = mockFetch()
    const off = provider({ reactionMemory: 0 })
    await off.send('C1', { kind: 'reaction', emoji: '⏳', target: target() })
    await off.send('C1', { kind: 'reaction', emoji: '✅', target: target() })
    expect(ops(calls)).toEqual([`PUT ${route('⏳')}`, `PUT ${route('✅')}`]) // no replace without memory
    await expect(off.send('C1', { kind: 'reaction', emoji: '', target: target() })).rejects.toBeInstanceOf(UnsupportedContentError)
  })
})
