import { describe, it, expect, vi } from 'vitest'
import { matchTrigger, triggerSpecificity } from '../src/core/matching.js'
import {
  WELCOME, MEDIA, IMAGE, VIDEO, AUDIO, VOICE_NOTE, DOCUMENT, STICKER, LOCATION, CONTACT, POLL, CALL,
  typeTrigger, isTypeTrigger, isWelcomeTrigger,
} from '../src/core/triggers.js'
import * as publicApi from '../src/index.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import { flow, addKeyword } from '../src/flows/FlowBuilder.js'
import { Bot } from '../src/core/Bot.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import type { IStore } from '../src/store/IStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import type { MessageContext, MessageType, Trigger } from '../src/core/types.js'

const msg = (type: string, over: Partial<{ body: string; isGroup: boolean }> = {}) =>
  ({ body: over.body ?? '', isGroup: over.isGroup ?? false, type })

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function textsTo(provider: MockProvider, chatId: string): string[] {
  return provider.outbox
    .filter((m) => m.chatId === chatId)
    .map((m) => (m.content.kind === 'text' ? m.content.text : ''))
}

describe('type trigger constants', () => {
  it('are exported from the package entry point', () => {
    for (const name of ['WELCOME', 'MEDIA', 'IMAGE', 'VIDEO', 'AUDIO', 'VOICE_NOTE', 'DOCUMENT', 'STICKER', 'LOCATION', 'CONTACT', 'POLL', 'CALL', 'typeTrigger', 'isTypeTrigger', 'isWelcomeTrigger']) {
      expect(publicApi).toHaveProperty(name)
    }
  })

  it('each single-kind constant matches exactly its MessageType', () => {
    const table: Array<[Trigger, MessageType]> = [
      [IMAGE, 'image'], [VIDEO, 'video'], [AUDIO, 'audio'], [VOICE_NOTE, 'voice'],
      [DOCUMENT, 'document'], [STICKER, 'sticker'], [LOCATION, 'location'],
      [CONTACT, 'contact'], [POLL, 'poll'], [CALL, 'call'],
    ]
    const all: MessageType[] = ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll', 'buttons', 'list', 'unknown', 'call']
    for (const [trigger, type] of table) {
      for (const other of all) {
        expect(matchTrigger(trigger, msg(other)), `${type} vs ${other}`).toBe(other === type)
      }
    }
  })

  it('AUDIO does not match voice notes (mirrors bot.onAudio); VOICE_NOTE does', () => {
    expect(matchTrigger(AUDIO, msg('voice'))).toBe(false)
    expect(matchTrigger(VOICE_NOTE, msg('voice'))).toBe(true)
  })

  it('MEDIA matches image/video/audio/voice/document/sticker and nothing else', () => {
    for (const t of ['image', 'video', 'audio', 'voice', 'document', 'sticker']) expect(matchTrigger(MEDIA, msg(t))).toBe(true)
    for (const t of ['text', 'location', 'contact', 'poll', 'buttons', 'list', 'unknown', 'call']) expect(matchTrigger(MEDIA, msg(t))).toBe(false)
  })

  it('a type trigger ignores the body (a caption never makes it miss or hit)', () => {
    expect(matchTrigger(IMAGE, msg('image', { body: 'hola' }))).toBe(true)
    expect(matchTrigger(IMAGE, msg('text', { body: 'image' }))).toBe(false)
  })

  it('constants are frozen so one module cannot mutate them for everybody', () => {
    expect(Object.isFrozen(IMAGE)).toBe(true)
    expect(Object.isFrozen(MEDIA.types)).toBe(true)
    expect(Object.isFrozen(WELCOME)).toBe(true)
  })

  it('scope works by spreading a constant', () => {
    const dmOnly = { ...IMAGE, scope: 'dm' as const }
    expect(matchTrigger(dmOnly, msg('image'))).toBe(true)
    expect(matchTrigger(dmOnly, msg('image', { isGroup: true }))).toBe(false)
    const groupOnly = { ...MEDIA, scope: 'group' as const }
    expect(matchTrigger(groupOnly, msg('video'))).toBe(false)
    expect(matchTrigger(groupOnly, msg('video', { isGroup: true }))).toBe(true)
  })

  it('typeTrigger(...) builds custom combinations; with no kinds it never matches', () => {
    const visual = typeTrigger('image', 'video')
    expect(matchTrigger(visual, msg('image'))).toBe(true)
    expect(matchTrigger(visual, msg('video'))).toBe(true)
    expect(matchTrigger(visual, msg('audio'))).toBe(false)
    expect(matchTrigger(typeTrigger(), msg('image'))).toBe(false)
    expect(triggerSpecificity(typeTrigger())).toBe(0)
  })

  it('guards recognise the special triggers and nothing else', () => {
    expect(isTypeTrigger(IMAGE)).toBe(true)
    expect(isTypeTrigger(WELCOME)).toBe(false)
    expect(isWelcomeTrigger(WELCOME)).toBe(true)
    expect(isWelcomeTrigger({ ...WELCOME, scope: 'dm' })).toBe(true)
    for (const other of ['image', /image/, ['image'], { pattern: 'image' }, () => true, null, undefined]) {
      expect(isTypeTrigger(other)).toBe(false)
      expect(isWelcomeTrigger(other)).toBe(false)
    }
  })
})

describe('specificity of special triggers', () => {
  const textTriggers: Trigger[] = [
    'hola',
    { pattern: 'h', match: 'startsWith' },
    { pattern: 'h', match: 'endsWith' },
    /h/,
    { pattern: 'h', match: 'contains' },
    () => true,
  ]

  it('every text/regex/function trigger outranks every type trigger (a text matcher is never shadowed)', () => {
    for (const t of textTriggers) {
      for (const type of [IMAGE, VOICE_NOTE, MEDIA, CALL, typeTrigger('image', 'video')]) {
        expect(triggerSpecificity(t)).toBeGreaterThan(triggerSpecificity(type))
      }
    }
  })

  it('a single-kind trigger outranks a multi-kind one (IMAGE > MEDIA)', () => {
    expect(triggerSpecificity(IMAGE)).toBeGreaterThan(triggerSpecificity(MEDIA))
    expect(triggerSpecificity(MEDIA)).toBeGreaterThan(0)
    expect(triggerSpecificity(typeTrigger('image', 'video'))).toBe(triggerSpecificity(MEDIA))
  })

  it('WELCOME outranks everything (it only ever fires on a first contact)', () => {
    for (const t of [...textTriggers, IMAGE, MEDIA]) {
      expect(triggerSpecificity(WELCOME)).toBeGreaterThan(triggerSpecificity(t))
    }
  })
})

describe('type triggers on a Bot', () => {
  it('bot.when(IMAGE) fires for images only', async () => {
    const { bot, chat } = await createTestBot()
    const seen: string[] = []
    bot.when(IMAGE, async (ctx) => { seen.push(ctx.type); await ctx.reply('imagen') })
    await chat.send('hola')
    await chat.send('', { type: 'image' })
    await chat.expectReply('imagen')
    expect(seen).toEqual(['image'])
  })

  it('a text matcher on the caption is NOT shadowed by a type trigger, whatever the registration order', async () => {
    const { bot, chat } = await createTestBot()
    const image = vi.fn(); const hola = vi.fn()
    bot.when(IMAGE, image)
    bot.when(MEDIA, image)
    bot.when('hola', hola)
    await chat.send('hola', { type: 'image' })
    expect(hola).toHaveBeenCalledOnce()
    expect(image).not.toHaveBeenCalled()
  })

  it('IMAGE beats MEDIA regardless of registration order; MEDIA catches the rest', async () => {
    const { bot, chat } = await createTestBot()
    const calls: string[] = []
    bot.when(MEDIA, (ctx) => { calls.push(`media:${ctx.type}`) })
    bot.when(IMAGE, (ctx) => { calls.push(`image:${ctx.type}`) })
    await chat.send('', { type: 'image' })
    await chat.send('', { type: 'voice' })
    await chat.send('', { type: 'document' })
    expect(calls).toEqual(['image:image', 'media:voice', 'media:document'])
  })

  it('type triggers run before the catch-all and ctx.pass() cascades to it', async () => {
    const { bot, chat } = await createTestBot()
    const order: string[] = []
    bot.onMessage(() => { order.push('catch-all') })
    bot.when(LOCATION, (ctx) => { order.push('location'); ctx.pass() })
    bot.when(CONTACT, () => { order.push('contact') })
    await chat.send('', { type: 'location' })
    await chat.send('', { type: 'contact' })
    expect(order).toEqual(['location', 'catch-all', 'contact'])
  })

  it('bot.onImage and bot.when(IMAGE) share a tier (registration order breaks the tie) and both beat MEDIA', async () => {
    const { bot, chat } = await createTestBot()
    const calls: string[] = []
    bot.when(MEDIA, () => { calls.push('media') })
    bot.onImage(() => { calls.push('onImage') })
    bot.when(IMAGE, () => { calls.push('when') })
    await chat.send('', { type: 'image' })
    expect(calls).toEqual(['onImage'])
  })

  it('works as a flow()/addKeyword() trigger, including .scope()', async () => {
    const { bot, provider, chat } = await createTestBot()
    bot.use(flow(VOICE_NOTE).say('nota de voz recibida'))
    bot.use(addKeyword(STICKER).scope('dm').say('lindo sticker'))
    await chat.send('', { type: 'voice' })
    await chat.expectReply('nota de voz recibida')
    await chat.send('', { type: 'sticker' })
    await chat.expectReply('lindo sticker')

    provider.incoming('', { from: 'g@g.us', sender: 'u1', isGroup: true, type: 'sticker' })
    await tick(10)
    expect(textsTo(provider, 'g@g.us')).toEqual([])
  })

  it('a flow started by a type trigger keeps its conversation (next text answers the ask)', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow(DOCUMENT).ask('¿Para qué es el documento?', 'why').say((_ctx, c) => `ok: ${String(c.state.why)}`))
    await chat.send('', { type: 'document' })
    await chat.expectReply('¿Para qué es el documento?')
    await chat.send('factura')
    await chat.expectReply('ok: factura')
  })

  it('POLL fires for inbound polls; the unsubscriber removes the handler', async () => {
    const { bot, chat } = await createTestBot()
    const poll = vi.fn()
    const off = bot.when(POLL, poll)
    await chat.send('¿pizza?', { type: 'poll' })
    off()
    await chat.send('¿pizza?', { type: 'poll' })
    expect(poll).toHaveBeenCalledOnce()
  })
})

describe('CALL trigger', () => {
  it('bot.when(CALL) receives a call context that can reply to the caller', async () => {
    const { bot, provider } = await createTestBot()
    let seen: MessageContext | undefined
    bot.when(CALL, async (ctx) => { seen = ctx; await ctx.reply('No atiendo llamadas, escríbeme 🙏') })
    provider.call({ id: 'call-1', from: 'caller-1', status: 'offer' })
    await tick(10)
    expect(textsTo(provider, 'caller-1')).toEqual(['No atiendo llamadas, escríbeme 🙏'])
    expect(seen?.type).toBe('call')
    expect(seen?.from).toBe('caller-1')
    expect(seen?.sender).toBe('caller-1')
    expect(seen?.isGroup).toBe(false)
    expect(seen?.body).toBe('')
    expect(seen?.call).toEqual({ id: 'call-1', from: 'caller-1', status: 'offer' })
  })

  it('fires once per call id, while bot.on("call") still sees every status update', async () => {
    const { bot, provider } = await createTestBot()
    const handler = vi.fn()
    const raw: string[] = []
    bot.when(CALL, handler)
    bot.on('call', (e) => { raw.push(e.status) })
    provider.call({ id: 'c-1', from: 'caller', status: 'offer' })
    provider.call({ id: 'c-1', from: 'caller', status: 'terminate' })
    provider.call({ id: 'c-2', from: 'caller', status: 'offer' })
    await tick(10)
    expect(handler).toHaveBeenCalledTimes(2)
    expect(raw).toEqual(['offer', 'terminate', 'offer'])
  })

  it('never reaches text/function triggers, the catch-all, the message event or an active conversation', async () => {
    const { bot, provider, chat } = await createTestBot()
    const fnTrigger = vi.fn(); const catchAll = vi.fn(); const onMessage = vi.fn()
    bot.when(() => true, fnTrigger)
    bot.onMessage(catchAll)
    bot.on('message', onMessage)
    bot.when(CALL, () => { /* consumed */ })
    bot.use(flow('registrar').ask('¿nombre?', 'n').say((_ctx, c) => `hola ${String(c.state.n)}`))

    await chat.send('registrar')
    await chat.expectReply('¿nombre?')
    fnTrigger.mockClear(); catchAll.mockClear(); onMessage.mockClear()

    provider.call({ id: 'c-x', from: chat.jid, status: 'offer' })
    await tick(10)
    expect(fnTrigger).not.toHaveBeenCalled()
    expect(catchAll).not.toHaveBeenCalled()
    expect(onMessage).not.toHaveBeenCalled()

    await chat.send('Ana')            // the ask is still waiting: the call did not answer it
    await chat.expectReply('hola Ana')
  })

  it('without a CALL handler a call only emits the call event (no message dispatch)', async () => {
    const { bot, provider } = await createTestBot()
    const catchAll = vi.fn(); const onCall = vi.fn()
    bot.onMessage(catchAll)
    bot.on('call', onCall)
    provider.call({ id: 'c-1', from: 'caller', status: 'offer' })
    await tick(10)
    expect(onCall).toHaveBeenCalledOnce()
    expect(catchAll).not.toHaveBeenCalled()
    expect(provider.outbox).toEqual([])
  })

  it('works as a flow trigger: the caller can keep talking in DM', async () => {
    const { bot, provider } = await createTestBot()
    bot.use(flow(CALL).ask('Vi tu llamada, ¿en qué te ayudo?', 'need').say((_ctx, c) => `anotado: ${String(c.state.need)}`))
    provider.call({ id: 'c-9', from: 'caller-9', status: 'offer' })
    await tick(10)
    expect(textsTo(provider, 'caller-9')).toEqual(['Vi tu llamada, ¿en qué te ayudo?'])
    provider.incoming('soporte', { from: 'caller-9' })
    await tick(10)
    expect(textsTo(provider, 'caller-9')).toContain('anotado: soporte')
  })

  it('bot.onType("call") is equivalent to bot.when(CALL)', async () => {
    const { bot, provider } = await createTestBot()
    const handler = vi.fn()
    bot.onType('call', handler)
    provider.call({ id: 'c-1', from: 'caller', status: 'offer' })
    await tick(10)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('ctx.pass() cascades between CALL handlers', async () => {
    const { bot, provider } = await createTestBot()
    const order: string[] = []
    bot.when(CALL, (ctx) => { order.push('first'); ctx.pass() })
    bot.when(CALL, () => { order.push('second') })
    bot.when(CALL, () => { order.push('third') })
    provider.call({ id: 'c-1', from: 'caller', status: 'offer' })
    await tick(10)
    expect(order).toEqual(['first', 'second'])
  })

  it('a before("call") hook that aborts suppresses the CALL trigger', async () => {
    const { bot, provider } = await createTestBot()
    const handler = vi.fn()
    bot.before('call', (event: { abort(): void }) => { event.abort() })
    bot.when(CALL, handler)
    provider.call({ id: 'c-1', from: 'blocked', status: 'offer' })
    await tick(10)
    expect(handler).not.toHaveBeenCalled()
  })

  it('a throwing CALL handler surfaces on bot.on("error") with the call context', async () => {
    const { bot, provider } = await createTestBot()
    const errors: Array<{ error: unknown; ctx?: MessageContext }> = []
    bot.on('error', (e) => { errors.push(e) })
    bot.when(CALL, () => { throw new Error('boom') })
    provider.call({ id: 'c-1', from: 'caller', status: 'offer' })
    await tick(10)
    expect(errors).toHaveLength(1)
    expect((errors[0].error as Error).message).toBe('boom')
    expect(errors[0].ctx?.type).toBe('call')
  })

  it('calls are ignored once the bot is stopped', async () => {
    const { bot, provider } = await createTestBot()
    const handler = vi.fn()
    bot.when(CALL, handler)
    await bot.stop()
    provider.call({ id: 'c-1', from: 'caller', status: 'offer' })
    await tick(10)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('CALL trigger vs conversations in progress', () => {
  /**
   * A persistent two-step order flow on a MemoryStore + MockProvider. `store` is the bot's
   * (namespaced) store, so checkpoint keys are plain chat keys; `seed` runs before `start()`.
   */
  async function bootOrderBot(seed?: (store: IStore) => Promise<void>) {
    const provider = new MockProvider()
    const bot = new Bot({ provider, store: new MemoryStore() })
    const store = bot.getStore()
    await seed?.(store)
    bot.use(flow('pedido').id('pedido').persistent()
      .ask('¿direccion?', 'dir')
      .ask('¿pago?', 'pago')
      .say((_ctx, c) => `pedido: ${String(c.state.dir)} / ${String(c.state.pago)}`))
    await bot.start()
    const say = async (text: string) => { provider.incoming(text, { from: 'u1' }); await tick(10) }
    return { bot, provider, store, say }
  }

  it('a flow(CALL) never replaces the caller\'s active conversation nor clears its checkpoint', async () => {
    const { bot, provider, store, say } = await bootOrderBot()
    bot.use(flow(CALL).say('vi tu llamada'))
    await say('pedido')
    await say('calle 1')
    expect(await store.listCheckpoints()).toEqual([['u1', expect.objectContaining({ flowId: 'pedido', step: 1 })]])

    provider.call({ id: 'c1', from: 'u1' })
    await tick(10)
    expect(await store.listCheckpoints()).toEqual([['u1', expect.objectContaining({ flowId: 'pedido', step: 1 })]])

    await say('tarjeta')
    expect(textsTo(provider, 'u1')).toEqual(['¿direccion?', '¿pago?', 'pedido: calle 1 / tarjeta'])
  })

  it('a bot.conversation(…, { trigger: CALL }) never replaces an active conversation either', async () => {
    const { bot, provider, say } = await bootOrderBot()
    const started = vi.fn()
    bot.conversation('callback', async () => { started() }, { trigger: CALL })
    await say('pedido')
    provider.call({ id: 'c1', from: 'u1' })
    await tick(10)
    expect(started).not.toHaveBeenCalled()
    await say('calle 1')
    expect(textsTo(provider, 'u1')).toEqual(['¿direccion?', '¿pago?'])
  })

  it('a skipped CALL flow lets the next CALL handler run, and plain handlers still fire mid-flow', async () => {
    const { bot, provider, say } = await bootOrderBot()
    bot.use(flow(CALL).say('vi tu llamada'))
    bot.when(CALL, (ctx) => ctx.reply('📵 no atiendo llamadas'))
    await say('pedido')
    provider.call({ id: 'c1', from: 'u1' })
    await tick(10)
    expect(textsTo(provider, 'u1')).toEqual(['¿direccion?', '📵 no atiendo llamadas'])
    await say('calle 1')
    expect(textsTo(provider, 'u1').at(-1)).toBe('¿pago?')

    // With no conversation in progress the CALL flow (registered first) wins as usual.
    provider.call({ id: 'c2', from: 'u2' })
    await tick(10)
    expect(textsTo(provider, 'u2')).toEqual(['vi tu llamada'])
  })

  it('a flow(CALL) does not start over a dormant checkpoint; the next message resumes it', async () => {
    const { bot, provider, store, say } = await bootOrderBot(async (s) => {
      await s.setCheckpoint('u1', { flowId: 'pedido', step: 1, state: { dir: 'calle 1' }, updatedAt: Date.now() })
    })
    bot.use(flow(CALL).ask('vi tu llamada, ¿qué necesitas?', 'need'))

    provider.call({ id: 'c1', from: 'u1' })
    await tick(10)
    expect(textsTo(provider, 'u1')).toEqual([])
    expect(await store.listCheckpoints()).toEqual([['u1', expect.objectContaining({ flowId: 'pedido', step: 1 })]])

    await say('hola')                 // wakes the dormant order flow: re-prompts the pending ask
    await say('tarjeta')
    expect(textsTo(provider, 'u1')).toEqual(['¿pago?', 'pedido: calle 1 / tarjeta'])
  })
})

describe('CALL trigger — group calls', () => {
  it('a group call is projected into the group: reply goes to the group, sender is the caller', async () => {
    const { bot, provider } = await createTestBot()
    let seen: MessageContext | undefined
    bot.when(CALL, async (ctx) => { seen = ctx; await ctx.reply('no atiendo llamadas de grupo') })
    provider.call({ id: 'g-1', from: 'caller-1', chatId: 'group-1', isGroup: true })
    await tick(10)
    expect(seen?.isGroup).toBe(true)
    expect(seen?.from).toBe('group-1')
    expect(seen?.sender).toBe('caller-1')
    expect(textsTo(provider, 'group-1')).toEqual(['no atiendo llamadas de grupo'])
    expect(textsTo(provider, 'caller-1')).toEqual([])
  })

  it('scope separates DM calls from group calls', async () => {
    const { bot, provider } = await createTestBot()
    const dm = vi.fn(); const group = vi.fn()
    bot.when({ ...CALL, scope: 'dm' }, (ctx) => { dm(ctx.from); ctx.pass() })
    bot.when({ ...CALL, scope: 'group' }, (ctx) => { group(ctx.from) })
    provider.call({ id: 'c-dm', from: 'caller-1' })
    provider.call({ id: 'c-group', from: 'caller-1', chatId: 'group-1', isGroup: true })
    await tick(10)
    expect(dm.mock.calls).toEqual([['caller-1']])
    expect(group.mock.calls).toEqual([['group-1']])
  })

  it('a group flow(CALL) is per participant: the caller\'s next group message answers it', async () => {
    const { bot, provider } = await createTestBot()
    bot.use(flow(CALL).ask('¿qué necesitas?', 'need').say((_ctx, c) => `ok: ${String(c.state.need)}`))
    provider.call({ id: 'g-1', from: 'caller-1', chatId: 'group-1', isGroup: true })
    await tick(10)
    provider.incoming('soporte', { from: 'group-1', sender: 'caller-1', isGroup: true })
    await tick(10)
    expect(textsTo(provider, 'group-1')).toEqual(['¿qué necesitas?', 'ok: soporte'])
  })

  it('groupMode "mentions"/"commands" keep group calls away from CALL triggers (DM calls still fire)', async () => {
    for (const groupMode of ['mentions', 'commands'] as const) {
      const { bot, provider } = await createTestBot({ groupMode })
      const handler = vi.fn()
      bot.when(CALL, (ctx) => { handler(ctx.from) })
      provider.call({ id: 'c-group', from: 'caller-1', chatId: 'group-1', isGroup: true })
      provider.call({ id: 'c-dm', from: 'caller-1' })
      await tick(10)
      expect(handler.mock.calls, groupMode).toEqual([['caller-1']])
    }
  })
})
