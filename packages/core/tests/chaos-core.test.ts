/**
 * Core behaviour under adversarial delivery (duplicates, reordering, latency,
 * transient send failures, connection drops, alias identities) driven by the
 * seeded chaos kit. Every scenario here is deterministic for its seed.
 */
import { describe, it, expect, vi } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { ChaosDisconnectedError } from '../src/testing/chaos.js'
import { assertStableIdentity, IdentityContractError } from '../src/testing/identityContract.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { RateLimitedError, ProviderError } from '../src/core/provider.js'
import type { MockProvider } from '../src/testing/MockProvider.js'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

const textsTo = (provider: MockProvider, chatId: string) =>
  provider.outbox
    .filter((o) => o.chatId === chatId)
    .map((o) => (o.content.kind === 'text' ? o.content.text : `<${o.content.kind}>`))

const registrar = () => flow('registrar')
  .ask('¿nombre?', 'name')
  .ask('¿ciudad?', 'city')
  .say((_c, c) => `ok ${String(c.state.name)}/${String(c.state.city)}`)

describe('core under duplicate delivery', () => {
  it('a redelivered trigger and answer never corrupt a running flow', async () => {
    const { bot, provider, chaos } = await createTestBot({}, { chaos: { duplicates: { probability: 1, copies: 2 } } })
    bot.use(registrar())
    provider.incoming('registrar', { from: 'u1' })
    await vi.waitFor(() => expect(textsTo(provider, 'u1')).toEqual(['¿nombre?']))
    provider.incoming('Ana', { from: 'u1' })
    await vi.waitFor(() => expect(textsTo(provider, 'u1')).toEqual(['¿nombre?', '¿ciudad?']))
    provider.incoming('Quito', { from: 'u1' })
    await vi.waitFor(() => expect(textsTo(provider, 'u1')).toHaveLength(3))
    await chaos.settle()
    expect(textsTo(provider, 'u1')).toEqual(['¿nombre?', '¿ciudad?', 'ok Ana/Quito'])
    expect(chaos.delivered).toHaveLength(9) // 3 messages × (1 + 2 copies) reached the bot
    expect((await bot.getStore().getMessagesByChat('u1')).filter((m) => m.direction === 'inbound')).toHaveLength(3)
    await bot.stop()
  })

  it('without dedupe the same redeliveries corrupt the flow (why the guard exists)', async () => {
    const { bot, provider, chaos } = await createTestBot({ dedupe: false }, { chaos: { duplicates: 1 } })
    bot.use(registrar())
    provider.incoming('registrar', { from: 'u1' })
    await chaos.settle()
    provider.incoming('Ana', { from: 'u1' })
    await chaos.settle()
    expect(textsTo(provider, 'u1')).not.toContain('ok Ana/Quito')
    expect(textsTo(provider, 'u1').at(-1)).toMatch(/^ok registrar\/Ana$/) // the duplicate trigger became the "name"
    await bot.stop()
  })

  it('offline-sync replay after a reconnect is not handled twice', async () => {
    const { bot, provider, chaos } = await createTestBot({}, { chaos: { disconnects: { replayOnReconnect: 3 } } })
    const handled: string[] = []
    bot.onMessage((ctx) => { handled.push(ctx.body) })
    provider.incoming('uno', { from: 'u1' })
    provider.incoming('dos', { from: 'u1' })
    await chaos.settle()
    chaos.disconnect()
    chaos.reconnect()
    await chaos.settle()
    expect(chaos.log.some((l) => l.type === 'replay')).toBe(true)
    expect(handled).toEqual(['uno', 'dos'])
    await bot.stop()
  })
})

describe('core under reordering + latency + duplicates (several chats at once)', () => {
  for (const seed of [1, 7, 42]) {
    it(`each chat completes its own flow with its own answers (seed ${seed})`, async () => {
      const { bot, provider, chaos } = await createTestBot({}, {
        chaos: { seed, duplicates: 0.5, reorder: { window: 3 }, latency: { min: 0, max: 4 } },
      })
      bot.use(registrar())
      const users = ['u1', 'u2', 'u3', 'u4']
      for (const u of users) provider.incoming('registrar', { from: u })
      await vi.waitFor(() => { for (const u of users) expect(textsTo(provider, u)).toContain('¿nombre?') })
      for (const u of users) provider.incoming(`name-${u}`, { from: u })
      await vi.waitFor(() => { for (const u of users) expect(textsTo(provider, u)).toContain('¿ciudad?') })
      for (const u of users) provider.incoming(`city-${u}`, { from: u })
      await vi.waitFor(() => { for (const u of users) expect(textsTo(provider, u)).toHaveLength(3) })
      await chaos.settle()
      for (const u of users) {
        expect(textsTo(provider, u)).toEqual(['¿nombre?', '¿ciudad?', `ok name-${u}/city-${u}`])
      }
      await bot.stop()
    })
  }

  it('group participants keep separate conversations under chaos (participant scope)', async () => {
    const { bot, provider, chaos } = await createTestBot({}, {
      chaos: { seed: 5, duplicates: 0.7, reorder: { window: 2, strategy: 'reverse' } },
    })
    bot.use(registrar())
    const g = { from: 'g1', isGroup: true }
    provider.incoming('registrar', { ...g, sender: 'p1' })
    provider.incoming('registrar', { ...g, sender: 'p2' })
    await vi.waitFor(() => expect(textsTo(provider, 'g1').filter((t) => t === '¿nombre?')).toHaveLength(2))
    provider.incoming('Ana', { ...g, sender: 'p1' })
    provider.incoming('Beto', { ...g, sender: 'p2' })
    await vi.waitFor(() => expect(textsTo(provider, 'g1').filter((t) => t === '¿ciudad?')).toHaveLength(2))
    provider.incoming('Lima', { ...g, sender: 'p1' })
    provider.incoming('Cali', { ...g, sender: 'p2' })
    await vi.waitFor(() => expect(textsTo(provider, 'g1').filter((t) => t.startsWith('ok '))).toHaveLength(2))
    await chaos.settle()
    expect(textsTo(provider, 'g1').filter((t) => t.startsWith('ok ')).sort()).toEqual(['ok Ana/Lima', 'ok Beto/Cali'])
    await bot.stop()
  })

  it('property: under heavy chaos every distinct message is handled exactly once', async () => {
    for (const seed of [3, 11, 99, 1234]) {
      const { bot, provider, chaos } = await createTestBot({}, {
        chaos: {
          seed,
          duplicates: { probability: 0.4, copies: 2, delayMs: { min: 0, max: 6 } },
          reorder: { window: 4 },
          latency: { min: 0, max: 5 },
          disconnects: { probability: 0.05, downtimeMs: 3, replayOnReconnect: 2 },
        },
      })
      const handled: string[] = []
      bot.onMessage((ctx) => { handled.push(ctx.ref.id) })
      const sent: string[] = []
      for (let i = 0; i < 40; i++) {
        const id = `s${seed}-m${i}`
        sent.push(id)
        provider.incoming(`msg ${i}`, { id, from: `u${i % 5}` })
        if (i % 7 === 0) await tick(1)
      }
      await vi.waitFor(() => expect(new Set(handled).size).toBe(sent.length), { timeout: 3000 })
      await chaos.settle()
      expect(handled).toHaveLength(sent.length) // no message ran twice
      expect([...handled].sort()).toEqual([...sent].sort())
      await bot.stop()
    }
  })
})

describe('core under transient send failures', () => {
  it('a typed send failure in a handler reaches bot "error" without an onError hook (regression)', async () => {
    const { bot, provider, chaos } = await createTestBot({}, { chaos: { sendFailures: { attempts: [1], retryAfterMs: 750 } } })
    const errors: Array<{ error: unknown; from?: string }> = []
    bot.on('error', ({ error, ctx }) => errors.push({ error, from: ctx?.from }))
    bot.when('hola', async (ctx) => { await ctx.reply('👋') })
    provider.incoming('hola', { from: 'u1' })
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0].error).toBeInstanceOf(RateLimitedError)
    expect((errors[0].error as RateLimitedError).retryAfterMs).toBe(750)
    expect(errors[0].from).toBe('u1')

    // The failed attempt is in the ledger, and the chat queue is not stuck.
    const ledger = await bot.getStore().getMessagesByChat('u1')
    expect(ledger.find((m) => m.direction === 'outbound')).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('Rate limited') } })
    provider.incoming('hola', { from: 'u1' })
    await vi.waitFor(() => expect(textsTo(provider, 'u1')).toEqual(['👋']))
    await chaos.settle()
    await bot.stop()
  })

  it('an onError("message") hook still sees the error and the bot error event fires once', async () => {
    const { bot, provider } = await createTestBot({}, { chaos: { sendFailures: { attempts: [1] } } })
    const hooked: unknown[] = []
    const emitted: unknown[] = []
    bot.onError('message', async (_ctx, err) => { hooked.push(err) })
    bot.on('error', ({ error }) => emitted.push(error))
    bot.when('hola', async (ctx) => { await ctx.reply('👋') })
    provider.incoming('hola', { from: 'u1' })
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect(hooked).toHaveLength(1)
    expect(hooked[0]).toBe(emitted[0])
    await bot.stop()
  })

  it('a failed send inside a flow ends the conversation cleanly (no zombie)', async () => {
    const { bot, provider, chaos } = await createTestBot({}, { chaos: { sendFailures: { attempts: [2] } } })
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    bot.use(registrar())
    bot.when('hola', async (ctx) => { await ctx.reply('👋') })
    provider.incoming('registrar', { from: 'u1' })
    await vi.waitFor(() => expect(textsTo(provider, 'u1')).toEqual(['¿nombre?']))
    provider.incoming('Ana', { from: 'u1' }) // the "¿ciudad?" send (attempt 2) fails
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toBeInstanceOf(RateLimitedError)
    await vi.waitFor(() => expect(textsTo(provider, 'u1').at(-1)).toMatch(/error/i))
    provider.incoming('hola', { from: 'u1' }) // not swallowed by a dead conversation
    await vi.waitFor(() => expect(textsTo(provider, 'u1').at(-1)).toBe('👋'))
    await chaos.settle()
    await bot.stop()
  })

  it('broadcast reports per-chat typed failures and keeps going', async () => {
    const { bot, chaos } = await createTestBot({}, { chaos: { sendFailures: { attempts: [2], errors: ['unreachable'] } } })
    const res = await bot.broadcast(['a', 'b', 'c'], { kind: 'text', text: 'promo' })
    expect(res.messages.map((s) => s.chatId)).toEqual(['a', 'c'])
    expect(res.sent).toBe(2)
    expect(res.failed).toBe(1)
    expect(res.errors[0]!.chatId).toBe('b')
    expect(res.errors[0]!.error).toBeInstanceOf(ProviderError)
    await chaos.settle()
    await bot.stop()
  })
})

describe('core under connection drops', () => {
  it('a drop mid-conversation neither aborts the flow nor loses the held answer', async () => {
    const { bot, provider, chaos } = await createTestBot({}, { chaos: {} })
    const states: string[] = []
    let readyCount = 0
    bot.on('connection', (u) => { states.push(u.state) })
    bot.on('ready', () => { readyCount++ })
    bot.use(registrar())
    provider.incoming('registrar', { from: 'u1' })
    await vi.waitFor(() => expect(textsTo(provider, 'u1')).toEqual(['¿nombre?']))

    chaos.disconnect({ reason: 'transient' })
    expect(bot.getConnectionState()).toBe('closed')
    await expect(bot.send('u1', { kind: 'text', text: 'proactive' })).rejects.toBeInstanceOf(ChaosDisconnectedError)
    provider.incoming('Ana', { from: 'u1' }) // held by the transport while down
    await tick(5)
    expect(textsTo(provider, 'u1')).toEqual(['¿nombre?'])

    chaos.reconnect()
    expect(bot.getConnectionState()).toBe('ready')
    await vi.waitFor(() => expect(textsTo(provider, 'u1')).toEqual(['¿nombre?', '¿ciudad?']))
    provider.incoming('Quito', { from: 'u1' })
    await vi.waitFor(() => expect(textsTo(provider, 'u1')).toEqual(['¿nombre?', '¿ciudad?', 'ok Ana/Quito']))
    expect(states).toEqual(['closed', 'connecting', 'ready'])
    expect(readyCount).toBe(1) // the reconnect (start()'s ready fired before listeners attached)
    const failed = (await bot.getStore().getMessagesByChat('u1')).filter((m) => m.status === 'failed')
    expect(failed).toHaveLength(1)
    await bot.stop()
  })

  it('stop() while chaos deliveries are pending: nothing runs afterwards, nothing leaks', async () => {
    const rejections: unknown[] = []
    const onRej = (e: unknown) => rejections.push(e)
    process.on('unhandledRejection', onRej)
    try {
      const { bot, provider } = await createTestBot({}, { chaos: { latency: 15, duplicates: 1 } })
      const handled: string[] = []
      bot.onMessage((ctx) => { handled.push(ctx.body) })
      provider.incoming('late', { from: 'u1' })
      await bot.stop()
      await tick(40)
      expect(handled).toEqual([])
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRej)
    }
  })
})

describe('core under alias identities (the LID/PN class of bug)', () => {
  it('a provider that leaks an alias splits the conversation — and the contract helper catches it', async () => {
    const { bot, provider, chaos } = await createTestBot({}, {
      chaos: { aliases: { map: { pn: ['lid'] }, strategy: 'cycle' } },
    })
    bot.use(registrar())
    provider.incoming('registrar', { from: 'pn' }) // wire: pn
    await vi.waitFor(() => expect(textsTo(provider, 'pn')).toEqual(['¿nombre?']))
    provider.incoming('Ana', { from: 'pn' }) // wire: lid — a different conversation key
    await chaos.settle()
    expect(textsTo(provider, 'pn')).toEqual(['¿nombre?']) // the flow never got its answer
    expect(() => assertStableIdentity(chaos.delivered, { ana: [0, 1] })).toThrow(IdentityContractError)
    await bot.stop()
  })

  it('a conforming resolver keeps one conversation per human', async () => {
    const canonical = (id: string) => (id === 'lid' ? 'pn' : id)
    const { bot, provider, chaos } = await createTestBot({}, {
      chaos: { aliases: { map: { pn: ['lid'] }, strategy: 'cycle', resolve: canonical } },
    })
    bot.use(registrar())
    provider.incoming('registrar', { from: 'pn' })
    await vi.waitFor(() => expect(textsTo(provider, 'pn')).toEqual(['¿nombre?']))
    provider.incoming('Ana', { from: 'pn' })
    await vi.waitFor(() => expect(textsTo(provider, 'pn')).toEqual(['¿nombre?', '¿ciudad?']))
    provider.incoming('Quito', { from: 'pn' })
    await vi.waitFor(() => expect(textsTo(provider, 'pn')).toEqual(['¿nombre?', '¿ciudad?', 'ok Ana/Quito']))
    expect(chaos.log.filter((l) => l.type === 'alias').length).toBeGreaterThan(0)
    expect(() => assertStableIdentity(chaos.delivered, { ana: [0, 1, 2] })).not.toThrow()
    expect(await bot.getStore().listContacts()).toHaveLength(1)
    await bot.stop()
  })
})
