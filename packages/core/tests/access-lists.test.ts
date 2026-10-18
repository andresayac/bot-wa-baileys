import { describe, it, expect, vi } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { AccessList, Whitelist, checkAccess } from '../src/index.js'
import type { AccessListChange, AccessListsSnapshot } from '../src/index.js'
import type { BotConfig, MessageContext } from '../src/core/types.js'

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

/* ------------------------------------------------------------------------- */

describe('AccessList', () => {
  it('adds, checks, lists and removes single ids or arrays', () => {
    const list = new AccessList('blacklist')
    expect(list.add('a')).toBe(list)
    list.add(['b', 'c', 'b'])
    expect(list.has('a')).toBe(true)
    expect(list.has('b')).toBe(true)
    expect(list.has('z')).toBe(false)
    expect(list.size).toBe(3)
    expect(list.list()).toEqual(['a', 'b', 'c'])

    list.remove('a')
    list.remove(['b', 'missing'])
    expect(list.list()).toEqual(['c'])
    list.clear()
    expect(list.size).toBe(0)
  })

  it('treats ids as opaque strings (exact match, no trimming or normalization)', () => {
    const list = new AccessList('blacklist')
    list.add('573001234567@s.whatsapp.net')
    expect(list.has('573001234567')).toBe(false)
    expect(list.has('573001234567@s.whatsapp.net')).toBe(true)
    list.add(' padded ')
    expect(list.has('padded')).toBe(false)
  })

  it('rejects invalid ids with a TypeError', () => {
    const list = new AccessList('blacklist')
    expect(() => list.add('')).toThrow(TypeError)
    expect(() => list.add(['ok', ''])).toThrow(TypeError)
    expect(() => list.add(123 as unknown as string)).toThrow(TypeError)
    expect(() => list.add(null as unknown as string)).toThrow(TypeError)
    expect(list.size).toBe(0)   // validation happens before any mutation
  })

  it('has() never throws, even for non-string input', () => {
    const list = new AccessList('blacklist').add('a')
    expect(list.has(undefined as unknown as string)).toBe(false)
  })

  it('list() and export() return copies', () => {
    const list = new AccessList('blacklist').add(['a', 'b'])
    list.list().push('x')
    list.export().ids.push('y')
    expect(list.list()).toEqual(['a', 'b'])
  })

  it('export()/load() round-trip through JSON; load() replaces the contents', () => {
    const list = new AccessList('blacklist').add(['a', 'b'])
    const json = JSON.stringify(list.export())
    const restored = new AccessList('blacklist').add('stale').load(JSON.parse(json))
    expect(restored.list()).toEqual(['a', 'b'])
    expect(restored.load(['c']).list()).toEqual(['c'])
  })

  it('onChange() reports effective mutations only, and can be unsubscribed', () => {
    const list = new AccessList('blacklist')
    const changes: AccessListChange[] = []
    const off = list.onChange((c) => changes.push(c))
    list.add(['a', 'b'])
    list.add('a')              // no-op: already present
    list.remove(['b', 'zz'])   // only 'b' actually removed
    list.remove('zz')          // no-op
    list.load(['x'])
    list.clear()
    list.clear()               // no-op: already empty
    off()
    list.add('after-unsubscribe')
    expect(changes).toEqual([
      { list: 'blacklist', action: 'add', ids: ['a', 'b'] },
      { list: 'blacklist', action: 'remove', ids: ['b'] },
      { list: 'blacklist', action: 'load', ids: ['x'] },
      { list: 'blacklist', action: 'clear', ids: ['x'] },
    ])
  })

  it('a throwing onChange listener does not break the mutation', () => {
    const list = new AccessList('blacklist')
    list.onChange(() => { throw new Error('boom') })
    expect(() => list.add('a')).not.toThrow()
    expect(list.has('a')).toBe(true)
  })
})

describe('Whitelist', () => {
  it('is disabled by default and toggles with enable()/disable()', () => {
    const list = new Whitelist()
    const changes: AccessListChange[] = []
    list.onChange((c) => changes.push(c))
    expect(list.enabled).toBe(false)
    expect(list.enable()).toBe(list)
    list.enable()   // no-op
    expect(list.enabled).toBe(true)
    list.disable()
    expect(list.enabled).toBe(false)
    expect(changes).toEqual([
      { list: 'whitelist', action: 'enable', ids: [] },
      { list: 'whitelist', action: 'disable', ids: [] },
    ])
  })

  it('export() includes the enabled flag; load() accepts a snapshot or a bare id array', () => {
    const list = new Whitelist().add('a').enable()
    expect(list.export()).toEqual({ ids: ['a'], enabled: true })

    const restored = new Whitelist().load({ ids: ['b'], enabled: true })
    expect(restored.enabled).toBe(true)
    expect(restored.list()).toEqual(['b'])

    restored.load(['c'])   // bare array: ids replaced, enabled flag untouched
    expect(restored.export()).toEqual({ ids: ['c'], enabled: true })
    restored.load({ ids: [] })   // snapshot without `enabled` keeps the flag too
    expect(restored.enabled).toBe(true)
    restored.load({ ids: [], enabled: false })
    expect(restored.enabled).toBe(false)
  })
})

describe('checkAccess', () => {
  it('blacklist matches senderId or chatId and wins over the whitelist', () => {
    const black = new AccessList('blacklist').add(['spam', G])
    const white = new Whitelist().add(['spam', 'vip']).enable()
    expect(checkAccess(black, white, { chatId: 'spam', senderId: 'spam' })).toBe('blacklisted')
    expect(checkAccess(black, white, { chatId: G, senderId: 'vip' })).toBe('blacklisted')
    expect(checkAccess(black, white, { chatId: 'vip', senderId: 'vip' })).toBe('allowed')
    expect(checkAccess(black, white, { chatId: 'other', senderId: 'other' })).toBe('not-whitelisted')
    white.disable()
    expect(checkAccess(black, white, { chatId: 'other', senderId: 'other' })).toBe('allowed')
  })
})

/* ------------------------------------------------------------------------- */

describe('Bot blacklist', () => {
  it('drops a blacklisted sender before routing: no handlers, hooks, message event or persistence', async () => {
    const { bot, provider } = setup()
    const calls: string[] = []
    bot.before('message', async (_ctx: MessageContext, next) => { calls.push('before'); await next() })
    bot.on('message', () => calls.push('event'))
    bot.command('help', async () => { calls.push('command') })
    bot.when('hola', async () => { calls.push('matcher') })
    bot.onMessage(async () => { calls.push('catch-all') })
    await bot.start()

    bot.blacklist.add('spammer')
    provider.incoming('hola', { from: 'spammer' })
    provider.incoming('/help', { from: 'spammer' })
    provider.incoming('whatever', { from: 'spammer' })
    await tick()
    expect(calls).toEqual([])
    expect(await bot.getStore().getMessagesByChat('spammer')).toEqual([])
    expect(await bot.getStore().getChat('spammer')).toBeUndefined()
    expect(await bot.getStore().getContact('spammer')).toBeUndefined()

    provider.incoming('hola', { from: 'friend' })
    await vi.waitFor(() => expect(calls).toEqual(['before', 'matcher', 'event']))
  })

  it('blacklisting a group chatId blocks every participant of that group only', async () => {
    const { bot, provider } = setup()
    bot.when('hola', async (ctx) => { await ctx.reply(`hi ${ctx.sender}`) })
    await bot.start()

    bot.blacklist.add(G)
    provider.incoming('hola', { from: G, sender: 'a', isGroup: true })
    provider.incoming('hola', { from: G, sender: 'b', isGroup: true })
    provider.incoming('hola', { from: H, sender: 'a', isGroup: true })
    await waitForText(provider, 'hi a', H)
    await tick()
    expect(texts(provider, G)).toEqual([])
  })

  it('blacklisting a sender blocks them inside groups too, without muting the rest of the group', async () => {
    const { bot, provider } = setup()
    bot.when('hola', async (ctx) => { await ctx.reply(`hi ${ctx.sender}`) })
    await bot.start()

    bot.blacklist.add('troll')
    provider.incoming('hola', { from: G, sender: 'troll', isGroup: true })
    provider.incoming('hola', { from: G, sender: 'b', isGroup: true })
    await waitForText(provider, 'hi b', G)
    await tick()
    expect(texts(provider, G)).toEqual(['hi b'])
  })

  it('blocked answers never reach an active conversation (participant scope)', async () => {
    const { bot, provider } = setup()
    bot.use(flow('registro').ask('¿nombre?', 'name').say((_ctx, c) => `fin ${String(c.state.name)}`))
    await bot.start()

    provider.incoming('registro', { from: G, sender: 'a', isGroup: true })
    await waitForText(provider, '¿nombre?', G)
    bot.blacklist.add('a')
    provider.incoming('Ana', { from: G, sender: 'a', isGroup: true })
    await tick()
    expect(texts(provider, G)).toEqual(['¿nombre?'])

    bot.blacklist.remove('a')
    provider.incoming('Ana', { from: G, sender: 'a', isGroup: true })
    await waitForText(provider, 'fin Ana', G)
  })

  it('blocked answers never reach an active conversation (chat scope)', async () => {
    const { bot, provider } = setup({ conversationScope: 'chat' })
    bot.use(flow('registro').ask('¿nombre?', 'name').say((_ctx, c) => `fin ${String(c.state.name)}`))
    await bot.start()

    provider.incoming('registro', { from: G, sender: 'a', isGroup: true })
    await waitForText(provider, '¿nombre?', G)
    bot.blacklist.add('troll')
    provider.incoming('troll answer', { from: G, sender: 'troll', isGroup: true })
    await tick()
    provider.incoming('Ana', { from: G, sender: 'a', isGroup: true })
    await waitForText(provider, 'fin Ana', G)
    expect(texts(provider, G)).not.toContain('fin troll answer')
  })

  it('a blocked message cannot wake a dormant checkpoint', async () => {
    const store = new MemoryStore({})
    const p1 = new MockProvider()
    const bot1 = new Bot({ provider: p1, store })
    bot1.use(flow('registro').persistent().say('bienvenido').ask('¿nombre?', 'name').say('fin'))
    await bot1.start()
    p1.incoming('registro', { from: 'u1' })
    await waitForText(p1, '¿nombre?')
    await vi.waitFor(async () => expect(await bot1.getStore().listCheckpoints()).toHaveLength(1))
    await bot1.stop()

    const p2 = new MockProvider()
    const bot2 = new Bot({ provider: p2, store })
    bot2.use(flow('registro').persistent().say('bienvenido').ask('¿nombre?', 'name').say('fin'))
    await bot2.start()
    bot2.blacklist.add('u1')
    p2.incoming('hola', { from: 'u1' })
    await tick()
    expect(texts(p2)).toEqual([])
    expect(await bot2.getStore().listCheckpoints()).toHaveLength(1)   // still dormant, untouched

    bot2.blacklist.remove('u1')
    p2.incoming('hola', { from: 'u1' })
    await waitForText(p2, '¿nombre?')   // resumes once the sender is allowed again
  })

  it('drops interactions from blacklisted senders', async () => {
    const { bot, provider } = setup()
    const handler = vi.fn()
    bot.onMessage(handler)
    await bot.start()
    bot.blacklist.add('u1')
    provider.interaction('btn', { from: 'u1' })
    await tick()
    expect(handler).not.toHaveBeenCalled()
  })

  it('debug-logs the drop without the message body', async () => {
    const debug = vi.fn()
    const logger: any = {
      debug, info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
      child() { return logger },
    }
    const { bot, provider } = setup({ logger })
    await bot.start()
    bot.blacklist.add('u1')
    provider.incoming('secreto 1234', { from: 'u1' })
    await tick()
    const drop = debug.mock.calls.find((args) => String(args[1]).includes('access list'))
    expect(drop).toBeDefined()
    expect(drop![0]).toMatchObject({ gate: 'blacklisted', chatId: 'u1', senderId: 'u1' })
    expect(JSON.stringify(debug.mock.calls)).not.toContain('secreto')
  })

  it('plugins reach the same lists through their scoped bot', async () => {
    const { bot } = setup()
    bot.plug({
      name: 'moderation',
      version: '1.0.0',
      install({ bot: scoped }) { scoped.blacklist.add('from-plugin') },
    })
    expect(bot.blacklist.has('from-plugin')).toBe(true)
  })
})

/* ------------------------------------------------------------------------- */

describe('Bot whitelist', () => {
  it('is disabled by default: whitelist entries alone restrict nothing', async () => {
    const { bot, provider } = setup()
    bot.when('hola', async (ctx) => { await ctx.reply(`hi ${ctx.from}`) })
    await bot.start()
    bot.whitelist.add('vip')
    provider.incoming('hola', { from: 'anyone' })
    await waitForText(provider, 'hi anyone')
  })

  it('when enabled, only whitelisted senders or chats are routed; others are dropped unpersisted', async () => {
    const { bot, provider } = setup()
    const seen = vi.fn()
    bot.on('message', seen)
    bot.when('hola', async (ctx) => { await ctx.reply(`hi ${ctx.from}`) })
    await bot.start()

    bot.whitelist.add(['vip']).enable()
    provider.incoming('hola', { from: 'stranger' })
    provider.incoming('hola', { from: 'vip' })
    await waitForText(provider, 'hi vip')
    await tick()
    expect(texts(provider)).toEqual(['hi vip'])
    expect(seen).toHaveBeenCalledTimes(1)
    expect(await bot.getStore().getMessagesByChat('stranger')).toEqual([])
  })

  it('a whitelisted group chatId admits all of its participants; a whitelisted user is admitted in any group', async () => {
    const { bot, provider } = setup()
    bot.when('hola', async (ctx) => { await ctx.reply(`hi ${ctx.sender}`) })
    await bot.start()

    bot.whitelist.add([G, 'vip']).enable()
    provider.incoming('hola', { from: G, sender: 'x', isGroup: true })
    provider.incoming('hola', { from: H, sender: 'vip', isGroup: true })
    provider.incoming('hola', { from: H, sender: 'y', isGroup: true })
    await waitForText(provider, 'hi x', G)
    await waitForText(provider, 'hi vip', H)
    await tick()
    expect(texts(provider, H)).toEqual(['hi vip'])
  })

  it('an enabled but empty whitelist blocks everyone', async () => {
    const { bot, provider } = setup()
    const handler = vi.fn()
    bot.onMessage(handler)
    await bot.start()
    bot.whitelist.enable()
    provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(handler).not.toHaveBeenCalled()
  })

  it('the blacklist wins over the whitelist', async () => {
    const { bot, provider } = setup()
    const handler = vi.fn()
    bot.onMessage(handler)
    await bot.start()
    bot.whitelist.add('u1').enable()
    bot.blacklist.add('u1')
    provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(handler).not.toHaveBeenCalled()
  })

  it('disable() restores open access', async () => {
    const { bot, provider } = setup()
    bot.when('hola', async (ctx) => { await ctx.reply('hi') })
    await bot.start()
    bot.whitelist.enable()
    provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(texts(provider)).toEqual([])
    bot.whitelist.disable()
    provider.incoming('hola', { from: 'u1' })
    await waitForText(provider, 'hi')
  })
})

/* ------------------------------------------------------------------------- */

describe('access list snapshots (host persistence)', () => {
  it('exportAccessLists()/loadAccessLists() round-trip through JSON', () => {
    const { bot } = setup()
    bot.blacklist.add(['a', 'b'])
    bot.whitelist.add('vip').enable()
    const json = JSON.stringify(bot.exportAccessLists())
    expect(JSON.parse(json)).toEqual({ blacklist: { ids: ['a', 'b'] }, whitelist: { ids: ['vip'], enabled: true } })

    const { bot: other } = setup()
    other.blacklist.add('stale')
    expect(other.loadAccessLists(JSON.parse(json) as AccessListsSnapshot)).toBe(other)
    expect(other.blacklist.list()).toEqual(['a', 'b'])
    expect(other.whitelist.export()).toEqual({ ids: ['vip'], enabled: true })
  })

  it('loadAccessLists() with a partial snapshot only touches the given lists', () => {
    const { bot } = setup()
    bot.blacklist.add('keep')
    bot.loadAccessLists({ whitelist: { ids: ['w'], enabled: true } })
    expect(bot.blacklist.list()).toEqual(['keep'])
    expect(bot.whitelist.enabled).toBe(true)
  })

  it('onChange() lets the host persist every mutation', () => {
    const { bot } = setup()
    const saved: AccessListsSnapshot[] = []
    const persist = () => saved.push(bot.exportAccessLists())
    bot.blacklist.onChange(persist)
    bot.whitelist.onChange(persist)
    bot.blacklist.add('x')
    bot.whitelist.add('y').enable()
    expect(saved.at(-1)).toEqual({ blacklist: { ids: ['x'] }, whitelist: { ids: ['y'], enabled: true } })
    expect(saved).toHaveLength(3)
  })
})

/* ------------------------------------------------------------------------- */

describe('access lists vs. handoff ordering', () => {
  it('a blacklisted sender in a handed-off chat fires no message event (access gate runs first)', async () => {
    const { bot, provider } = setup()
    const seen: string[] = []
    bot.on('message', (ctx) => seen.push(`${ctx.from}/${ctx.sender}`))
    await bot.start()

    await bot.handoff(G)
    bot.blacklist.add('troll')
    provider.incoming('x', { from: G, sender: 'troll', isGroup: true })
    provider.incoming('y', { from: G, sender: 'ok', isGroup: true })
    await vi.waitFor(() => expect(seen).toEqual([`${G}/ok`]))
    await tick()
    expect(seen).toEqual([`${G}/ok`])
  })

  it('an allowed escape command from a blacklisted sender is still dropped', async () => {
    const { bot, provider } = setup({ handoff: { allowCommands: ['/bot'] } })
    const cmd = vi.fn()
    bot.command('bot', cmd)
    await bot.start()
    await bot.handoff('u1')
    bot.blacklist.add('u1')
    provider.incoming('/bot', { from: 'u1' })
    await tick()
    expect(cmd).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------------- */

describe('calls × access lists and handoff (fully blocked, like a message)', () => {
  function watchCalls(bot: Bot) {
    const seen: string[] = []
    bot.before('call', async (e: { from: string }, next: () => Promise<void>) => { seen.push(`before:${e.from}`); await next() })
    bot.after('call', (e: { from: string }) => { seen.push(`after:${e.from}`) })
    bot.on('call', (e) => { seen.push(`event:${e.from}`) })
    bot.onType('call', (ctx) => { seen.push(`trigger:${ctx.sender}`) })
    return seen
  }

  it('a blacklisted caller runs no call hooks, emits no call event and reaches no CALL trigger', async () => {
    const { bot, provider } = setup()
    const seen = watchCalls(bot)
    await bot.start()
    bot.blacklist.add('spammer')
    provider.call({ id: 'c1', from: 'spammer', status: 'offer' })
    provider.call({ id: 'c2', from: 'friend', status: 'offer' })
    await tick()
    expect(seen).toEqual(['before:friend', 'after:friend', 'event:friend', 'trigger:friend'])
    expect(bot.metrics().dropped).toMatchObject({ blocked: 1, handoff: 0 })
  })

  it('a blacklisted group blocks the calls made in it', async () => {
    const { bot, provider } = setup()
    const seen = watchCalls(bot)
    await bot.start()
    bot.blacklist.add(G)
    provider.call({ id: 'g1', from: 'caller', chatId: G, isGroup: true, status: 'offer' })
    await tick()
    expect(seen).toEqual([])
  })

  it('a caller outside an enabled whitelist is fully blocked', async () => {
    const { bot, provider } = setup()
    const seen = watchCalls(bot)
    await bot.start()
    bot.whitelist.enable().add('friend')
    provider.call({ id: 'c1', from: 'stranger', status: 'offer' })
    provider.call({ id: 'c2', from: 'friend', status: 'offer' })
    await tick()
    expect(seen).toEqual(['before:friend', 'after:friend', 'event:friend', 'trigger:friend'])
    expect(bot.metrics().dropped.blocked).toBe(1)
  })

  it('a call into a handed-off chat runs no call hooks, emits no call event and reaches no CALL trigger', async () => {
    const { bot, provider } = setup({ handoff: { allowCommands: ['bot'] } })
    const seen = watchCalls(bot)
    await bot.start()
    await bot.handoff('with-agent')
    provider.call({ id: 'c1', from: 'with-agent', status: 'offer' })
    await tick()
    expect(seen).toEqual([])
    expect(bot.metrics().dropped).toMatchObject({ blocked: 0, handoff: 1 })

    await bot.resume('with-agent')
    provider.call({ id: 'c2', from: 'with-agent', status: 'offer' })
    await tick()
    expect(seen).toEqual(['before:with-agent', 'after:with-agent', 'event:with-agent', 'trigger:with-agent'])
  })

  it('a blocked call does not burn its call id: once allowed again, the same call reaches the trigger', async () => {
    const { bot, provider } = setup()
    const seen = watchCalls(bot)
    await bot.start()
    bot.blacklist.add('u1')
    provider.call({ id: 'c1', from: 'u1', status: 'offer' })
    await tick()
    bot.blacklist.remove('u1')
    provider.call({ id: 'c1', from: 'u1', status: 'ringing' })
    await tick()
    expect(seen).toEqual(['before:u1', 'after:u1', 'event:u1', 'trigger:u1'])
  })

  it('debug-logs a blocked call', async () => {
    const debug = vi.fn()
    const logger: any = {
      debug, info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
      child() { return logger },
    }
    const { bot, provider } = setup({ logger })
    await bot.start()
    bot.blacklist.add('u1')
    provider.call({ id: 'c1', from: 'u1', status: 'offer' })
    await tick()
    const drop = debug.mock.calls.find((args) => String(args[1]).includes('call dropped'))
    expect(drop?.[0]).toMatchObject({ gate: 'blacklisted', chatId: 'u1', senderId: 'u1' })
  })
})
