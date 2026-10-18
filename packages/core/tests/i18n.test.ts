/**
 * Native i18n (FEATURES.md #13): `bot.locale()` registry, `ctx.t()` / `c.t()`,
 * language resolution (ctx.user > provider > detector > default), `ctx.setLang()`
 * and the localizable built-in core messages.
 */
import { describe, it, expect, vi } from 'vitest'

import {
  Bot,
  I18n,
  CORE_MESSAGES,
  buildMessageContext,
  flow,
  normalizeLocale,
  slashCommandsPlugin,
} from '../src/index.js'
import type { InboundMessage, MessageContext } from '../src/index.js'
import { MockProvider, type IncomingOpts } from '../src/testing/MockProvider.js'

/* ------------------------------------------------------------------------- */

function logger() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log }
  return log
}

function dispatched(bot: Bot): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onMessage = () => { off(); resolve() }
    const onError = (payload: { error: unknown }) => { off(); reject(payload.error) }
    const off = () => { bot.off('message', onMessage); bot.off('error', onError) }
    bot.on('message', onMessage)
    bot.on('error', onError)
  })
}

async function deliver(bot: Bot, provider: MockProvider, text: string, opts: IncomingOpts = {}): Promise<void> {
  const done = dispatched(bot)
  provider.incoming(text, opts)
  await done
}

const texts = (provider: MockProvider) =>
  provider.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : ''))

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function makeBot(config: Partial<ConstructorParameters<typeof Bot>[0]> = {}) {
  const provider = new MockProvider()
  const bot = new Bot({ ...config, provider })
  await bot.start()
  return { bot, provider }
}

const ES = {
  greeting: '¡Hola, {name}!',
  menu: { title: 'Menú principal', items: { games: 'Juegos' } },
  items: { zero: 'Sin artículos', one: '{count} artículo', other: '{count} artículos' },
  onlyEs: 'Solo en español',
}
const EN = {
  greeting: 'Hello, {name}!',
  menu: { title: 'Main menu', items: { games: 'Games' } },
  items: { one: '{count} item', other: '{count} items' },
}

/* ------------------------------------------------------------------------- */

describe('I18n registry', () => {
  it('resolves nested keys and interpolates {params}', () => {
    const i18n = new I18n()
    i18n.add('es', ES)
    expect(i18n.translate('es', 'menu.title')).toBe('Menú principal')
    expect(i18n.translate('es', 'menu.items.games')).toBe('Juegos')
    expect(i18n.translate('es', 'greeting', { name: 'Ana' })).toBe('¡Hola, Ana!')
  })

  it('keeps unknown placeholders verbatim', () => {
    const i18n = new I18n()
    i18n.add('es', { a: 'Hola {name}, {missing}' })
    expect(i18n.translate('es', 'a', { name: 'Ana' })).toBe('Hola Ana, {missing}')
    expect(i18n.translate('es', 'a')).toBe('Hola {name}, {missing}')
  })

  it('picks plural forms from params.count with Intl.PluralRules and an exact zero form', () => {
    const i18n = new I18n()
    i18n.add('es', ES)
    i18n.add('en', EN)
    expect(i18n.translate('es', 'items', { count: 0 })).toBe('Sin artículos')
    expect(i18n.translate('es', 'items', { count: 1 })).toBe('1 artículo')
    expect(i18n.translate('es', 'items', { count: 5 })).toBe('5 artículos')
    expect(i18n.translate('en', 'items', { count: 0 })).toBe('0 items')
    expect(i18n.translate('en', 'items', { count: 1 })).toBe('1 item')
    // Without a count the `other` form is used.
    expect(i18n.translate('en', 'items')).toBe('{count} items')
  })

  it('falls back to the base language, then the default locale, then the key — with debug logs', () => {
    const log = logger()
    const i18n = new I18n({ defaultLocale: 'es', logger: log })
    i18n.add('es', ES)
    i18n.add('en', EN)
    expect(i18n.translate('en-US', 'menu.title')).toBe('Main menu')
    expect(log.debug).not.toHaveBeenCalled()
    expect(i18n.translate('en', 'onlyEs')).toBe('Solo en español')
    expect(log.debug).toHaveBeenCalledTimes(1)
    expect(i18n.translate('en', 'nope.key')).toBe('nope.key')
    expect(log.debug).toHaveBeenCalledTimes(2)
    expect(log.debug.mock.calls[1][0]).toMatchObject({ key: 'nope.key', lang: 'en' })
  })

  it('deep-merges repeated registrations and accepts flat dotted keys', () => {
    const i18n = new I18n()
    i18n.add('es', { menu: { title: 'A' } })
    i18n.add('es', { menu: { footer: 'B' }, 'flat.key': 'C' })
    expect(i18n.translate('es', 'menu.title')).toBe('A')
    expect(i18n.translate('es', 'menu.footer')).toBe('B')
    expect(i18n.translate('es', 'flat.key')).toBe('C')
  })

  it('normalizes locale codes', () => {
    expect(normalizeLocale(' EN_us ')).toBe('en-us')
    expect(normalizeLocale('')).toBeUndefined()
    expect(normalizeLocale(42)).toBeUndefined()
    const i18n = new I18n()
    i18n.add('EN_US', { a: 'x' })
    expect(i18n.supported('en-us')).toBe('en-us')
    expect(i18n.supported('fr-CA')).toBeUndefined()
    expect(i18n.supported('es-AR')).toBe('es') // built-in es
    expect(i18n.locales()).toEqual(expect.arrayContaining(['es', 'en', 'en-us']))
  })

  it('rejects invalid registrations', () => {
    const i18n = new I18n()
    expect(() => i18n.add('', {})).toThrow(TypeError)
    expect(() => i18n.add('es', null as never)).toThrow(TypeError)
    expect(() => i18n.add('es', { a: 1 } as never)).toThrow(TypeError)
  })

  it('ships es and en built-in core messages', () => {
    const i18n = new I18n()
    expect(i18n.translate('es', CORE_MESSAGES.timeout)).toBe('⏰ La conversación expiró por inactividad.')
    expect(i18n.translate('en', CORE_MESSAGES.timeout)).toMatch(/expired/i)
    expect(i18n.translate('en', CORE_MESSAGES.commandsReset)).toMatch(/restarted/i)
  })

  it('user locales override built-in core messages', () => {
    const i18n = new I18n()
    i18n.add('en', { core: { conversation: { timeout: 'Too slow!' } } })
    expect(i18n.translate('en', CORE_MESSAGES.timeout)).toBe('Too slow!')
    expect(i18n.translate('en', CORE_MESSAGES.retries)).toMatch(/attempts/i)
  })
})

/* ------------------------------------------------------------------------- */

describe('buildMessageContext without a bot', () => {
  it('exposes ctx.t / ctx.lang with the Spanish built-ins', () => {
    const inbound: InboundMessage = {
      ref: { id: '1', chatId: 'c' },
      chat: { id: 'c', kind: 'dm', isGroup: false, isBroadcast: false },
      senderInfo: { id: 'c' },
      from: 'c', sender: 'c', chatId: 'c', senderId: 'c',
      isGroup: false, isBroadcast: false, fromMe: false,
      type: 'text', body: 'hi', timestamp: 0, mentions: [], raw: {},
    }
    const ctx = buildMessageContext({ inbound, tools: {}, send: async () => ({ ref: { id: 'x', chatId: 'c' } }) })
    expect(ctx.lang).toBe('es')
    expect(ctx.t(CORE_MESSAGES.timeout)).toBe('⏰ La conversación expiró por inactividad.')
    expect(ctx.t('unknown.key')).toBe('unknown.key')
  })
})

/* ------------------------------------------------------------------------- */

describe('Bot i18n', () => {
  it('ctx.t uses the default locale', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('es', ES).locale('en', EN)
    bot.when('hola', async (ctx) => { await ctx.reply(ctx.t('greeting', { name: ctx.pushName ?? '' })) })
    await deliver(bot, provider, 'hola', { pushName: 'Ana' })
    expect(texts(provider)).toEqual(['¡Hola, Ana!'])
    await bot.stop()
  })

  it('honours a configured default locale', async () => {
    const { bot, provider } = await makeBot({ i18n: { defaultLocale: 'en' } })
    bot.locale('es', ES).locale('en', EN)
    bot.when('hola', async (ctx) => { await ctx.reply(`${ctx.lang}:${ctx.t('menu.title')}`) })
    await deliver(bot, provider, 'hola')
    expect(texts(provider)).toEqual(['en:Main menu'])
    await bot.stop()
  })

  it('bot.locale(options) configures the default locale and detector', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('es', ES).locale('en', EN).locale({ defaultLocale: 'en' })
    bot.when('hola', async (ctx) => { await ctx.reply(ctx.t('menu.title')) })
    await deliver(bot, provider, 'hola')
    expect(texts(provider)).toEqual(['Main menu'])
    await bot.stop()
  })

  it('uses the provider-reported language when supported (SenderInfo.language / platformData)', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('es', ES).locale('en', EN)
    bot.when('hola', async (ctx) => { await ctx.reply(`${ctx.lang}:${ctx.t('menu.title')}`) })
    await deliver(bot, provider, 'hola', { language: 'en-US' })
    await deliver(bot, provider, 'hola', { from: 'tg', platformData: { languageCode: 'en' } })
    await deliver(bot, provider, 'hola', { from: 'pt', language: 'pt-BR' })
    expect(texts(provider)).toEqual(['en:Main menu', 'en:Main menu', 'es:Menú principal'])
    await bot.stop()
  })

  it('ignores the provider language when providerLanguage is false', async () => {
    const { bot, provider } = await makeBot({ i18n: { providerLanguage: false } })
    bot.locale('es', ES).locale('en', EN)
    bot.when('hola', async (ctx) => { await ctx.reply(ctx.lang) })
    await deliver(bot, provider, 'hola', { language: 'en' })
    expect(texts(provider)).toEqual(['es'])
    await bot.stop()
  })

  it('falls back to the detector, then the default', async () => {
    const detect = vi.fn((ctx: MessageContext) => (/hello/i.test(ctx.body) ? 'en' : undefined))
    const { bot, provider } = await makeBot({ i18n: { detect } })
    bot.locale('es', ES).locale('en', EN)
    bot.onMessage(async (ctx) => { await ctx.reply(ctx.lang) })
    await deliver(bot, provider, 'hello there')
    await deliver(bot, provider, 'hola')
    expect(texts(provider)).toEqual(['en', 'es'])
    expect(detect).toHaveBeenCalledTimes(2)
    await bot.stop()
  })

  it('a throwing or unsupported detector falls back to the default', async () => {
    const log = logger()
    const { bot, provider } = await makeBot({ logger: log, i18n: { detect: async () => { throw new Error('boom') } } })
    bot.locale('en', EN)
    bot.onMessage(async (ctx) => { await ctx.reply(ctx.lang) })
    await deliver(bot, provider, 'x')
    expect(texts(provider)).toEqual(['es'])
    await bot.stop()
  })

  it("ctx.user 'lang' wins over the provider language and the detector", async () => {
    const detect = vi.fn(() => 'en')
    const { bot, provider } = await makeBot({ i18n: { detect } })
    bot.locale('es', ES).locale('en', EN)
    await bot.user('u1').set('lang', 'es')
    bot.onMessage(async (ctx) => { await ctx.reply(ctx.lang) })
    await deliver(bot, provider, 'x', { from: 'u1', language: 'en' })
    expect(texts(provider)).toEqual(['es'])
    expect(detect).not.toHaveBeenCalled()
    await bot.stop()
  })

  it('ctx.setLang persists to ctx.user and switches ctx.lang immediately', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('es', ES).locale('en', EN)
    bot.command('lang', async (ctx, [code]) => {
      await ctx.setLang(code)
      await ctx.reply(ctx.t('menu.title'))
    })
    bot.when('menu', async (ctx) => { await ctx.reply(ctx.t('menu.title')) })
    await deliver(bot, provider, '/lang EN')
    expect(await bot.user('user-1').get('lang')).toBe('en')
    await deliver(bot, provider, 'menu')
    expect(texts(provider)).toEqual(['Main menu', 'Main menu'])
    await bot.stop()
  })

  it('ctx.setLang rejects an invalid code', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('en', EN)
    let err: unknown
    bot.onMessage(async (ctx) => { try { await ctx.setLang('  ') } catch (e) { err = e } })
    await deliver(bot, provider, 'x')
    expect(err).toBeInstanceOf(TypeError)
    await bot.stop()
  })

  it('ctx.setLang rejects a locale no one registered and stores nothing', async () => {
    const { bot, provider } = await makeBot({ i18n: { defaultLocale: 'en' } })
    bot.locale('en', EN)
    let err: unknown
    bot.command('lang', async (ctx, [code]) => { try { await ctx.setLang(code) } catch (e) { err = e } })
    bot.onMessage(async (ctx) => { await ctx.reply(ctx.lang) })
    await deliver(bot, provider, '/lang klingon')
    expect(err).toBeInstanceOf(TypeError)
    expect(await bot.user('user-1').get('lang')).toBeUndefined()
    await deliver(bot, provider, 'hi')
    expect(texts(provider)).toEqual(['en'])
    await bot.stop()
  })

  it('ctx.setLang stores the registered locale serving a regional code', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('es', ES).locale('en', EN)
    bot.command('lang', async (ctx, [code]) => { await ctx.setLang(code); await ctx.reply(ctx.lang) })
    await deliver(bot, provider, '/lang en-GB')
    expect(await bot.user('user-1').get('lang')).toBe('en')
    expect(texts(provider)).toEqual(['en'])
    await bot.stop()
  })

  it('ignores a stored preference that is not a registered locale', async () => {
    const { bot, provider } = await makeBot({ i18n: { defaultLocale: 'en' } })
    bot.locale('en', EN)
    await bot.user('user-1').set('lang', 'klingon')
    bot.onMessage(async (ctx) => { await ctx.reply(ctx.lang) })
    await deliver(bot, provider, 'hi', { language: 'es' })
    // Falls through to the provider language (es is a built-in locale).
    expect(texts(provider)).toEqual(['es'])
    expect(await bot.langOf('user-1')).toBe('en')
    await bot.stop()
  })

  it('ctx.setLang rejects while i18n is off (no bot.locale() / BotConfig.i18n), so it never half-works', async () => {
    const { bot, provider } = await makeBot()
    let err: unknown
    bot.command('lang', async (ctx) => { try { await ctx.setLang('en') } catch (e) { err = e } })
    bot.onMessage(async (ctx) => { await ctx.reply(ctx.lang) })
    await deliver(bot, provider, '/lang en')
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).toMatch(/bot\.locale/)
    expect(await bot.user('user-1').get('lang')).toBeUndefined()
    await deliver(bot, provider, 'hi')
    expect(texts(provider)).toEqual(['es'])
    expect(await bot.langOf('user-1')).toBe('es')
    await bot.stop()
  })

  it('bot.langOf agrees with ctx.lang while i18n is off', async () => {
    const { bot } = await makeBot()
    await bot.user('user-1').set('lang', 'en')
    expect(await bot.langOf('user-1')).toBe('es')
    await bot.stop()
  })

  it('without any locale configuration the stored/provider language is not consulted (backward compatible)', async () => {
    const { bot, provider } = await makeBot()
    await bot.user('user-1').set('lang', 'en')
    bot.onMessage(async (ctx) => { await ctx.reply(`${ctx.lang}|${ctx.t(CORE_MESSAGES.retries)}`) })
    await deliver(bot, provider, 'x', { language: 'en' })
    expect(texts(provider)).toEqual(['es|❌ Demasiados intentos. Conversación terminada.'])
    await bot.stop()
  })

  it('bot.t and bot.langOf work outside handlers', async () => {
    const { bot } = await makeBot()
    bot.locale('es', ES).locale('en', EN)
    expect(bot.t('menu.title')).toBe('Menú principal')
    expect(bot.t('greeting', { name: 'Bob' }, 'en')).toBe('Hello, Bob!')
    expect(await bot.langOf('nobody')).toBe('es')
    await bot.user('u2').set('lang', 'en')
    expect(await bot.langOf('u2')).toBe('en')
    await bot.stop()
  })
})

/* ------------------------------------------------------------------------- */

describe('conversations and built-in messages', () => {
  it('c.t follows the language of the latest message (setLang mid-conversation)', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('es', ES).locale('en', EN)
    bot.conversation('menu', async (c, ctx) => {
      await c.say(c.t('menu.title'))
      await c.waitText()
      await c.say(`${c.lang}:${c.t('menu.title')}`)
      void ctx
    })
    bot.command('lang', async (ctx, [code]) => { await ctx.setLang(code) })
    await deliver(bot, provider, 'menu')
    await until(() => texts(provider).length === 1)
    // A command runs outside the conversation and switches the stored language...
    await deliver(bot, provider, '/lang en')
    // ...the next answer carries the new language into the conversation.
    await deliver(bot, provider, 'ok')
    await until(() => texts(provider).length === 2)
    expect(texts(provider)).toEqual(['Menú principal', 'en:Main menu'])
    await bot.stop()
  })

  it('c.goto() carries the latest language into the target conversation', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('es', ES).locale('en', EN)
    bot.conversation('a', async (c) => {
      await c.say('a')
      await c.waitText()
      c.goto('b')
    })
    bot.conversation('b', async (c) => {
      await c.say(`${c.lang}:${c.t('menu.title')}`)
    })
    bot.command('lang', async (ctx, [code]) => { await ctx.setLang(code) })
    await deliver(bot, provider, 'a')
    await until(() => texts(provider).length === 1)
    await deliver(bot, provider, '/lang en')
    await deliver(bot, provider, 'ok')
    await until(() => texts(provider).length === 2)
    expect(texts(provider)).toEqual(['a', 'en:Main menu'])
    await bot.stop()
  })

  it('flow DSL steps can translate through c.t', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('es', ES).locale('en', EN)
    bot.use(flow('menu').say((_ctx, c) => c.t('menu.items.games')))
    await deliver(bot, provider, 'menu', { language: 'en' })
    await until(() => texts(provider).length === 1)
    expect(texts(provider)).toEqual(['Games'])
    await bot.stop()
  })

  it('localizes the timeout message', async () => {
    const { bot, provider } = await makeBot({ conversation: { timeout: 30 } })
    bot.locale('en', EN)
    bot.conversation('q', async (c) => { await c.ask('Name?') })
    await deliver(bot, provider, 'q', { language: 'en' })
    await until(() => texts(provider).length === 2)
    expect(texts(provider)[1]).toBe('⏰ The conversation expired due to inactivity.')
    await bot.stop()
  })

  it('a configured timeoutMessage still wins over the locale', async () => {
    const { bot, provider } = await makeBot({ conversation: { timeout: 30, timeoutMessage: 'BYE' } })
    bot.locale('en', EN)
    bot.conversation('q', async (c) => { await c.ask('Name?') })
    await deliver(bot, provider, 'q', { language: 'en' })
    await until(() => texts(provider).length === 2)
    expect(texts(provider)[1]).toBe('BYE')
    await bot.stop()
  })

  it('localizes validation and retries messages, and user locales can override them', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('en', { ...EN, core: { wait: { invalid: 'Nope, again.' } } })
    bot.conversation('q', async (c) => { await c.ask('Age?', { validate: (b) => /^\d+$/.test(b) as true, retries: 2 }) })
    await deliver(bot, provider, 'q', { language: 'en' })
    await until(() => texts(provider).length === 1)
    await deliver(bot, provider, 'abc', { language: 'en' })
    await until(() => texts(provider).length === 2)
    await deliver(bot, provider, 'def', { language: 'en' })
    await until(() => texts(provider).length === 3)
    expect(texts(provider)).toEqual(['Age?', 'Nope, again.', '❌ Too many attempts. Conversation ended.'])
    await bot.stop()
  })

  it('localizes the text-only wait message', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('en', EN)
    bot.conversation('q', async (c) => { await c.ask('Name?') })
    await deliver(bot, provider, 'q', { language: 'en' })
    await until(() => texts(provider).length === 1)
    await deliver(bot, provider, '', { language: 'en', type: 'image' })
    await until(() => texts(provider).length === 2)
    expect(texts(provider)[1]).toBe('✍️ Please reply with text.')
    await bot.stop()
  })

  it('localizes slash commands', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('en', EN)
    bot.plug(slashCommandsPlugin)
    const steps: Array<[string, IncomingOpts]> = [
      ['/reset', { language: 'en' }],
      ['/ping', { language: 'en' }],
      ['/nope', { language: 'en' }],
      ['/help', { language: 'en' }],
      ['/reset', {}],
    ]
    for (const [i, [text, opts]] of steps.entries()) {
      await deliver(bot, provider, text, opts)
      await until(() => texts(provider).length === i + 1)
    }
    const out = texts(provider)
    expect(out[0]).toBe('✅ Conversation restarted.')
    expect(out[1]).toBe('pong 🏓')
    expect(out[2]).toBe('🤔 Unknown command. Send /help.')
    expect(out[3]).toContain('/help — this message')
    expect(out[4]).toBe('✅ Conversación reiniciada.')
    await bot.stop()
  })
})

describe('resolution pipeline', () => {
  it('ctx.lang is resolved before before(message) hooks run', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('en', EN)
    let seen: string | undefined
    bot.before('message', async (ctx: MessageContext, next: () => Promise<void>) => { seen = ctx.lang; await next() })
    bot.onMessage(() => undefined)
    await deliver(bot, provider, 'x', { language: 'en' })
    expect(seen).toBe('en')
    await bot.stop()
  })

  it('localizes the conversation error message and /id', async () => {
    const { bot, provider } = await makeBot({ logger: logger() })
    bot.on('error', () => undefined)
    bot.locale('en', EN)
    bot.plug(slashCommandsPlugin)
    bot.conversation('boom', async () => { throw new Error('x') })
    provider.incoming('boom', { language: 'en' })
    await until(() => texts(provider).length === 1)
    await deliver(bot, provider, '/id', { language: 'en', from: 'g1', sender: 's1', isGroup: true })
    await until(() => texts(provider).length === 2)
    expect(texts(provider)).toEqual(['⚠️ Something went wrong. The conversation ended.', '🆔 g1 (group)'])
    await bot.stop()
  })

  it('interactions are localized too', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('en', EN)
    bot.onMessage(async (ctx) => { await ctx.reply(ctx.t('menu.title')) })
    const done = dispatched(bot)
    provider.interaction('btn', { language: 'en' })
    await done
    expect(texts(provider)).toEqual(['Main menu'])
    await bot.stop()
  })
})

describe('i18n + bot.trigger', () => {
  it('a triggered conversation speaks the stored language of the subject', async () => {
    const { bot, provider } = await makeBot()
    bot.locale('es', ES).locale('en', EN)
    await bot.user('u1').set('lang', 'en')
    bot.conversation('aviso', async (c, ctx) => {
      await c.say(`${ctx.lang ?? '?'}:${ctx.t?.('menu.title') ?? '?'}`)
    })
    await bot.trigger('aviso', { chatId: 'u1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['en:Main menu']), { timeout: 1000, interval: 5 })
    await bot.stop()
  })
})
