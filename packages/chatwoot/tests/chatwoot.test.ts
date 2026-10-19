import { createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Bot, MemoryStore } from '@bot-wa/core'
import { MockProvider, createTestBot } from '@bot-wa/core/testing'
import { chatwootPlugin, type ChatwootPluginConfig } from '../src/index.js'
import { FakeChatwoot, publicResolver } from './fakeChatwoot.js'

const tick = () => new Promise((r) => setTimeout(r, 0))
const CHAT = 'user@s.whatsapp.net'

function setup(over: Partial<ChatwootPluginConfig> = {}) {
  const fake = new FakeChatwoot()
  const plugin = chatwootPlugin({
    baseUrl: 'https://chatwoot.example.com',
    apiKey: 'secret-key',
    accountId: 1,
    inboxId: 2,
    webhookToken: 'hook-token',
    http: { fetch: fake.fetch as typeof globalThis.fetch, resolver: publicResolver },
    ...over,
  })
  return { fake, plugin }
}

function agentReply(conversationId: number, content: string, extra: Record<string, unknown> = {}) {
  return {
    event: 'message_created',
    id: 9000 + Math.floor(Math.random() * 1000),
    content,
    message_type: 'outgoing',
    private: false,
    sender: { id: 7, name: 'Ana', type: 'user' },
    inbox: { id: 2 },
    conversation: { id: conversationId, status: 'open' },
    ...extra,
  }
}

const tokenReq = (payload: unknown, token = 'hook-token') => ({
  rawBody: JSON.stringify(payload),
  headers: {},
  query: { token },
})

describe('chatwootPlugin — bot → Chatwoot sync', () => {
  it('maps the chat to one contact + conversation and syncs inbound and bot replies', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup()
    bot.plug(plugin)
    bot.when('hola', (ctx) => ctx.reply('¡Hola! ¿En qué te ayudo?'))

    await chat.send('hola')
    await chat.expectReply('¡Hola!')
    await chat.send('quiero ayuda')
    await plugin.flush()

    expect(fake.contacts).toHaveLength(1)
    expect(fake.contacts[0].identifier).toBe(CHAT)
    const conv = fake.onlyConversation()
    expect(conv.messages.map((m) => [m.message_type, m.content])).toEqual([
      ['incoming', 'hola'],
      ['outgoing', '¡Hola! ¿En qué te ayudo?'],
      ['incoming', 'quiero ayuda'],
    ])
    const create = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/conversations'))!
    expect(create.body).toMatchObject({ inbox_id: 2, contact_id: fake.contacts[0].id, source_id: fake.contacts[0].source_id })
    expect(await plugin.conversationOf(CHAT)).toBe(conv.id)
    await bot.stop()
  })

  it('reuses an existing contact found by identifier', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup()
    fake.contacts.push({ id: 55, name: 'Old', identifier: CHAT, source_id: 'x' })
    bot.plug(plugin)
    await chat.send('hola')
    await plugin.flush()
    expect(fake.contacts).toHaveLength(1)
    expect(fake.onlyConversation().contactId).toBe(55)
    // no source id from search → a contact inbox is created
    expect(fake.requests.some((r) => r.path.endsWith('/contacts/55/contact_inboxes'))).toBe(true)
    await bot.stop()
  })

  it('syncMode "handoff" only syncs while the chat is handed off', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup({ syncMode: 'handoff' })
    bot.plug(plugin)
    await chat.send('antes')
    await plugin.flush()
    expect(fake.conversations.size).toBe(0)
    await bot.handoff(CHAT, { reason: 'manual' })
    await chat.send('durante')
    await plugin.flush()
    const msgs = fake.onlyConversation().messages.filter((m) => !m.private)
    expect(msgs.map((m) => m.content)).toEqual(['durante'])
    await bot.stop()
  })

  it('labels: message rule + addLabels() union with the existing labels', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup({ labels: { message: (ctx) => (ctx.body.includes('factura') ? ['billing'] : undefined) } })
    bot.plug(plugin)
    await chat.send('mi factura')
    await plugin.flush()
    expect(fake.onlyConversation().labels).toEqual(['billing'])
    await plugin.addLabels(CHAT, ['vip', 'billing'])
    expect(fake.onlyConversation().labels).toEqual(['billing', 'vip'])
    await bot.stop()
  })

  it('recreates the conversation when Chatwoot answers 404 for the mapped one', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup()
    bot.plug(plugin)
    await chat.send('uno')
    await plugin.flush()
    const first = fake.onlyConversation().id
    fake.conversations.delete(first)
    await chat.send('dos')
    await plugin.flush()
    const second = fake.onlyConversation()
    expect(second.id).not.toBe(first)
    expect(second.messages.map((m) => m.content)).toEqual(['dos'])
    await bot.stop()
  })

  it('re-links the chat when the Chatwoot contact was deleted (with its conversations)', async () => {
    const onError = vi.fn()
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup({ onError })
    bot.plug(plugin)
    await chat.send('uno')
    await plugin.flush()
    const firstContact = fake.contacts[0].id
    fake.deleteContact(firstContact)
    await chat.send('dos')
    await plugin.flush()
    await chat.send('tres')
    await plugin.flush()
    expect(onError).not.toHaveBeenCalled()
    expect(fake.contacts).toHaveLength(1)
    expect(fake.contacts[0].id).not.toBe(firstContact)
    const conv = fake.onlyConversation()
    expect(conv.contactId).toBe(fake.contacts[0].id)
    expect(conv.messages.map((m) => m.content)).toEqual(['dos', 'tres'])
    expect(await plugin.conversationOf(CHAT)).toBe(conv.id)
    await bot.stop()
  })

  it('re-links a stale mapping whose contact is gone even when no conversation is mapped', async () => {
    const onError = vi.fn()
    const { bot, chat } = await createTestBot()
    const storage = { data: new Map<string, string>(), async get(k: string) { return this.data.get(k) }, async set(k: string, v: string) { this.data.set(k, v) } }
    storage.data.set(`chatwoot:chat:${CHAT}`, JSON.stringify({ contactId: 777 }))
    const { fake, plugin } = setup({ onError, storage })
    bot.plug(plugin)
    await chat.send('hola')
    await plugin.flush()
    expect(onError).not.toHaveBeenCalled()
    expect(fake.onlyConversation().messages.map((m) => m.content)).toEqual(['hola'])
    await bot.stop()
  })

  it('reports API errors through onError without breaking the bot', async () => {
    const onError = vi.fn()
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup({ onError })
    fake.failures.push({ match: /POST .*\/contacts$/, status: 500, times: 1 })
    bot.plug(plugin)
    bot.when('hola', (ctx) => ctx.reply('hey'))
    await chat.send('hola')
    await chat.expectReply('hey')
    await plugin.flush()
    expect(onError).toHaveBeenCalled()
    expect(String(onError.mock.calls[0][0])).toMatch(/500/)
    await bot.stop()
  })

  it('outbound HTTP goes through secureFetch (private hosts rejected by default)', async () => {
    const onError = vi.fn()
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup({ baseUrl: 'https://10.0.0.5', onError, http: { fetch: new FakeChatwoot().fetch as typeof globalThis.fetch } })
    bot.plug(plugin)
    await chat.send('hola')
    await plugin.flush()
    expect(fake.requests).toHaveLength(0)
    expect(onError).toHaveBeenCalled()
    expect(String(onError.mock.calls[0][0])).toMatch(/private|unsafe|UNSAFE/i)
    await bot.stop()
  })
})

describe('chatwootPlugin — handoff integration', () => {
  it('an agent reply is delivered with bot.sendTo and auto-hands the chat off', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup()
    bot.plug(plugin)
    const handler = vi.fn((ctx) => ctx.reply('bot answer'))
    bot.when('pedido', handler)

    await chat.send('hola')
    await plugin.flush()
    const conv = fake.onlyConversation()
    const res = await plugin.handleWebhook(tokenReq(agentReply(conv.id, 'Hola, soy Ana')))
    expect(res.status).toBe(200)
    await chat.expectReply('Hola, soy Ana')
    expect(bot.isHandedOff(CHAT)).toBe(true)
    expect(bot.getHandoff(CHAT)?.meta).toMatchObject({ conversationId: conv.id })

    // While handed off the bot does not answer, but the message reaches Chatwoot.
    await chat.send('pedido')
    await plugin.flush()
    expect(handler).not.toHaveBeenCalled()
    expect(conv.messages.at(-1)?.content).toBe('pedido')
    // the agent message is NOT echoed back into Chatwoot
    expect(conv.messages.filter((m) => m.content === 'Hola, soy Ana')).toHaveLength(0)
    await bot.stop()
  })

  it('autoHandoff: false only relays the agent message', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup({ autoHandoff: false })
    bot.plug(plugin)
    await chat.send('hola')
    await plugin.flush()
    await plugin.handleWebhook(tokenReq(agentReply(fake.onlyConversation().id, 'hey')))
    await chat.expectReply('hey')
    expect(bot.isHandedOff(CHAT)).toBe(false)
    await bot.stop()
  })

  it('a resolved conversation resumes the bot (without toggling it back)', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup()
    bot.plug(plugin)
    const resumed = vi.fn()
    bot.on('resume', resumed)
    await chat.send('hola')
    await plugin.flush()
    const conv = fake.onlyConversation()
    await plugin.handleWebhook(tokenReq(agentReply(conv.id, 'te atiendo')))
    expect(bot.isHandedOff(CHAT)).toBe(true)

    const res = await plugin.handleWebhook(tokenReq({ event: 'conversation_status_changed', id: conv.id, status: 'resolved', inbox_id: 2 }))
    expect(res.status).toBe(200)
    expect(bot.isHandedOff(CHAT)).toBe(false)
    expect(resumed).toHaveBeenCalledWith(expect.objectContaining({ chatId: CHAT, reason: 'chatwoot:resolved' }))
    await plugin.flush()
    expect(fake.requests.filter((r) => r.path.endsWith('/toggle_status') && (r.body as { status: string }).status === 'resolved')).toHaveLength(0)
    await bot.stop()
  })

  it('conversation_updated only resumes when the status actually changed to resolved', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup({ labels: { handoff: ['humano'] } })
    bot.plug(plugin)
    await chat.send('hola')
    await plugin.flush()
    const conv = fake.onlyConversation()
    await plugin.handleWebhook(tokenReq(agentReply(conv.id, 'te atiendo', { conversation: { id: conv.id, status: 'resolved' } })))
    expect(bot.isHandedOff(CHAT)).toBe(true)
    // label / assignee updates on an already resolved conversation carry status: resolved
    await plugin.handleWebhook(tokenReq({ event: 'conversation_updated', id: conv.id, status: 'resolved', inbox_id: 2, changed_attributes: [{ label_list: { previous_value: [], current_value: ['humano'] } }] }))
    await plugin.handleWebhook(tokenReq({ event: 'conversation_updated', id: conv.id, status: 'resolved', inbox_id: 2 }))
    expect(bot.isHandedOff(CHAT)).toBe(true)
    await plugin.handleWebhook(tokenReq({ event: 'conversation_updated', id: conv.id, status: 'resolved', inbox_id: 2, changed_attributes: [{ status: { previous_value: 'open', current_value: 'resolved' } }] }))
    expect(bot.isHandedOff(CHAT)).toBe(false)
    await bot.stop()
  })

  it('a redelivered agent message (same Chatwoot id) is sent to the chat only once', async () => {
    const { bot, chat, provider } = await createTestBot()
    const { fake, plugin } = setup()
    bot.plug(plugin)
    await chat.send('hola')
    await plugin.flush()
    const payload = agentReply(fake.onlyConversation().id, 'una sola vez', { id: 4242 })
    const [a, b] = await Promise.all([plugin.handleWebhook(tokenReq(payload)), plugin.handleWebhook(tokenReq(payload))])
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await plugin.handleWebhook(tokenReq(payload))).status).toBe(200)
    const texts = provider.outbox.filter((m) => m.chatId === CHAT).map((m) => (m.content as { text: string }).text)
    expect(texts).toEqual(['una sola vez'])
    await bot.stop()
  })

  it('ctx.handoff() opens the conversation, labels it and posts a private note; bot.resume() resolves it', async () => {
    const { bot, chat } = await createTestBot()
    const { fake, plugin } = setup({ labels: { handoff: ['humano'], resume: ['bot'] } })
    bot.plug(plugin)
    bot.when('agente', async (ctx) => {
      await ctx.handoff({ reason: 'pidió agente' })
      await ctx.reply('Te conecto…')
    })
    await chat.send('agente')
    await chat.expectReply('Te conecto')
    await plugin.flush()
    const conv = fake.onlyConversation()
    expect(conv.status).toBe('open')
    expect(conv.labels).toEqual(['humano'])
    expect(conv.messages.some((m) => m.private && m.content.includes('pidió agente'))).toBe(true)

    await bot.resume(CHAT)
    await plugin.flush()
    expect(conv.status).toBe('resolved')
    expect(conv.labels).toEqual(['bot'])
    await bot.stop()
  })

  it('ignores echoes of its own outgoing messages, private notes, other inboxes and unknown conversations', async () => {
    const { bot, chat, provider } = await createTestBot()
    const { fake, plugin } = setup()
    bot.plug(plugin)
    // Simulate Chatwoot firing the webhook for our own POST before the POST resolves.
    const echoes: Array<Promise<unknown>> = []
    fake.onMessageCreated = (convId, msg) => {
      if (msg.message_type === 'outgoing') echoes.push(plugin.handleWebhook(tokenReq(agentReply(convId, msg.content, { id: msg.id }))))
    }
    bot.when('hola', (ctx) => ctx.reply('respuesta del bot'))
    await chat.send('hola')
    await chat.expectReply('respuesta del bot')
    await plugin.flush()
    await Promise.all(echoes)
    const conv = fake.onlyConversation()
    fake.onMessageCreated = undefined

    // late echo by id
    const own = conv.messages.find((m) => m.message_type === 'outgoing')!
    await plugin.handleWebhook(tokenReq(agentReply(conv.id, own.content, { id: own.id })))
    await plugin.handleWebhook(tokenReq(agentReply(conv.id, 'nota', { private: true })))
    await plugin.handleWebhook(tokenReq(agentReply(conv.id, 'otro inbox', { inbox: { id: 99 } })))
    await plugin.handleWebhook(tokenReq(agentReply(424242, 'desconocida')))
    await plugin.handleWebhook(tokenReq({ ...agentReply(conv.id, 'entrante'), message_type: 'incoming' }))
    await plugin.handleWebhook(tokenReq(agentReply(conv.id, 'bot de chatwoot', { sender: { id: 1, type: 'agent_bot' } })))
    await tick()

    expect(provider.outbox.filter((m) => m.chatId === CHAT).map((m) => (m.content as { text: string }).text)).toEqual(['respuesta del bot'])
    expect(bot.isHandedOff(CHAT)).toBe(false)
    await bot.stop()
  })

  it('forwards agent attachments as media by URL (caption = message text)', async () => {
    const { bot, chat, provider } = await createTestBot()
    const { fake, plugin } = setup()
    bot.plug(plugin)
    await chat.send('hola')
    await plugin.flush()
    await plugin.handleWebhook(tokenReq(agentReply(fake.onlyConversation().id, 'mira', {
      attachments: [{ file_type: 'image', data_url: 'https://cdn.example.com/a.png' }, { file_type: 'file', data_url: 'https://cdn.example.com/b.pdf' }],
    })))
    const out = provider.outbox.filter((m) => m.chatId === CHAT).map((m) => m.content)
    expect(out).toEqual([
      { kind: 'image', media: { url: 'https://cdn.example.com/a.png' }, caption: 'mira' },
      { kind: 'document', media: { url: 'https://cdn.example.com/b.pdf' }, filename: 'b.pdf' },
    ])
    await bot.stop()
  })
})

describe('chatwootPlugin — attachment hardening (security audit)', () => {
  it('forwards only http(s) attachment URLs and never a path-like filename', async () => {
    const { bot, chat, provider } = await createTestBot()
    const { fake, plugin } = setup()
    bot.plug(plugin)
    await chat.send('hola')
    await plugin.flush()
    await plugin.handleWebhook(tokenReq(agentReply(fake.onlyConversation().id, '', {
      attachments: [
        // Some transports (Baileys) read a non-http `{ url }` from the local disk.
        { file_type: 'file', data_url: '/etc/passwd' },
        { file_type: 'file', data_url: 'file:///etc/passwd' },
        { file_type: 'file', data_url: 'https://cdn.example.com/x/..%2F..%2Fsecret.pdf' },
        { file_type: 'file', data_url: 'https://cdn.example.com/bad%E0%A4%A.pdf' },
      ],
    })))
    const out = provider.outbox.filter((m) => m.chatId === CHAT).map((m) => m.content) as Array<{ kind: string; media: { url: string }; filename?: string }>
    expect(out.map((c) => c.media.url)).toEqual(['https://cdn.example.com/x/..%2F..%2Fsecret.pdf', 'https://cdn.example.com/bad%E0%A4%A.pdf'])
    for (const c of out) expect(c.filename ?? '').not.toMatch(/[\x5c/]/)
    await bot.stop()
  })
})

describe('chatwootPlugin — webhook authentication', () => {
  it('requires webhookToken or webhookSecret', () => {
    expect(() => chatwootPlugin({ baseUrl: 'https://x.example.com', apiKey: 'k', accountId: 1, inboxId: 2 })).toThrow(/webhookToken|webhookSecret/)
    expect(() => chatwootPlugin({ baseUrl: 'https://x.example.com', apiKey: 'k', accountId: 1, inboxId: 2, insecureNoWebhookAuth: true })).not.toThrow()
    expect(() => setup({ baseUrl: 'not a url' })).toThrow(/baseUrl/)
  })

  it('token: query ?token=, x-chatwoot-token header or Bearer; wrong/missing → 401', async () => {
    const { bot } = await createTestBot()
    const { plugin } = setup()
    bot.plug(plugin)
    const ping = JSON.stringify({ event: 'conversation_created', id: 1 })
    expect((await plugin.handleWebhook({ rawBody: ping, headers: {} })).status).toBe(401)
    expect((await plugin.handleWebhook({ rawBody: ping, headers: {}, query: { token: 'nope' } })).status).toBe(401)
    expect((await plugin.handleWebhook({ rawBody: ping, headers: {}, query: new URLSearchParams('token=hook-token') })).status).toBe(200)
    expect((await plugin.handleWebhook({ rawBody: ping, headers: { 'x-chatwoot-token': 'hook-token' } })).status).toBe(200)
    expect((await plugin.handleWebhook({ rawBody: ping, headers: { authorization: 'Bearer hook-token' } })).status).toBe(200)
    expect((await plugin.handleWebhook({ rawBody: '{not json', headers: { 'x-chatwoot-token': 'hook-token' } })).status).toBe(400)
    await bot.stop()
  })

  it('HMAC: signature over the raw body (optionally timestamp-bound) with tolerance', async () => {
    const { bot } = await createTestBot()
    const now = 1_800_000_000_000
    const { plugin } = setup({ webhookToken: undefined, webhookSecret: 'shh', now: () => now })
    bot.plug(plugin)
    const raw = Buffer.from(JSON.stringify({ event: 'conversation_created', id: 1 }))
    const sig = (msg: string | Buffer) => createHmac('sha256', 'shh').update(msg).digest('hex')

    expect((await plugin.handleWebhook({ rawBody: raw, headers: { 'x-chatwoot-signature': sig(raw) } })).status).toBe(200)
    expect((await plugin.handleWebhook({ rawBody: raw, headers: { 'x-chatwoot-signature': `sha256=${sig(raw)}` } })).status).toBe(200)
    expect((await plugin.handleWebhook({ rawBody: raw, headers: { 'x-chatwoot-signature': sig('other') } })).status).toBe(401)
    expect((await plugin.handleWebhook({ rawBody: raw, headers: {} })).status).toBe(401)
    // re-serialized JSON is not the raw body → rejected
    const reserialized = JSON.stringify(JSON.parse(raw.toString()), null, 2)
    expect((await plugin.handleWebhook({ rawBody: reserialized, headers: { 'x-chatwoot-signature': sig(raw) } })).status).toBe(401)

    const ts = String(Math.floor(now / 1000))
    const tsSig = sig(`${ts}.${raw.toString()}`)
    expect((await plugin.handleWebhook({ rawBody: raw, headers: { 'x-chatwoot-signature': `sha256=${tsSig}`, 'x-chatwoot-timestamp': ts } })).status).toBe(200)
    const old = String(Math.floor(now / 1000) - 3600)
    const oldSig = sig(`${old}.${raw.toString()}`)
    expect((await plugin.handleWebhook({ rawBody: raw, headers: { 'x-chatwoot-signature': oldSig, 'x-chatwoot-timestamp': old } })).status).toBe(401)
    await bot.stop()
  })

  it('answers 503 before the plugin is installed', async () => {
    const { plugin } = setup()
    expect((await plugin.handleWebhook(tokenReq({ event: 'x' }))).status).toBe(503)
  })
})

describe('chatwootPlugin — persistence', () => {
  it('keeps the chat ↔ conversation mapping in the bot store across restarts', async () => {
    const store = new MemoryStore()
    const fake = new FakeChatwoot()
    const cfg = {
      baseUrl: 'https://chatwoot.example.com', apiKey: 'secret-key', accountId: 1, inboxId: 2, webhookToken: 'hook-token',
      http: { fetch: fake.fetch as typeof globalThis.fetch, resolver: publicResolver },
    }
    const p1 = new MockProvider()
    const bot1 = new Bot({ provider: p1, store })
    const plugin1 = chatwootPlugin(cfg)
    bot1.plug(plugin1)
    await bot1.start()
    p1.incoming('hola', { from: 'chat-A' })
    await tick()
    await plugin1.flush()
    await bot1.stop()
    const conv = fake.onlyConversation()

    const p2 = new MockProvider()
    const bot2 = new Bot({ provider: p2, store })
    const plugin2 = chatwootPlugin(cfg)
    bot2.plug(plugin2)
    await bot2.start()
    // webhook for the old conversation is routed to the right chat after the restart
    await plugin2.handleWebhook(tokenReq(agentReply(conv.id, 'seguimos')))
    expect(p2.outbox.map((m) => m.chatId)).toEqual(['chat-A'])
    p2.incoming('otra', { from: 'chat-A' })
    await tick()
    await plugin2.flush()
    expect(fake.contacts).toHaveLength(1)
    expect(fake.conversations.size).toBe(1)
    expect(conv.messages.map((m) => m.content)).toEqual(['hola', 'otra'])
    await bot2.stop()
  })
})

describe('chatwootPlugin — node webhookHandler', () => {
  function fakeReqRes(method: string, url: string, body: string, headers: Record<string, string> = {}) {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url, headers })
    let resolve!: (v: { status: number; body: string }) => void
    const done = new Promise<{ status: number; body: string }>((r) => { resolve = r })
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader() {},
      end(b: string) { this.headersSent = true; resolve({ status: this.statusCode, body: b }) },
    }
    return { req, res, done }
  }

  it('reads the raw body, takes ?token= from the URL and enforces method/size', async () => {
    const { bot } = await createTestBot()
    const { plugin } = setup()
    bot.plug(plugin)
    const handler = plugin.webhookHandler({ maxBytes: 64 })
    const ok = fakeReqRes('POST', '/chatwoot?token=hook-token', JSON.stringify({ event: 'ping' }))
    handler(ok.req as never, ok.res as never)
    expect(await ok.done).toEqual({ status: 200, body: 'ok' })
    const get = fakeReqRes('GET', '/chatwoot?token=hook-token', '')
    handler(get.req as never, get.res as never)
    expect((await get.done).status).toBe(405)
    const big = fakeReqRes('POST', '/chatwoot?token=hook-token', 'x'.repeat(200))
    handler(big.req as never, big.res as never)
    expect((await big.done).status).toBe(413)
    const noTok = fakeReqRes('POST', '/chatwoot', '{}')
    handler(noTok.req as never, noTok.res as never)
    expect((await noTok.done).status).toBe(401)
    await bot.stop()
  })
})
