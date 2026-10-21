import { describe, expect, it } from 'vitest'
import { flow, loadMediaOf, MediaUnavailableError, IMAGE, type InboundReaction, type MessageContext, type MessageRef } from '../src/index.js'
import {
  assertStableIdentity,
  assertTranscript,
  createTestBot,
  parseTranscript,
  serializeTranscript,
  TestKitError,
  type Transcript,
} from '../src/testing/index.js'

describe('chat.expectNoReply', () => {
  it('resolves when the bot stays silent', async () => {
    const { bot, chat } = await createTestBot()
    bot.when('hola', async (ctx) => await ctx.reply('👋'))
    await chat.send('nada')
    await chat.expectNoReply({ timeout: 30 })
    await chat.expectNoReply(30)
    await bot.stop()
  })

  it('rejects when an unconsumed reply already exists, without consuming it', async () => {
    const { bot, chat } = await createTestBot()
    bot.when('hola', async (ctx) => await ctx.reply('👋'))
    await chat.send('hola')
    await expect(chat.expectNoReply({ timeout: 20 })).rejects.toThrow(/Expected no reply in user@s\.whatsapp\.net within 20ms, got: \["👋"\]/)
    await expect(chat.expectNoReply({ timeout: 20 })).rejects.toBeInstanceOf(TestKitError)
    await expect(chat.expectReply('👋')).resolves.toBe('👋')
    await chat.expectNoReply({ timeout: 20 })
    await bot.stop()
  })

  it('rejects when a reply arrives inside the window', async () => {
    const { bot, chat } = await createTestBot()
    bot.when('lento', async (ctx) => { await new Promise((r) => setTimeout(r, 20)); await ctx.reply('tarde') })
    await chat.send('lento')
    await expect(chat.expectNoReply({ timeout: 200 })).rejects.toThrow(/got: \["tarde"\]/)
    await bot.stop()
  })
})

describe('chat.sendMedia', () => {
  it('fires media triggers with caption, metadata and downloadable bytes', async () => {
    const { bot, chat } = await createTestBot()
    const bytes = Buffer.from('PNG-bytes')
    const seen: Array<{ body: string; mimetype?: string; filename?: string; size?: number; bytes: string }> = []
    bot.when(IMAGE, async (ctx) => {
      const media = await loadMediaOf(ctx, { throwOnError: true })
      seen.push({ body: ctx.body, mimetype: media?.mimetype, filename: media?.filename, size: media?.size, bytes: media?.buffer.toString() ?? '' })
      await ctx.reply('gracias')
    })
    await chat.sendMedia('image', bytes, 'mi foto')
    await chat.expectReply('gracias')
    expect(seen).toEqual([{ body: 'mi foto', mimetype: 'image/jpeg', filename: undefined, size: bytes.length, bytes: 'PNG-bytes' }])

    await chat.sendMedia('image', bytes, { caption: 'otra', mimetype: 'image/webp', filename: 'a.webp', size: 99 })
    await chat.expectReply('gracias')
    expect(seen[1]).toEqual({ body: 'otra', mimetype: 'image/webp', filename: 'a.webp', size: 99, bytes: 'PNG-bytes' })
    await bot.stop()
  })

  it('a { url } source without bytes makes the download reject with MediaUnavailableError', async () => {
    const { bot, chat } = await createTestBot()
    const errors: unknown[] = []
    bot.when(IMAGE, async (ctx) => {
      try { await loadMediaOf(ctx, { throwOnError: true }) } catch (error) { errors.push(error) }
      await ctx.reply('done')
    })
    await chat.sendMedia('image', { url: 'https://example.com/a.png' })
    await chat.expectReply('done')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(MediaUnavailableError)
    expect(chat.lastReply()?.content).toEqual({ kind: 'text', text: 'done' })
    await bot.stop()
  })

  it('legacy provider.incoming(text, { type: "image" }) still downloads an empty buffer', async () => {
    const { bot, chat, provider } = await createTestBot()
    const lengths: number[] = []
    bot.when(IMAGE, async (ctx) => { lengths.push((await loadMediaOf(ctx, { throwOnError: true }))?.buffer.length ?? -1); await ctx.reply('ok') })
    provider.incoming('x', { from: chat.chatId, type: 'image' })
    await chat.expectReply('ok')
    expect(lengths).toEqual([0])
    await bot.stop()
  })
})

describe('chat.sendReaction', () => {
  it('targets the bot\'s last reply by default and runs hooks and the reaction event', async () => {
    const { bot, chat } = await createTestBot()
    bot.when('hola', async (ctx) => await ctx.reply('👋'))
    const events: InboundReaction[] = []
    const hooked: InboundReaction[] = []
    bot.on('reaction', (r) => { events.push(r) })
    bot.before('reaction', async (r, next) => { hooked.push(r as InboundReaction); await next() })
    await chat.send('hola')
    await chat.expectReply('👋')
    await chat.sendReaction('👍')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ emoji: '👍', senderId: chat.senderId, ref: { chatId: chat.chatId } })
    expect(events[0].ref.id).toBe(chat.lastReply()?.ref.id)
    expect(events[0].ref.id).toMatch(/^mock-/)
    expect(hooked).toHaveLength(1)

    await chat.sendReaction('❤️', { removed: true })
    expect(events[1]).toMatchObject({ emoji: '❤️', removed: true })

    const ref: MessageRef = { id: 'explicit', chatId: chat.chatId }
    await chat.sendReaction('🔥', ref)
    expect(events[2].ref).toEqual(ref)
    await chat.sendReaction('🙂', { to: ref, removed: true })
    expect(events[3]).toMatchObject({ ref, removed: true })
    await bot.stop()
  })

  it('falls back to the user\'s last message and throws when there is nothing to react to', async () => {
    const { bot, chat } = await createTestBot()
    await expect(chat.sendReaction('👍')).rejects.toThrow(TestKitError)
    await expect(chat.sendReaction('👍')).rejects.toThrow(/send or receive a message first/)
    const events: InboundReaction[] = []
    bot.on('reaction', (r) => { events.push(r) })
    await chat.send('hola')
    await chat.sendReaction('👍')
    expect(events[0].ref.chatId).toBe(chat.chatId)
    expect(events[0].ref.id).toMatch(/^in-/)
    await bot.stop()
  })
})

describe('chat.sendLocation', () => {
  it('accepts coordinates and an extra object, same as a location object', async () => {
    const { bot, chat } = await createTestBot()
    const seen: unknown[] = []
    bot.conversation('ubi', async (c, ctx) => {
      const location = await c.waitLocation()
      seen.push(ctx.sharedLocation, location)
      await c.say('ok')
    })
    await chat.send('ubi')
    await chat.sendLocation(4.6, -74.08, { name: 'Bogotá' })
    await chat.expectReply('ok')
    expect(seen[1]).toEqual({ latitude: 4.6, longitude: -74.08, name: 'Bogotá' })
    await chat.send('ubi')
    await chat.sendLocation({ latitude: 4.6, longitude: -74.08, name: 'Bogotá' })
    await chat.expectReply('ok')
    expect(seen[3]).toEqual(seen[1])
    await bot.stop()
  })
})

describe('chat.pressButton', () => {
  it('presses native buttons by id, title or index and drives the conversation', async () => {
    const { bot, chat } = await createTestBot()
    bot.conversation('menu', async (c, ctx) => {
      await ctx.buttons('Elige', [{ id: 'si', title: 'Sí' }, { id: 'no', title: 'No' }, { id: 'web', title: 'Web', url: 'https://x' }])
      const picked = await c.waitAny()
      await c.say(`picked ${picked.body} (${picked.type})`)
    })
    await chat.send('menu')
    await chat.expectReply('Elige')
    const pressed = await chat.pressButton('si')
    expect(pressed).toEqual({ id: 'si', title: 'Sí', index: 1, kind: 'button' })
    await chat.expectReply('picked si (buttons)')

    await chat.send('menu')
    await chat.expectReply('Elige')
    expect(await chat.pressButton('no')).toMatchObject({ id: 'no', index: 2 })
    await chat.expectReply('picked no')

    await chat.send('menu')
    await chat.expectReply('Elige')
    expect(await chat.pressButton(1)).toMatchObject({ id: 'si' })
    await chat.expectReply('picked si')

    await chat.send('menu')
    await chat.expectReply('Elige')
    await expect(chat.pressButton('Web')).rejects.toThrow(/link button/)
    await expect(chat.pressButton('nope')).rejects.toThrow(/1 · si · Sí/)
    await expect(chat.pressButton(9)).rejects.toThrow(TestKitError)
    await bot.stop()
  })

  it('presses list rows (kind list) and card buttons', async () => {
    const { bot, chat } = await createTestBot()
    const kinds: string[] = []
    bot.when('lista', async (ctx) => {
      await bot.sendTo(ctx.from, { kind: 'list', text: 'Menú', buttonText: 'Ver', sections: [{ title: 'A', rows: [{ id: 'r1', title: 'Fila 1' }, { id: 'r2', title: 'Fila 2', description: 'd' }] }] })
    })
    bot.when('card', async (ctx) => { await bot.sendTo(ctx.from, { kind: 'card', title: 'Tarjeta', buttons: [{ id: 'cb', title: 'Card button' }] }) })
    bot.onType('buttons', async (ctx) => { kinds.push(ctx.body); await ctx.reply(`got ${ctx.body}`) })
    await chat.send('lista')
    await chat.expectReply('Menú')
    expect(await chat.pressButton('fila 2')).toEqual({ id: 'r2', title: 'Fila 2', index: 2, kind: 'list' })
    await chat.expectReply('got r2')
    await chat.send('card')
    await chat.expectReply('Tarjeta')
    expect(await chat.pressButton('cb')).toEqual({ id: 'cb', title: 'Card button', index: 1, kind: 'button' })
    await chat.expectReply('got cb')
    expect(kinds).toEqual(['r2', 'cb'])
    await bot.stop()
  })

  it('explains when nothing interactive was sent (and hints at numbered menus without native buttons)', async () => {
    const { bot, chat } = await createTestBot()
    await expect(chat.pressButton(1)).rejects.toThrow(/no native buttons, list or card sent to user@s\.whatsapp\.net yet/)
    await bot.stop()
    const plain = await createTestBot({}, { provider: { buttons: false } })
    plain.bot.when('menu', async (ctx) => { await ctx.buttons('Elige', [{ id: 'a', title: 'A' }]) })
    await plain.chat.send('menu')
    await plain.chat.expectReply('Elige')
    await expect(plain.chat.pressButton('a')).rejects.toThrow(/menus are numbered text: use chat\.send\('1'\)/)
    await plain.bot.stop()
  })
})

describe('chat.sendInteraction', () => {
  it('emits a raw interaction with the given kind', async () => {
    const { bot, chat, provider } = await createTestBot()
    const seen: string[] = []
    bot.onType('buttons', async (ctx) => { seen.push(`${ctx.body}:${ctx.interaction?.data ?? ''}`); await ctx.reply('ok') })
    await chat.sendInteraction('cmd', { kind: 'command', id: 'it-x' })
    await chat.expectReply('ok')
    expect(seen).toEqual(['cmd:cmd'])
    const entry = provider.journal.find((e) => e.dir === 'in')
    expect(entry && entry.dir === 'in' && entry.event.kind === 'interaction' ? entry.event.interaction.kind : undefined).toBe('command')
    await bot.stop()
  })
})

describe('several users and groups', () => {
  it('group participants run independent conversations and share the reply cursor', async () => {
    const { bot, group, provider } = await createTestBot()
    bot.use(flow('hola').ask('¿Tu nombre?', 'name').say((_ctx, c) => `Hola ${c.state.name}`))
    const a = group('grupo@g.us', { as: 'a@s.whatsapp.net', displayName: 'Ana' })
    const b = a.as('b@s.whatsapp.net', { displayName: 'Beto' })
    expect(a.chatId).toBe('grupo@g.us')
    expect(b.chatId).toBe('grupo@g.us')
    expect(a.isGroup).toBe(true)
    expect(b.senderId).toBe('b@s.whatsapp.net')
    await a.send('hola')
    await a.expectReply('¿Tu nombre?')
    await b.send('hola')
    await b.expectReply('¿Tu nombre?')
    await a.send('Ana')
    await a.expectReply('Hola Ana')
    await b.send('Beto')
    await b.expectReply('Hola Beto')
    // The cursor is per chat: `a` already consumed everything `b` saw.
    await a.expectNoReply({ timeout: 20 })
    const inbound = provider.journal.filter((e) => e.dir === 'in').map((e) => (e.dir === 'in' ? e.event : undefined)!)
    assertStableIdentity(inbound, {
      ana: { events: [0, 2], senderId: 'a@s.whatsapp.net', chatId: 'grupo@g.us', kind: 'group' },
      beto: { events: [1, 3], senderId: 'b@s.whatsapp.net', chatId: 'grupo@g.us', kind: 'group' },
    })
    await bot.stop()
  })

  it('dm() is isolated from the default chat and as() on a DM is another DM', async () => {
    const { bot, chat, dm } = await createTestBot()
    bot.when('hola', async (ctx) => await ctx.reply(`hola ${ctx.senderInfo?.displayName ?? ctx.from}`))
    const other = dm('x@s.whatsapp.net', { displayName: 'Xavi' })
    expect(other.chatId).toBe('x@s.whatsapp.net')
    expect(other.senderId).toBe('x@s.whatsapp.net')
    expect(other.isGroup).toBe(false)
    await other.send('hola')
    await other.expectReply('hola Xavi')
    await chat.expectNoReply({ timeout: 20 })
    const third = chat.as('y@s.whatsapp.net')
    expect(third.chatId).toBe('y@s.whatsapp.net')
    expect(third.isGroup).toBe(false)
    expect(() => chat.as('')).toThrow(RangeError)
    expect(() => dm('')).toThrow(RangeError)
    await bot.stop()
  })
})

describe('chat.transcript', () => {
  it('is deterministic by default and opts into ids, timestamps, all chats and text', async () => {
    const { bot, chat, dm } = await createTestBot()
    bot.when('hola', async (ctx) => { await ctx.reply('¿Tu nombre?') })
    bot.when('menu', async (ctx) => { await ctx.buttons('Elige', [{ id: 'a', title: 'A' }]) })
    await chat.send('hola')
    await chat.expectReply('¿Tu nombre?')
    await chat.send('menu')
    await chat.expectReply('Elige')
    await chat.pressButton('a')
    await dm('other').send('hola')
    await dm('other').expectReply('¿Tu nombre?')

    const t = chat.transcript({ name: 'saludo' })
    expect(t).toEqual({
      format: 'botmesh/transcript',
      version: 1,
      name: 'saludo',
      source: 'recorder',
      turns: [
        { dir: 'in', chatId: 'user@s.whatsapp.net', senderId: 'user@s.whatsapp.net', type: 'text', text: 'hola', displayName: 'Test User' },
        { dir: 'out', chatId: 'user@s.whatsapp.net', kind: 'text', text: '¿Tu nombre?', content: { kind: 'text', text: '¿Tu nombre?' } },
        { dir: 'in', chatId: 'user@s.whatsapp.net', senderId: 'user@s.whatsapp.net', type: 'text', text: 'menu', displayName: 'Test User' },
        { dir: 'out', chatId: 'user@s.whatsapp.net', kind: 'buttons', text: 'Elige', content: { kind: 'buttons', text: 'Elige', buttons: [{ id: 'a', title: 'A' }] } },
        { dir: 'in', event: 'interaction', chatId: 'user@s.whatsapp.net', senderId: 'user@s.whatsapp.net', type: 'button', text: 'a', displayName: 'Test User' },
      ],
    })
    expect(chat.transcript()).toEqual(chat.transcript())
    expect(parseTranscript(serializeTranscript(t))).toEqual(t)

    const withIds = chat.transcript({ ids: true, timestamps: true })
    expect(withIds.turns.map((turn) => turn.id)).toEqual([expect.stringMatching(/^in-/), expect.stringMatching(/^mock-/), expect.stringMatching(/^in-/), expect.stringMatching(/^mock-/), expect.stringMatching(/^in-/)])
    expect(withIds.turns.every((turn) => typeof turn.t === 'number')).toBe(true)
    expect(withIds.turns[0].t).toBe(0)

    const all = chat.transcript({ scope: 'all' })
    expect(all.turns).toHaveLength(7)
    expect(all.turns[5]).toMatchObject({ dir: 'in', chatId: 'other', text: 'hola' })

    expect(chat.transcript({ as: 'text' })).toBe([
      'user@s.whatsapp.net> hola',
      'bot< ¿Tu nombre?',
      'user@s.whatsapp.net> menu',
      'bot< [buttons] Elige',
      'user@s.whatsapp.net> (button) a',
    ].join('\n'))
    expect(chat.transcript({ scope: 'all', as: 'text' }).split('\n')[5]).toBe('[other] other> hola')
    await bot.stop()
  })

  it('replays with assertTranscript against the same bot definition and reports a changed bot', async () => {
    const define = (bot: { when: (t: string, h: (ctx: MessageContext) => Promise<unknown>) => unknown }, reply: string) => {
      bot.when('hola', async (ctx) => { await ctx.reply(reply) })
    }
    const { bot, chat } = await createTestBot()
    define(bot, '👋')
    await chat.send('hola')
    await chat.expectReply('👋')
    const golden: Transcript = chat.transcript({ name: 'hola' })
    await bot.stop()

    const { Bot } = await import('../src/index.js')
    await assertTranscript(golden, (provider) => { const b = new Bot({ provider }); define(b, '👋'); return b })
    await expect(assertTranscript(golden, (provider) => { const b = new Bot({ provider }); define(b, 'cambiado'); return b })).rejects.toThrow(/difference/)
  })
})

describe('chat.sent / lastReply', () => {
  it('expose the full outbound content', async () => {
    const { bot, chat } = await createTestBot()
    bot.when('foto', async (ctx) => { await ctx.photo({ url: 'https://x/a.png' }, 'cap'); await ctx.react('👍') })
    await chat.send('foto')
    await chat.expectReply('cap')
    await new Promise((r) => setTimeout(r, 5))
    expect(chat.sent().map((m) => m.content.kind)).toEqual(['image', 'reaction'])
    expect(chat.lastReply()?.content).toMatchObject({ kind: 'reaction', emoji: '👍' })
    expect(chat.replies()).toEqual(['cap', ''])
    await bot.stop()
  })
})
