import { describe, it, expect, vi } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { Dispatcher } from '../src/core/Dispatcher.js'
import { buildMessageContext } from '../src/core/context.js'
import { ConversationRuntime } from '../src/conversations/ConversationRuntime.js'
import { createControls } from '../src/conversations/controls.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import type { BotConfig, MessageContext, StoredChat } from '../src/core/types.js'
import type { HandoffEvent, ResumeEvent } from '../src/index.js'

/* ------------------------------------------------------------------------- */

type TestConfig = Omit<BotConfig, 'provider'>

function setup(config: TestConfig = {}) {
  const provider = new MockProvider()
  const bot = new Bot({ ...config, provider })
  return { bot, provider }
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function texts(provider: MockProvider, chatId?: string): string[] {
  return provider.outbox
    .filter((m) => chatId === undefined || m.chatId === chatId)
    .map((m) => (m.content.kind === 'text' ? m.content.text : `[${m.content.kind}]`))
}

async function waitForText(provider: MockProvider, text: string, chatId?: string): Promise<void> {
  await vi.waitFor(() => expect(texts(provider, chatId)).toContain(text), { timeout: 1000, interval: 5 })
}

const G = 'group-1'
const H = 'group-2'

/**
 * Registers the flow used by many tests: '¿nombre?' then 'fin <name>'. The persistent
 * variant starts with a `say` so a checkpoint exists while the `ask` is pending.
 */
function registerFlow(bot: Bot, opts: { persistent?: boolean } = {}) {
  const f = flow('registro')
  if (opts.persistent) f.persistent().say('bienvenido')
  bot.use(f
    .ask('¿nombre?', 'name')
    .say((_ctx, c) => `fin ${String(c.state.name)}`))
}

/* ------------------------------------------------------------------------- */

describe('human handoff — API', () => {
  it('ctx.handoff() pauses routing for the chat; the triggering handler can still reply', async () => {
    const { bot, provider } = setup()
    bot.when('humano', async (ctx) => {
      expect(await ctx.handoff({ reason: 'asked' })).toBe(true)
      await ctx.reply('Te conecto con un agente')
    })
    bot.when('hola', async (ctx) => { await ctx.reply('hi') })
    bot.command('help', async (ctx) => { await ctx.reply('help') })
    bot.onMessage(async (ctx) => { await ctx.reply('fallback') })
    await bot.start()

    provider.incoming('humano', { from: 'u1' })
    await waitForText(provider, 'Te conecto con un agente')
    expect(bot.isHandedOff('u1')).toBe(true)

    provider.incoming('hola', { from: 'u1' })
    provider.incoming('/help', { from: 'u1' })
    provider.incoming('qwerty', { from: 'u1' })
    await tick()
    expect(texts(provider)).toEqual(['Te conecto con un agente'])
  })

  it('messages already queued behind the handoff trigger are gated too', async () => {
    const { bot, provider } = setup()
    bot.when('humano', async (ctx) => { void ctx.handoff(); await tick(5) })
    bot.onMessage(async (ctx) => { await ctx.reply('fallback') })
    await bot.start()

    provider.incoming('humano', { from: 'u1' })
    provider.incoming('hola', { from: 'u1' })
    await tick(40)
    expect(texts(provider)).toEqual([])
  })

  it('emits handoff and resume events carrying the state', async () => {
    const { bot } = setup()
    const handoffs: HandoffEvent[] = []
    const resumes: ResumeEvent[] = []
    bot.on('handoff', (e) => handoffs.push(e))
    bot.on('resume', (e) => resumes.push(e))
    await bot.start()

    const before = Date.now()
    await bot.handoff('u1', { reason: 'vip', meta: { agent: 'ana' } })
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]).toMatchObject({ chatId: 'u1', reason: 'vip', meta: { agent: 'ana' } })
    expect(handoffs[0]!.since).toBeGreaterThanOrEqual(before)

    await bot.resume('u1', { reason: 'ticket closed' })
    expect(resumes).toHaveLength(1)
    expect(resumes[0]).toMatchObject({
      chatId: 'u1',
      reason: 'ticket closed',
      handoff: { chatId: 'u1', reason: 'vip', meta: { agent: 'ana' } },
    })
    expect(resumes[0]!.at).toBeGreaterThanOrEqual(handoffs[0]!.since)
  })

  it('handoff()/resume() are idempotent and report whether the state changed', async () => {
    const { bot } = setup()
    const onHandoff = vi.fn()
    const onResume = vi.fn()
    bot.on('handoff', onHandoff)
    bot.on('resume', onResume)
    await bot.start()

    expect(await bot.handoff('u1')).toBe(true)
    expect(await bot.handoff('u1', { reason: 'again' })).toBe(false)
    expect(bot.getHandoff('u1')?.reason).toBeUndefined()   // the first handoff is kept
    expect(onHandoff).toHaveBeenCalledOnce()

    expect(await bot.resume('u1')).toBe(true)
    expect(await bot.resume('u1')).toBe(false)
    expect(await bot.resume('never-handed-off')).toBe(false)
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('getHandoff()/listHandoffs() expose the current state', async () => {
    const { bot } = setup()
    await bot.start()
    expect(bot.getHandoff('u1')).toBeUndefined()
    expect(bot.listHandoffs()).toEqual([])

    await bot.handoff('u1', { reason: 'a' })
    await bot.handoff(G, { reason: 'b' })
    expect(bot.getHandoff('u1')).toMatchObject({ chatId: 'u1', reason: 'a' })
    expect(bot.listHandoffs().map((s) => s.chatId).sort()).toEqual([G, 'u1'].sort())

    // Returned objects are snapshots — mutating them must not change the registry.
    const snap = bot.getHandoff('u1')!
    snap.reason = 'tampered'
    expect(bot.getHandoff('u1')?.reason).toBe('a')

    await bot.resume('u1')
    expect(bot.listHandoffs().map((s) => s.chatId)).toEqual([G])
  })

  it('rejects an invalid chat id with a TypeError', async () => {
    const { bot } = setup()
    expect(() => bot.handoff('')).toThrow(TypeError)
    expect(() => bot.handoff(42 as unknown as string)).toThrow(TypeError)
  })

  it('resume() restores normal routing', async () => {
    const { bot, provider } = setup()
    bot.when('hola', async (ctx) => { await ctx.reply('hi') })
    await bot.start()

    await bot.handoff('u1')
    provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(texts(provider)).toEqual([])

    await bot.resume('u1')
    provider.incoming('hola', { from: 'u1' })
    await waitForText(provider, 'hi')
  })

  it('is per chat: other chats keep routing', async () => {
    const { bot, provider } = setup()
    bot.when('hola', async (ctx) => { await ctx.reply(`hi ${ctx.from}`) })
    await bot.start()

    await bot.handoff('u1')
    provider.incoming('hola', { from: 'u1' })
    provider.incoming('hola', { from: 'u2' })
    await waitForText(provider, 'hi u2')
    await tick()
    expect(texts(provider)).toEqual(['hi u2'])
  })

  it('keeps persisting inbound messages and emitting the message event while handed off', async () => {
    const { bot, provider } = setup()
    const seen: string[] = []
    bot.on('message', (ctx) => seen.push(ctx.body))
    bot.onMessage(async (ctx) => { await ctx.reply('fallback') })
    await bot.start()

    await bot.handoff('u1')
    provider.incoming('necesito ayuda', { from: 'u1' })
    await vi.waitFor(() => expect(seen).toEqual(['necesito ayuda']))
    const stored = await bot.getStore().getMessagesByChat('u1')
    expect(stored.map((m) => [m.direction, m.body])).toEqual([['inbound', 'necesito ayuda']])
    expect(texts(provider)).toEqual([])
  })

  it('gates interactions (buttons/callbacks) too', async () => {
    const { bot, provider } = setup()
    const handler = vi.fn()
    bot.onMessage(handler)
    await bot.start()

    await bot.handoff('u1')
    provider.interaction('btn-1', { from: 'u1' })
    await tick()
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not emit command:unknown for a gated command', async () => {
    const { bot, provider } = setup()
    const unknown = vi.fn()
    bot.on('command:unknown', unknown)
    await bot.start()

    await bot.handoff('u1')
    provider.incoming('/nope', { from: 'u1' })
    await tick()
    expect(unknown).not.toHaveBeenCalled()
  })

  it('sendTo() delivers text or content through the send pipeline while handed off', async () => {
    const { bot, provider } = setup()
    const beforeSend = vi.fn(async (_p: unknown, next: () => Promise<void>) => { await next() })
    bot.before('send', beforeSend)
    await bot.start()

    await bot.handoff('u1')
    const sent = await bot.sendTo('u1', 'Hola, soy Ana')
    await bot.sendTo('u1', { kind: 'image', media: 'https://example.com/a.png', caption: 'catálogo' })
    expect(sent.chatId).toBe('u1')
    expect(provider.outbox.map((m) => m.content)).toEqual([
      { kind: 'text', text: 'Hola, soy Ana' },
      { kind: 'image', media: 'https://example.com/a.png', caption: 'catálogo' },
    ])
    expect(beforeSend).toHaveBeenCalledTimes(2)
    const stored = await bot.getStore().getMessagesByChat('u1')
    expect(stored.map((m) => [m.direction, m.body])).toEqual([['outbound', 'Hola, soy Ana'], ['outbound', 'catálogo']])
    expect(bot.isHandedOff('u1')).toBe(true)   // sending as an agent does not resume the bot
  })

  it('ctx.handoff() on a context built without a bot resolves false', async () => {
    const ctx = buildMessageContext({
      inbound: {
        ref: { id: 'm1', chatId: 'u1' },
        chat: { id: 'u1', kind: 'dm', isGroup: false, isBroadcast: false },
        senderInfo: { id: 'u1' },
        from: 'u1', sender: 'u1', chatId: 'u1', senderId: 'u1',
        isGroup: false, isBroadcast: false, fromMe: false,
        type: 'text', body: 'x', timestamp: 0, mentions: [], raw: {},
      },
      tools: {},
      send: async (chatId) => ({ ref: { id: 'o1', chatId } }),
    })
    expect(await ctx.handoff()).toBe(false)
  })

  it('plugins can drive handoff through their scoped bot', async () => {
    const { bot, provider } = setup()
    bot.plug({
      name: 'agent-desk',
      version: '1.0.0',
      install({ bot: scoped }) {
        scoped.command('agente', async (ctx) => { await scoped.handoff(ctx.from, { reason: 'plugin' }) })
      },
    })
    await bot.start()
    provider.incoming('/agente', { from: 'u1' })
    await vi.waitFor(() => expect(bot.isHandedOff('u1')).toBe(true))
    expect(bot.getHandoff('u1')?.reason).toBe('plugin')
  })
})

/* ------------------------------------------------------------------------- */

describe('human handoff — conversations', () => {
  it('cancels the active conversation silently when the handoff starts', async () => {
    const { bot, provider } = setup({ conversation: { cancelledMessage: 'conversación cancelada' } })
    registerFlow(bot)
    bot.onMessage(async (ctx) => { await ctx.reply(`fallback ${ctx.body}`) })
    await bot.start()

    provider.incoming('registro', { from: 'u1' })
    await waitForText(provider, '¿nombre?')
    await bot.handoff('u1')
    provider.incoming('Ana', { from: 'u1' })
    await tick()
    expect(texts(provider)).toEqual(['¿nombre?'])   // no cancel message, no 'fin Ana'

    // After resuming, the old conversation is gone: the answer routes like any message.
    await bot.resume('u1')
    provider.incoming('Ana', { from: 'u1' })
    await waitForText(provider, 'fallback Ana')
    expect(texts(provider)).not.toContain('fin Ana')
  })

  it('handoff from inside a flow step ends that flow (later steps never run)', async () => {
    const { bot, provider } = setup()
    bot.use(flow('soporte')
      .do(async (ctx) => {
        await (ctx as unknown as MessageContext).handoff({ reason: 'flow' })
        await ctx.reply('Un agente te atenderá')
      })
      .say('NO DEBE SALIR'))
    await bot.start()

    provider.incoming('soporte', { from: 'u1' })
    await waitForText(provider, 'Un agente te atenderá')
    await tick()
    expect(texts(provider)).toEqual(['Un agente te atenderá'])
    expect(bot.getHandoff('u1')?.reason).toBe('flow')
  })

  it("participant scope: cancels every participant's conversation in that group only", async () => {
    const { bot, provider } = setup()   // conversationScope defaults to 'participant'
    registerFlow(bot)
    await bot.start()

    provider.incoming('registro', { from: G, sender: 'a', isGroup: true })
    provider.incoming('registro', { from: G, sender: 'b', isGroup: true })
    provider.incoming('registro', { from: H, sender: 'c', isGroup: true })
    provider.incoming('registro', { from: 'a' })   // a's DM with the bot
    await vi.waitFor(() => expect(texts(provider).filter((t) => t === '¿nombre?')).toHaveLength(4))

    await bot.handoff(G)
    provider.incoming('A', { from: G, sender: 'a', isGroup: true })
    provider.incoming('B', { from: G, sender: 'b', isGroup: true })
    provider.incoming('C', { from: H, sender: 'c', isGroup: true })
    provider.incoming('DM', { from: 'a' })
    await waitForText(provider, 'fin C', H)
    await waitForText(provider, 'fin DM', 'a')
    await tick()
    expect(texts(provider, G)).toEqual(['¿nombre?', '¿nombre?'])
  })

  it('chat scope: cancels the shared group conversation', async () => {
    const { bot, provider } = setup({ conversationScope: 'chat' })
    registerFlow(bot)
    await bot.start()

    provider.incoming('registro', { from: G, sender: 'a', isGroup: true })
    await waitForText(provider, '¿nombre?', G)
    await bot.handoff(G)
    await bot.resume(G)
    provider.incoming('B', { from: G, sender: 'b', isGroup: true })
    await tick()
    expect(texts(provider, G)).toEqual(['¿nombre?'])
  })

  it('persistent flow: the handoff clears its checkpoint', async () => {
    const store = new MemoryStore({})
    const provider = new MockProvider()
    const bot = new Bot({ provider, store })
    registerFlow(bot, { persistent: true })
    await bot.start()

    provider.incoming('registro', { from: 'u1' })
    await waitForText(provider, '¿nombre?')
    await vi.waitFor(async () => expect(await bot.getStore().listCheckpoints()).toHaveLength(1))

    await bot.handoff('u1')
    await vi.waitFor(async () => expect(await bot.getStore().listCheckpoints()).toEqual([]))
  })

  it('a dormant checkpoint is dropped, not resumed, when its chat is handed off after a restart', async () => {
    const store = new MemoryStore({})
    const p1 = new MockProvider()
    const bot1 = new Bot({ provider: p1, store })
    registerFlow(bot1, { persistent: true })
    await bot1.start()
    p1.incoming('registro', { from: 'u1' })
    await waitForText(p1, '¿nombre?')
    await vi.waitFor(async () => expect(await bot1.getStore().listCheckpoints()).toHaveLength(1))
    await bot1.stop()   // graceful stop preserves the checkpoint for resume-on-restart

    const p2 = new MockProvider()
    const bot2 = new Bot({ provider: p2, store })
    registerFlow(bot2, { persistent: true })
    bot2.onMessage(async (ctx) => { await ctx.reply(`fallback ${ctx.body}`) })
    await bot2.start()
    expect(await bot2.getStore().listCheckpoints()).toHaveLength(1)

    await bot2.handoff('u1')
    p2.incoming('hola', { from: 'u1' })
    await tick()
    expect(texts(p2)).toEqual([])
    await vi.waitFor(async () => expect(await bot2.getStore().listCheckpoints()).toEqual([]))

    await bot2.resume('u1')
    p2.incoming('Ana', { from: 'u1' })
    await waitForText(p2, 'fallback Ana')
    expect(texts(p2)).not.toContain('¿nombre?')
  })
})

/* ------------------------------------------------------------------------- */

describe('human handoff — escape commands (handoff.allowCommands)', () => {
  it('an allowed command routes normally while handed off; other commands stay gated', async () => {
    const { bot, provider } = setup({ handoff: { allowCommands: ['/bot'] } })
    bot.command('bot', async (ctx) => {
      await bot.resume(ctx.from)
      await ctx.reply('🤖 de vuelta')
    })
    bot.command('help', async (ctx) => { await ctx.reply('help') })
    await bot.start()

    await bot.handoff('u1')
    provider.incoming('/help', { from: 'u1' })
    await tick()
    expect(texts(provider)).toEqual([])

    provider.incoming('/BOT', { from: 'u1' })   // command names are normalized (case-insensitive)
    await waitForText(provider, '🤖 de vuelta')
    expect(bot.isHandedOff('u1')).toBe(false)

    provider.incoming('/help', { from: 'u1' })
    await waitForText(provider, 'help')
  })

  it('accepts names with or without the configured prefix', async () => {
    const { bot, provider } = setup({ commandPrefix: '!', handoff: { allowCommands: ['bot', ' !Agente '] } })
    bot.command('bot', async (ctx) => { await ctx.reply('bot ok') })
    bot.command('agente', async (ctx) => { await ctx.reply('agente ok') })
    await bot.start()

    await bot.handoff('u1')
    provider.incoming('!bot', { from: 'u1' })
    provider.incoming('!agente ahora', { from: 'u1' })
    await waitForText(provider, 'bot ok')
    await waitForText(provider, 'agente ok')
  })

  it('an allowed command with no registered handler stays gated (never reaches the catch-all)', async () => {
    const { bot, provider } = setup({ handoff: { allowCommands: ['/bot'] } })
    const fallback = vi.fn()
    const unknown = vi.fn()
    bot.onMessage(fallback)
    bot.on('command:unknown', unknown)
    await bot.start()

    await bot.handoff('u1')
    provider.incoming('/bot', { from: 'u1' })
    await tick()
    expect(fallback).not.toHaveBeenCalled()
    expect(unknown).not.toHaveBeenCalled()
  })

  it('validates the handoff config', () => {
    const provider = new MockProvider()
    expect(() => new Bot({ provider, handoff: { allowCommands: 'bot' as unknown as string[] } })).toThrow(/handoff\.allowCommands/)
    expect(() => new Bot({ provider, handoff: { allowCommands: [''] } })).toThrow(/handoff\.allowCommands/)
    expect(() => new Bot({ provider, handoff: { persist: 'yes' as unknown as boolean } })).toThrow(/handoff\.persist/)
  })
})

/* ------------------------------------------------------------------------- */

describe('human handoff — pipeline ordering', () => {
  it('before(message) hooks run first and still see handed-off messages; after hooks run too', async () => {
    const { bot, provider } = setup()
    const order: string[] = []
    bot.before('message', async (ctx: MessageContext, next) => { order.push(`before:${ctx.body}`); await next() })
    bot.after('message', async (ctx: MessageContext) => { order.push(`after:${ctx.body}`) })
    bot.on('message', (ctx) => order.push(`event:${ctx.body}`))
    bot.onMessage(async (ctx) => { order.push(`handler:${ctx.body}`) })
    await bot.start()

    await bot.handoff('u1')
    provider.incoming('hola', { from: 'u1' })
    await vi.waitFor(() => expect(order).toEqual(['before:hola', 'after:hola', 'event:hola']))
  })

  it('a before(message) hook can still abort a handed-off message (no message event)', async () => {
    const { bot, provider } = setup()
    const seen = vi.fn()
    bot.before('message', async (ctx: MessageContext) => { ctx.abort() })
    bot.on('message', seen)
    await bot.start()

    await bot.handoff('u1')
    provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(seen).not.toHaveBeenCalled()
  })

  it('commands, active conversation, dormant resume, matchers and catch-all are all skipped', async () => {
    const store = new MemoryStore({})
    const { bot, provider } = setup({ store })
    registerFlow(bot)
    const calls: string[] = []
    bot.command('reset', async () => { calls.push('command') })
    bot.when('hola', async () => { calls.push('matcher') })
    bot.onImage(async () => { calls.push('onType') })
    bot.onMessage(async () => { calls.push('catch-all') })
    await bot.start()

    provider.incoming('registro', { from: 'u1' })
    await waitForText(provider, '¿nombre?')
    await bot.handoff('u1')

    provider.incoming('/reset', { from: 'u1' })
    provider.incoming('hola', { from: 'u1' })
    provider.incoming('', { from: 'u1', type: 'image' })
    provider.incoming('Ana', { from: 'u1' })
    await tick()
    expect(calls).toEqual([])
    expect(texts(provider)).toEqual(['¿nombre?'])
  })

  it('in a group, the handoff gates every participant (not just the one who asked)', async () => {
    const { bot, provider } = setup()
    bot.when('humano', async (ctx) => { await ctx.handoff() })
    bot.when('hola', async (ctx) => { await ctx.reply(`hi ${ctx.sender}`) })
    await bot.start()

    provider.incoming('humano', { from: G, sender: 'a', isGroup: true })
    await vi.waitFor(() => expect(bot.isHandedOff(G)).toBe(true))
    provider.incoming('hola', { from: G, sender: 'b', isGroup: true })
    provider.incoming('hola', { from: 'b' })   // b's DM is a different chat
    await waitForText(provider, 'hi b', 'b')
    await tick()
    expect(texts(provider, G)).toEqual([])
  })
})

/* ------------------------------------------------------------------------- */

describe('human handoff — persistence', () => {
  it('survives a restart when the bots share a persistent store', async () => {
    const store = new MemoryStore({})
    const p1 = new MockProvider()
    const bot1 = new Bot({ provider: p1, store })
    await bot1.start()
    await bot1.handoff('u1', { reason: 'agent', meta: { agent: 'ana' } })
    // A later inbound upsert of the same chat must not wipe the handoff (shallow merge).
    p1.incoming('hola', { from: 'u1' })
    await vi.waitFor(async () => expect(await bot1.getStore().getMessagesByChat('u1')).toHaveLength(1))
    await bot1.stop()

    const p2 = new MockProvider()
    const bot2 = new Bot({ provider: p2, store })
    bot2.when('hola', async (ctx) => { await ctx.reply('hi') })
    await bot2.start()
    expect(bot2.isHandedOff('u1')).toBe(true)
    expect(bot2.getHandoff('u1')).toMatchObject({ chatId: 'u1', reason: 'agent', meta: { agent: 'ana' } })
    p2.incoming('hola', { from: 'u1' })
    await tick()
    expect(texts(p2)).toEqual([])

    await bot2.resume('u1')
    await bot2.stop()

    const bot3 = new Bot({ provider: new MockProvider(), store })
    await bot3.start()
    expect(bot3.isHandedOff('u1')).toBe(false)
    await bot3.stop()
  })

  it('stores the state on StoredChat.handoff and clears it on resume', async () => {
    const { bot } = setup()
    await bot.start()
    await bot.handoff(G, { reason: 'queue' })
    const chat = (await bot.getStore().getChat(G)) as StoredChat
    expect(chat.handoff).toMatchObject({ reason: 'queue' })
    expect(typeof chat.handoff?.since).toBe('number')

    await bot.resume(G)
    expect((await bot.getStore().getChat(G))?.handoff ?? undefined).toBeUndefined()
  })

  it('handoff.persist: false keeps the state in memory only', async () => {
    const store = new MemoryStore({})
    const bot1 = new Bot({ provider: new MockProvider(), store, handoff: { persist: false } })
    await bot1.start()
    await bot1.handoff('u1')
    expect(bot1.isHandedOff('u1')).toBe(true)
    expect((await bot1.getStore().getChat('u1'))?.handoff ?? undefined).toBeUndefined()
    await bot1.stop()

    const bot2 = new Bot({ provider: new MockProvider(), store, handoff: { persist: false } })
    await bot2.start()
    expect(bot2.isHandedOff('u1')).toBe(false)
  })

  it('a store failure while persisting is reported on the error event; the state still flips', async () => {
    class FailingStore extends MemoryStore {
      override async upsertChat(chat: StoredChat): Promise<void> {
        if ('handoff' in chat) throw new Error('disk full')
        return super.upsertChat(chat)
      }
    }
    const provider = new MockProvider()
    const bot = new Bot({ provider, store: new FailingStore({}) })
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    await bot.start()

    expect(await bot.handoff('u1')).toBe(true)
    expect(bot.isHandedOff('u1')).toBe(true)
    expect(errors).toHaveLength(1)
    expect(String((errors[0] as Error).message)).toContain('disk full')

    expect(await bot.resume('u1')).toBe(true)
    expect(bot.isHandedOff('u1')).toBe(false)
    expect(errors).toHaveLength(2)
  })

  /**
   * Real stores merge chat records with a non-atomic read-modify-write. This one widens the
   * window so two overlapping upserts of the same chat lose an update unless the Bot
   * serializes its chat writes.
   */
  class ReadModifyWriteStore extends MemoryStore {
    override async upsertChat(chat: StoredChat): Promise<void> {
      const existing = await this.getChat(chat.id)
      await tick(5)
      ;(this as unknown as { chats: Map<string, StoredChat> }).chats.set(chat.id, { ...existing, ...chat })
    }
  }

  it('a handoff write racing an inbound upsert of the same chat is not lost', async () => {
    const store = new ReadModifyWriteStore({})
    const p1 = new MockProvider()
    const bot1 = new Bot({ provider: p1, store })
    await bot1.start()
    const handedOff = bot1.handoff('u1', { reason: 'race' })
    await tick(1)   // the handoff write has read the record and is mid-flight
    p1.incoming('hola', { from: 'u1' })
    await handedOff
    await vi.waitFor(async () => expect(await bot1.getStore().getMessagesByChat('u1')).toHaveLength(1))
    await tick(20)
    await bot1.stop()

    const bot2 = new Bot({ provider: new MockProvider(), store })
    await bot2.start()
    expect(bot2.isHandedOff('u1')).toBe(true)
    await bot2.stop()
  })

  it('a resume write racing an inbound upsert of the same chat is not lost', async () => {
    const store = new ReadModifyWriteStore({})
    const p1 = new MockProvider()
    const bot1 = new Bot({ provider: p1, store })
    await bot1.start()
    await bot1.handoff('u1')
    const resumed = bot1.resume('u1')
    await tick(1)   // the resume write has read the record and is mid-flight
    p1.incoming('gracias', { from: 'u1' })
    await resumed
    await vi.waitFor(async () => expect(await bot1.getStore().getMessagesByChat('u1')).toHaveLength(1))
    await tick(20)
    await bot1.stop()

    const bot2 = new Bot({ provider: new MockProvider(), store })
    await bot2.start()
    expect(bot2.isHandedOff('u1')).toBe(false)
    await bot2.stop()
  })

  it('a handoff write racing the outbound ledger upsert of the same chat is not lost', async () => {
    const store = new ReadModifyWriteStore({})
    const p1 = new MockProvider()
    const bot1 = new Bot({ provider: p1, store })
    await bot1.start()
    const sent = bot1.sendTo('u1', 'hola')   // persistOutbound upserts the chat too
    void bot1.handoff('u1')
    await sent
    await tick(30)
    await bot1.stop()

    const bot2 = new Bot({ provider: new MockProvider(), store })
    await bot2.start()
    expect(bot2.isHandedOff('u1')).toBe(true)
    await bot2.stop()
  })

  it('a throwing handoff listener is routed to the error event instead of breaking the caller', async () => {
    const { bot } = setup()
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    bot.on('handoff', () => { throw new Error('listener boom') })
    await bot.start()
    expect(await bot.handoff('u1')).toBe(true)
    expect(errors.map((e) => (e as Error).message)).toEqual(['listener boom'])
  })
})

/* ------------------------------------------------------------------------- */

describe('Dispatcher routing gate (unit)', () => {
  function makeCtx(body: string) {
    const ctx: any = {
      from: 'u1', sender: 'u1', body, type: 'text', isGroup: false,
      reply: vi.fn(async () => {}),
      _passed: false, _aborted: false,
      pass() { this._passed = true }, abort() { this._aborted = true },
    }
    return ctx
  }
  function make(gate: (ctx: unknown) => boolean, runBefore = async () => true) {
    const runtime = new ConversationRuntime({ controlsFactory: (r, h, c) => createControls(r, h, c) })
    const hooks = { runBefore: vi.fn(runBefore), runAfter: vi.fn(async () => {}), runError: vi.fn(async () => {}) }
    const emitted: string[] = []
    const gateSpy = vi.fn(gate)
    const d = new Dispatcher({ hooks, runtime, gate: gateSpy, emit: (e) => { emitted.push(e); return false } })
    return { d, hooks, emitted, gateSpy, runtime }
  }

  it('a closed gate skips every routing stage but still runs after hooks and emits message', async () => {
    const { d, hooks, emitted } = make(() => false)
    const command = vi.fn(); const matcher = vi.fn(); const catchAll = vi.fn()
    d.command('x', command)
    d.matcher('hola', matcher)
    d.catchAll(catchAll)
    await d.dispatch(makeCtx('/x'))
    await d.dispatch(makeCtx('/unknown'))
    await d.dispatch(makeCtx('hola'))
    expect(command).not.toHaveBeenCalled()
    expect(matcher).not.toHaveBeenCalled()
    expect(catchAll).not.toHaveBeenCalled()
    expect(hooks.runAfter).toHaveBeenCalledTimes(3)
    expect(emitted).toEqual(['message', 'message', 'message'])
  })

  it('the gate is evaluated after before hooks (an aborting hook short-circuits it)', async () => {
    const { d, gateSpy } = make(() => true, async () => false)
    await d.dispatch(makeCtx('hola'))
    expect(gateSpy).not.toHaveBeenCalled()
  })

  it('an open gate routes normally', async () => {
    const { d, gateSpy } = make(() => true)
    const matcher = vi.fn()
    d.matcher('hola', matcher)
    await d.dispatch(makeCtx('hola'))
    expect(gateSpy).toHaveBeenCalledOnce()
    expect(matcher).toHaveBeenCalledOnce()
  })

  it('hasCommand() reports registered command names (normalized)', () => {
    const { d } = make(() => true)
    const off = d.command('Bot', vi.fn())
    expect(d.hasCommand('bot')).toBe(true)
    expect(d.hasCommand('BOT')).toBe(true)
    expect(d.hasCommand('other')).toBe(false)
    off()
    expect(d.hasCommand('bot')).toBe(false)
  })
})

/* ------------------------------------------------------------------------- */

describe('ConversationRuntime.abortChat', () => {
  function makeMsg(from: string, sender: string, isGroup: boolean, body = 'x') {
    return { from, sender, body, type: 'text', isGroup, reply: vi.fn(async () => {}) }
  }

  it('aborts silently every conversation in a chat across participants, leaving other chats alone', async () => {
    const rt = new ConversationRuntime({ controlsFactory: (r, h, c) => createControls(r, h, c), cancelledMessage: 'cancelado' })
    rt.register('ask', async (c) => { await c.waitAny() })
    const a = makeMsg(G, 'a', true); const b = makeMsg(G, 'b', true)
    const other = makeMsg(H, 'a', true); const dm = makeMsg('a', 'a', false)
    const runs = [a, b, other, dm].map((m) => rt.enter('ask', m))
    await tick(5)

    expect(rt.abortChat(G)).toBe(2)
    await Promise.all(runs.slice(0, 2))
    expect(rt.hasActive(rt.keyFor(a))).toBe(false)
    expect(rt.hasActive(rt.keyFor(b))).toBe(false)
    expect(rt.hasActive(rt.keyFor(other))).toBe(true)
    expect(rt.hasActive(rt.keyFor(dm))).toBe(true)
    expect(a.reply).not.toHaveBeenCalled()
    expect(rt.abortChat('nobody')).toBe(0)
    rt.abortAll()
  })
})
