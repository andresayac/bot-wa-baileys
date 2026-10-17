import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../src/core/Bot.js'
import { Dispatcher } from '../src/core/Dispatcher.js'
import { ConversationRuntime } from '../src/conversations/ConversationRuntime.js'
import { createControls } from '../src/conversations/controls.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import { slashCommandsPlugin } from '../src/plugins/slashCommands.js'
import { flow, addKeyword } from '../src/flows/FlowBuilder.js'
import { WELCOME, IMAGE } from '../src/core/triggers.js'
import { WelcomeTracker } from '../src/core/welcome.js'
import type { IStore } from '../src/store/IStore.js'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function textsTo(provider: MockProvider, chatId: string): string[] {
  return provider.outbox
    .filter((m) => m.chatId === chatId)
    .map((m) => (m.content.kind === 'text' ? m.content.text : ''))
}

/** Boot a Bot on a MockProvider with an explicit (shareable) store. */
async function boot(store: IStore) {
  const provider = new MockProvider()
  const bot = new Bot({ provider, store })
  await bot.start()
  const say = async (text: string, opts: { from?: string; sender?: string; isGroup?: boolean } = {}) => {
    provider.incoming(text, { from: opts.from ?? 'dm-1', sender: opts.sender, isGroup: opts.isGroup })
    await tick(10)
  }
  return { bot, provider, say }
}

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('WELCOME trigger', () => {
  it('fires on the first message of a DM only', async () => {
    const { bot, chat } = await createTestBot()
    const welcome = vi.fn(async (ctx) => { await ctx.reply('¡Bienvenido!') })
    const fallback = vi.fn()
    bot.when(WELCOME, welcome)
    bot.onMessage(fallback)
    await chat.send('hola')
    await chat.send('hola otra vez')
    await chat.send('y otra')
    expect(welcome).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledTimes(2)
    expect(chat.replies()).toEqual(['¡Bienvenido!'])
  })

  it('takes precedence over text matchers on the first contact; ctx.pass() lets the same message continue', async () => {
    const { bot, chat } = await createTestBot()
    const order: string[] = []
    bot.when('menu', () => { order.push('menu') })
    bot.when(WELCOME, () => { order.push('welcome') })
    await chat.send('menu')                 // first contact → WELCOME consumes it
    await chat.send('menu')                 // afterwards → the text matcher
    expect(order).toEqual(['welcome', 'menu'])

    const second = await createTestBot()
    const order2: string[] = []
    second.bot.when('menu', () => { order2.push('menu') })
    second.bot.when(WELCOME, (ctx) => { order2.push('welcome'); ctx.pass() })
    await second.chat.send('menu')
    expect(order2).toEqual(['welcome', 'menu'])
  })

  it('takes precedence over type triggers too (first message being an image)', async () => {
    const { bot, chat } = await createTestBot()
    const order: string[] = []
    bot.when(IMAGE, () => { order.push('image') })
    bot.when(WELCOME, () => { order.push('welcome') })
    await chat.send('', { type: 'image' })
    await chat.send('', { type: 'image' })
    expect(order).toEqual(['welcome', 'image'])
  })

  it('every WELCOME handler sees the same first-contact decision (pass() cascades between them)', async () => {
    const { bot, chat } = await createTestBot()
    const order: string[] = []
    bot.when(WELCOME, (ctx) => { order.push('a'); ctx.pass() })
    bot.when(WELCOME, () => { order.push('b') })
    await chat.send('hola')
    await chat.send('hola')
    expect(order).toEqual(['a', 'b'])
  })

  it('works as a flow()/addKeyword() trigger and the onboarding conversation keeps its answers', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(addKeyword(WELCOME).ask('¡Hola! ¿Cómo te llamas?', 'name').say((_ctx, c) => `Encantado, ${String(c.state.name)}`))
    const fallback = vi.fn()
    bot.onMessage(fallback)
    await chat.send('buenas')
    await chat.expectReply('¿Cómo te llamas?')
    await chat.send('Ana')
    await chat.expectReply('Encantado, Ana')
    await chat.send('qué tal')
    expect(fallback).toHaveBeenCalledOnce()
    expect(chat.replies().filter((r) => r.includes('¿Cómo te llamas?'))).toHaveLength(1)
  })

  it('is scoped per participant in groups, and a DM is a separate first contact', async () => {
    const { bot, provider } = await createTestBot()
    const seen: string[] = []
    bot.when(WELCOME, (ctx) => { seen.push(`${ctx.from}/${ctx.sender}`) })
    const group = (sender: string) => {
      provider.incoming('hola', { from: 'g@g.us', sender, isGroup: true })
      return tick(10)
    }
    await group('ana')
    await group('ana')
    await group('beto')
    provider.incoming('hola', { from: 'ana' })      // Ana's own DM
    await tick(10)
    await group('beto')
    expect(seen).toEqual(['g@g.us/ana', 'g@g.us/beto', 'ana/ana'])
  })

  it('honours scope: flow(WELCOME).scope("dm") never greets nor marks group participants', async () => {
    const { bot, provider } = await createTestBot()
    const store = bot.getStore()
    const reads = vi.spyOn(store, 'getCursor')
    bot.use(flow(WELCOME).scope('dm').say('hola DM'))
    provider.incoming('hola', { from: 'g@g.us', sender: 'ana', isGroup: true })
    await tick(10)
    expect(textsTo(provider, 'g@g.us')).toEqual([])
    expect(reads).not.toHaveBeenCalled()
    provider.incoming('hola', { from: 'ana' })
    await tick(10)
    expect(textsTo(provider, 'ana')).toEqual(['hola DM'])
  })

  it('has no race on concurrent first messages, even with a slow store', async () => {
    const inner = new MemoryStore()
    const slow: IStore = Object.assign(Object.create(inner) as IStore, {
      getCursor: async (key: string) => { await tick(15); return inner.getCursor(key) },
      setCursor: async (key: string, value: string) => { await tick(15); return inner.setCursor(key, value) },
    })
    const { bot, provider } = await boot(slow)
    const welcome = vi.fn()
    bot.when(WELCOME, welcome)
    bot.onMessage(() => {})
    for (let i = 0; i < 5; i++) provider.incoming(`msg ${i}`, { from: 'dm-1' })
    await tick(200)
    expect(welcome).toHaveBeenCalledOnce()
  })

  it('survives a restart: a second Bot on the same store does not greet again', async () => {
    const store = new MemoryStore()
    const first = await boot(store)
    first.bot.when(WELCOME, (ctx) => ctx.reply('bienvenido'))
    await first.say('hola')
    expect(textsTo(first.provider, 'dm-1')).toEqual(['bienvenido'])
    await first.bot.stop()

    const second = await boot(store)
    second.bot.when(WELCOME, (ctx) => ctx.reply('bienvenido'))
    second.bot.onMessage((ctx) => ctx.reply('ya te conozco'))
    await second.say('hola')
    expect(textsTo(second.provider, 'dm-1')).toEqual(['ya te conozco'])
    await second.bot.stop()
  })

  it('survives a real process restart with a file-backed MemoryStore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-welcome-'))
    tempDirs.push(dir)
    const file = join(dir, 'store.json')

    const first = await boot(new MemoryStore({ file }))
    first.bot.when(WELCOME, (ctx) => ctx.reply('bienvenido'))
    await first.say('hola')
    await first.bot.stop()

    const second = await boot(new MemoryStore({ file }))
    const welcome = vi.fn()
    second.bot.when(WELCOME, welcome)
    await second.say('hola')
    expect(welcome).not.toHaveBeenCalled()
    await second.bot.stop()
  })

  it('costs zero store reads when no WELCOME handler is registered', async () => {
    const { bot, chat } = await createTestBot()
    const reads = vi.spyOn(bot.getStore(), 'getCursor')
    bot.when('hola', (ctx) => ctx.reply('hola'))
    bot.when(IMAGE, () => {})
    bot.onMessage(() => {})
    await chat.send('hola')
    await chat.send('otra cosa')
    await chat.send('', { type: 'image' })
    expect(reads).not.toHaveBeenCalled()
  })

  it('reads the store at most once per user while the process lives', async () => {
    const { bot, chat } = await createTestBot()
    const reads = vi.spyOn(bot.getStore(), 'getCursor')
    bot.when(WELCOME, () => {})
    bot.onMessage(() => {})
    for (let i = 0; i < 5; i++) await chat.send(`mensaje ${i}`)
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('is not evaluated (nor consumed) by commands; the next normal message is the first contact', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(slashCommandsPlugin, { greeting: 'ayuda' })
    bot.when(WELCOME, (ctx) => ctx.reply('bienvenido'))
    await chat.send('/help')
    await chat.expectReply('ayuda')
    await chat.send('hola')
    await chat.expectReply('bienvenido')
  })

  it('the unsubscriber removes the WELCOME handler', async () => {
    const { bot, chat } = await createTestBot()
    const welcome = vi.fn()
    const off = bot.when(WELCOME, welcome)
    off()
    await chat.send('hola')
    expect(welcome).not.toHaveBeenCalled()
  })

  it('a failing store read skips WELCOME (fail closed), reports the error and lets the message continue', async () => {
    const { bot, chat } = await createTestBot()
    vi.spyOn(bot.getStore(), 'getCursor').mockRejectedValue(new Error('store down'))
    const errors: unknown[] = []
    bot.on('error', (e) => { errors.push(e.error) })
    const welcome = vi.fn()
    bot.when(WELCOME, welcome)
    bot.onMessage((ctx) => ctx.reply('fallback'))
    await chat.send('hola')
    await chat.expectReply('fallback')
    expect(welcome).not.toHaveBeenCalled()
    expect(errors.map((e) => (e as Error).message)).toEqual(['store down'])
  })
})

describe('bot.resetWelcome', () => {
  it('re-arms WELCOME for a DM chat', async () => {
    const { bot, chat } = await createTestBot()
    const welcome = vi.fn()
    bot.when(WELCOME, welcome)
    await chat.send('hola')
    await chat.send('hola')
    await bot.resetWelcome(chat.jid)
    await chat.send('hola')
    await chat.send('hola')
    expect(welcome).toHaveBeenCalledTimes(2)
  })

  it('re-arms one participant of a group with (chatId, userId), everybody with (chatId)', async () => {
    const { bot, provider } = await createTestBot()
    const seen: string[] = []
    bot.when(WELCOME, (ctx) => { seen.push(ctx.sender) })
    const group = (sender: string) => {
      provider.incoming('hola', { from: 'g@g.us', sender, isGroup: true })
      return tick(10)
    }
    await group('ana'); await group('beto')
    await bot.resetWelcome('g@g.us', 'ana')
    await group('ana'); await group('beto')
    expect(seen).toEqual(['ana', 'beto', 'ana'])

    await bot.resetWelcome('g@g.us')
    await group('ana'); await group('beto'); await group('ana')
    expect(seen).toEqual(['ana', 'beto', 'ana', 'ana', 'beto'])
  })

  it('a reset is persisted: a restarted bot greets again', async () => {
    const store = new MemoryStore()
    const first = await boot(store)
    first.bot.when(WELCOME, () => {})
    await first.say('hola')
    await first.say('hola', { from: 'g@g.us', sender: 'ana', isGroup: true })
    await first.bot.resetWelcome('dm-1')
    await first.bot.resetWelcome('g@g.us')
    await first.bot.stop()

    const second = await boot(store)
    const seen: string[] = []
    second.bot.when(WELCOME, (ctx) => { seen.push(`${ctx.from}/${ctx.sender}`) })
    await second.say('hola')
    await second.say('hola', { from: 'g@g.us', sender: 'ana', isGroup: true })
    expect(seen).toEqual(['dm-1/dm-1', 'g@g.us/ana'])
    await second.bot.stop()
  })

  it('handles opaque ids containing separators without collisions', async () => {
    const { bot, provider } = await createTestBot()
    const seen: string[] = []
    bot.when(WELCOME, (ctx) => { seen.push(`${ctx.from}|${ctx.sender}`) })
    provider.incoming('x', { from: 'a:b', sender: 'c', isGroup: true }); await tick(10)
    provider.incoming('x', { from: 'a', sender: 'b:c', isGroup: true }); await tick(10)
    provider.incoming('x', { from: 'a:b' }); await tick(10)
    await bot.resetWelcome('a')        // must not touch the group "a:b"
    provider.incoming('x', { from: 'a:b', sender: 'c', isGroup: true }); await tick(10)
    expect(seen).toEqual(['a:b|c', 'a|b:c', 'a:b|a:b'])
  })
})

describe('WELCOME and subject erasure', () => {
  it('store keys never contain the raw (personal) ids', async () => {
    const store = new MemoryStore()
    const writes = vi.spyOn(store, 'setCursor')
    const { bot, say } = await boot(store)
    bot.when(WELCOME, () => {})
    await say('hola', { from: '573001112233@s.whatsapp.net' })
    await say('hola', { from: '120363@g.us', sender: '573001112233@s.whatsapp.net', isGroup: true })
    await bot.resetWelcome('120363@g.us')
    expect(writes).toHaveBeenCalled()
    for (const [key] of writes.mock.calls) {
      expect(key).not.toContain('573001112233')
      expect(key).not.toContain('120363')
    }
    await bot.stop()
  })

  it('deleteSubject re-arms WELCOME wherever the subject was greeted, without writing rows elsewhere', async () => {
    const store = new MemoryStore()
    const { bot, say } = await boot(store)
    const seen: string[] = []
    bot.when(WELCOME, (ctx) => { seen.push(`${ctx.from}/${ctx.sender}`) })
    await say('hola', { from: 'ana' })
    await say('hola', { from: 'g@g.us', sender: 'ana', isGroup: true })
    await say('hola', { from: 'beto' })
    await say('hola', { from: 'g@g.us', sender: 'beto', isGroup: true })

    const writes = vi.spyOn(store, 'setCursor')
    await bot.deleteSubject('ana')
    expect(writes).toHaveBeenCalledTimes(2)   // ana's DM marker + ana's group marker only

    await say('hola', { from: 'ana' })
    await say('hola', { from: 'g@g.us', sender: 'ana', isGroup: true })
    await say('hola', { from: 'beto' })
    await say('hola', { from: 'g@g.us', sender: 'beto', isGroup: true })
    expect(seen).toEqual(['ana/ana', 'g@g.us/ana', 'beto/beto', 'g@g.us/beto', 'ana/ana', 'g@g.us/ana'])
    await bot.stop()
  })
})

describe('slashCommandsPlugin and WELCOME', () => {
  it('/reset re-arms WELCOME for the user (DM)', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(slashCommandsPlugin)
    const welcome = vi.fn((ctx) => ctx.reply('bienvenido'))
    bot.when(WELCOME, welcome)
    await chat.send('hola')
    await chat.send('/reset')
    await chat.expectReply('reiniciada')
    await chat.send('hola')
    expect(welcome).toHaveBeenCalledTimes(2)
  })

  it('/reset in a group re-arms only the participant who sent it', async () => {
    const { bot, provider } = await createTestBot()
    bot.plug(slashCommandsPlugin)
    const seen: string[] = []
    bot.when(WELCOME, (ctx) => { seen.push(ctx.sender) })
    const group = (sender: string, text = 'hola') => {
      provider.incoming(text, { from: 'g@g.us', sender, isGroup: true })
      return tick(10)
    }
    await group('ana'); await group('beto')
    await group('ana', '/reset')
    await group('ana'); await group('beto')
    expect(seen).toEqual(['ana', 'beto', 'ana'])
  })

  it('/cancel only cancels the conversation; it does not re-arm WELCOME', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(slashCommandsPlugin)
    const welcome = vi.fn()
    bot.when(WELCOME, welcome)
    await chat.send('hola')
    await chat.send('/cancel')
    await chat.expectReply('reiniciada')
    await chat.send('hola')
    expect(welcome).toHaveBeenCalledOnce()
  })
})

describe('WelcomeTracker', () => {
  it('works without a store (in-process only)', async () => {
    const t = new WelcomeTracker()
    const dm = { from: 'u', sender: 'u', isGroup: false }
    expect(await t.isFirstContact(dm)).toBe(true)
    expect(await t.isFirstContact({ ...dm })).toBe(false)
    await t.reset('u')
    expect(await t.isFirstContact({ ...dm })).toBe(true)
  })

  it('memoises the decision per message object', async () => {
    const t = new WelcomeTracker()
    const ctx = { from: 'u', sender: 'u', isGroup: false }
    expect(await t.isFirstContact(ctx)).toBe(true)
    expect(await t.isFirstContact(ctx)).toBe(true)
    expect(await t.isFirstContact({ ...ctx })).toBe(false)
  })

  it('keeps very long opaque ids within a safe store key length', async () => {
    const store = new MemoryStore()
    const reads = vi.spyOn(store, 'getCursor')
    const writes = vi.spyOn(store, 'setCursor')
    const t = new WelcomeTracker({ store })
    const huge = 'x'.repeat(500)
    expect(await t.isFirstContact({ from: huge, sender: huge, isGroup: true })).toBe(true)
    await t.reset(huge)
    const keys = [...reads.mock.calls, ...writes.mock.calls].map((call) => call[0])
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(160)
    // the hashed keys are deterministic: a fresh tracker on the same store still finds them
    const again = new WelcomeTracker({ store })
    expect(await again.isFirstContact({ from: huge, sender: huge, isGroup: true })).toBe(true) // re-armed by reset
    const fresh = new WelcomeTracker({ store })
    expect(await fresh.isFirstContact({ from: huge, sender: huge, isGroup: true })).toBe(false)
  })
})

describe('Dispatcher without a firstContact dependency', () => {
  it('falls back to an in-memory tracker so WELCOME still fires once', async () => {
    const runtime = new ConversationRuntime({ controlsFactory: (r, k, c) => createControls(r, k, c) })
    const d = new Dispatcher({
      hooks: { runBefore: async () => true, runAfter: async () => {}, runError: async () => {} },
      runtime,
      emit: () => false,
    })
    const welcome = vi.fn()
    d.matcher(WELCOME, welcome)
    const ctx = () => ({
      from: 'u', sender: 'u', body: 'hola', type: 'text', isGroup: false,
      reply: async () => {}, pass() {}, abort() {},
    })
    await d.dispatch(ctx())
    await d.dispatch(ctx())
    expect(welcome).toHaveBeenCalledOnce()
  })
})
