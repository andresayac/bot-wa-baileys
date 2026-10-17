import { describe, it, expect, vi, afterEach } from 'vitest'
import { MockProvider } from '../src/testing/MockProvider.js'
import {
  ChaosProvider,
  ChaosDisconnectedError,
  withChaos,
  createSeededRandom,
  type ChaosOptions,
} from '../src/testing/chaos.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import {
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  PayloadTooLargeError,
  OutsideSessionWindowError,
  UnsupportedContentError,
  type InboundEvent,
  type ConnectionUpdate,
} from '../src/core/provider.js'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** Wrap a fresh MockProvider and record what reaches the outer listener. */
function harness(options: ChaosOptions) {
  const mock = new MockProvider()
  const chaos = withChaos(mock, options)
  const got: InboundEvent[] = []
  chaos.onEvent((e) => { got.push(e) })
  const bodies = () => got.flatMap((e) => (e.kind === 'message' ? [e.message.body] : []))
  const states = () => got.flatMap((e) => (e.kind === 'connection' ? [e.update.state] : []))
  return { mock, chaos, got, bodies, states }
}

afterEach(() => { vi.useRealTimers() })

describe('createSeededRandom', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = createSeededRandom(42)
    const b = createSeededRandom(42)
    const c = createSeededRandom(43)
    const xs = Array.from({ length: 50 }, () => a())
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs)
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
  })
})

describe('ChaosProvider — pass-through', () => {
  it('without options it behaves like the wrapped provider', async () => {
    const { mock, chaos, bodies, states } = harness({})
    await chaos.start()
    mock.incoming('a')
    mock.incoming('b')
    expect(states()).toEqual(['ready'])
    expect(bodies()).toEqual(['a', 'b']) // synchronous, in order
    const res = await chaos.send('u1', { kind: 'text', text: 'hi' })
    expect(res.ref.chatId).toBe('u1')
    expect(mock.outbox).toHaveLength(1)
    expect(chaos.id).toBe(mock.id)
    expect(chaos.capabilities).toBe(mock.capabilities)
  })

  it('delegates optional capabilities only when the inner provider has them', () => {
    const chaos = withChaos(new MockProvider(), {})
    expect(typeof chaos.downloadMedia).toBe('function')
    expect(chaos.typing).toBeUndefined()
    expect(chaos.markRead).toBeUndefined()
  })

  it('leaves non-targeted event kinds alone', () => {
    const { mock, chaos, got } = harness({ duplicates: 1, latency: 50 })
    void chaos
    const status: InboundEvent = { kind: 'status', status: { ref: { id: 'x', chatId: 'c' }, status: 'read', timestamp: 1 } }
    ;(mock as unknown as { emitEvent(e: InboundEvent): void }).emitEvent(status)
    expect(got).toEqual([status])
  })

  it('rejects invalid options', () => {
    const m = new MockProvider()
    expect(() => withChaos(m, { duplicates: 1.5 })).toThrow(RangeError)
    expect(() => withChaos(m, { reorder: 1 })).toThrow(RangeError)
    expect(() => withChaos(m, { latency: { min: 10, max: 5 } })).toThrow(RangeError)
    expect(() => withChaos(m, { sendFailures: { attempts: [0] } })).toThrow(RangeError)
    expect(() => withChaos(m, { seed: Number.NaN })).toThrow(RangeError)
  })
})

describe('ChaosProvider — inbound chaos', () => {
  it('duplicates: redelivers each event as independent copies of the same message', async () => {
    const { mock, chaos, got } = harness({ duplicates: { probability: 1, copies: 2 } })
    mock.incoming('a', { id: 'm1' })
    await chaos.settle()
    expect(got).toHaveLength(3)
    const msgs = got.map((e) => (e.kind === 'message' ? e.message : undefined))
    expect(new Set(msgs.map((m) => m?.ref.id))).toEqual(new Set(['m1']))
    expect(msgs[0]).not.toBe(msgs[1]) // fresh objects, like a re-parsed webhook body
    expect(chaos.log.filter((l) => l.type === 'duplicate')).toHaveLength(1)
  })

  it('duplicates: a probability draws a deterministic subset per seed', async () => {
    const run = async (seed: number) => {
      const { mock, chaos, got } = harness({ seed, duplicates: 0.5 })
      for (let i = 0; i < 20; i++) mock.incoming(`m${i}`, { id: `m${i}` })
      await chaos.settle()
      return got.map((e) => (e.kind === 'message' ? e.message.ref.id : e.kind))
    }
    const a = await run(7)
    expect(await run(7)).toEqual(a)
    expect(a.length).toBeGreaterThan(20)
    expect(a.length).toBeLessThan(40)
  })

  it('reorder: reverse strategy permutes a full window', async () => {
    const { mock, chaos, bodies } = harness({ reorder: { window: 3, strategy: 'reverse' } })
    mock.incoming('1'); mock.incoming('2'); mock.incoming('3')
    mock.incoming('4')
    expect(bodies()).toEqual(['3', '2', '1']) // full window flushed synchronously
    await chaos.settle() // partial window flushes after maxHoldMs
    expect(bodies()).toEqual(['3', '2', '1', '4'])
    expect(chaos.log.some((l) => l.type === 'reorder')).toBe(true)
  })

  it('reorder: seeded shuffle is a deterministic permutation', async () => {
    const run = async () => {
      const { mock, chaos, bodies } = harness({ seed: 3, reorder: 5 })
      for (let i = 0; i < 10; i++) mock.incoming(String(i))
      await chaos.settle()
      return bodies()
    }
    const a = await run()
    expect(await run()).toEqual(a)
    expect([...a].sort((x, y) => Number(x) - Number(y))).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
    expect(a).not.toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
  })

  it('latency: holds an event for the drawn delay', async () => {
    vi.useFakeTimers()
    const { mock, bodies } = harness({ latency: 100 })
    mock.incoming('late')
    await vi.advanceTimersByTimeAsync(99)
    expect(bodies()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(bodies()).toEqual(['late'])
  })

  it('latency ranges are drawn deterministically per seed (and reorder events naturally)', async () => {
    vi.useFakeTimers()
    const run = async () => {
      const { mock, chaos, bodies } = harness({ seed: 11, latency: { min: 0, max: 20 } })
      for (let i = 0; i < 8; i++) mock.incoming(String(i))
      await vi.advanceTimersByTimeAsync(25)
      return { order: bodies(), delays: chaos.log.flatMap((l) => (l.type === 'latency' ? [l.ms] : [])) }
    }
    const a = await run()
    expect(a.order).toHaveLength(8)
    expect(a.order).not.toEqual(['0', '1', '2', '3', '4', '5', '6', '7'])
    expect(await run()).toEqual(a)
  })

  it('aliases: flips the wire identity of a mapped human (DM chat follows the sender)', () => {
    const { mock, got } = harness({ aliases: { map: { pn: ['lid'] }, probability: 1 } })
    mock.incoming('hola', { from: 'pn' })
    mock.incoming('hola', { from: 'other' })
    mock.incoming('hola', { from: 'g1', sender: 'pn', isGroup: true })
    const m = got.map((e) => (e.kind === 'message' ? e.message : undefined))
    expect(m[0]).toMatchObject({ senderId: 'lid', sender: 'lid', chatId: 'lid', from: 'lid', ref: { chatId: 'lid' } })
    expect(m[0]?.senderInfo.id).toBe('lid')
    expect(m[0]?.chat.id).toBe('lid')
    expect(m[1]?.senderId).toBe('other')
    expect(m[2]).toMatchObject({ senderId: 'lid', chatId: 'g1' }) // groups keep their chat id
  })

  it('aliases: a resolver under test canonicalizes the flipped identity back', () => {
    const { mock, got, chaos } = harness({
      aliases: { map: { pn: ['lid'] }, probability: 1, resolve: (id) => (id === 'lid' ? 'pn' : id) },
    })
    mock.incoming('hola', { from: 'pn' })
    const e = got[0]
    expect(e.kind === 'message' && e.message.senderId).toBe('pn')
    expect(chaos.log.some((l) => l.type === 'alias')).toBe(true)
  })
})

describe('ChaosProvider — outbound chaos', () => {
  it('fails scripted attempts with typed ProviderErrors and lets the rest through', async () => {
    const { mock, chaos } = harness({ sendFailures: { attempts: [1, 3], retryAfterMs: 250 } })
    const first = chaos.send('u1', { kind: 'text', text: '1' })
    await expect(first).rejects.toBeInstanceOf(RateLimitedError)
    await expect(first).rejects.toMatchObject({ retryAfterMs: 250 })
    await expect(chaos.send('u1', { kind: 'text', text: '2' })).resolves.toBeTruthy()
    await expect(chaos.send('u1', { kind: 'text', text: '3' })).rejects.toBeInstanceOf(ProviderError)
    expect(mock.outbox.map((o) => (o.content.kind === 'text' ? o.content.text : ''))).toEqual(['2'])
    expect(chaos.sendAttempts).toBe(3)
    expect(chaos.log.filter((l) => l.type === 'send-failure')).toHaveLength(2)
  })

  it('cycles through every typed error kind and custom factories', async () => {
    const { chaos } = harness({
      sendFailures: {
        probability: 1,
        errors: ['rate-limited', 'unreachable', 'payload-too-large', 'outside-window', 'unsupported', 'disconnected', () => new ProviderError('custom')],
      },
    })
    const errs: unknown[] = []
    for (let i = 0; i < 7; i++) {
      try { await chaos.send('u1', { kind: 'image', media: 'x' }) } catch (e) { errs.push(e) }
    }
    expect(errs[0]).toBeInstanceOf(RateLimitedError)
    expect(errs[1]).toBeInstanceOf(RecipientUnreachableError)
    expect((errs[1] as RecipientUnreachableError).chatId).toBe('u1')
    expect(errs[2]).toBeInstanceOf(PayloadTooLargeError)
    expect(errs[3]).toBeInstanceOf(OutsideSessionWindowError)
    expect(errs[4]).toBeInstanceOf(UnsupportedContentError)
    expect((errs[4] as UnsupportedContentError).kind).toBe('image')
    expect(errs[5]).toBeInstanceOf(ChaosDisconnectedError)
    expect((errs[6] as Error).message).toBe('custom')
    expect(errs.every((e) => e instanceof ProviderError)).toBe(true)
  })

  it('maxConsecutive bounds a failure streak (transient, not permanent)', async () => {
    const { chaos } = harness({ sendFailures: { probability: 1, maxConsecutive: 2 } })
    const results: string[] = []
    for (let i = 0; i < 6; i++) {
      results.push(await chaos.send('u', { kind: 'text', text: 't' }).then(() => 'ok', () => 'fail'))
    }
    expect(results).toEqual(['fail', 'fail', 'ok', 'fail', 'fail', 'ok'])
  })

  it('sendLatency delays the inner send', async () => {
    vi.useFakeTimers()
    const { mock, chaos } = harness({ sendLatency: 40 })
    const p = chaos.send('u', { kind: 'text', text: 't' })
    await vi.advanceTimersByTimeAsync(39)
    expect(mock.outbox).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(mock.outbox).toHaveLength(1)
  })
})

describe('ChaosProvider — connection drops', () => {
  it('disconnect()/reconnect() emit closed → connecting → ready, hold inbound and fail sends meanwhile', async () => {
    const { mock, chaos, bodies, states, got } = harness({})
    await chaos.start()
    mock.incoming('before')
    chaos.disconnect({ reason: 'transient' })
    expect(chaos.connected).toBe(false)
    mock.incoming('during-1')
    mock.incoming('during-2')
    await expect(chaos.send('u', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(ChaosDisconnectedError)
    expect(bodies()).toEqual(['before'])
    chaos.reconnect()
    expect(chaos.connected).toBe(true)
    expect(states()).toEqual(['ready', 'closed', 'connecting', 'ready'])
    expect(bodies()).toEqual(['before', 'during-1', 'during-2'])
    const closed = got.find((e) => e.kind === 'connection' && e.update.state === 'closed')
    expect((closed as { update: ConnectionUpdate }).update.reason).toBe('transient')
    await expect(chaos.send('u', { kind: 'text', text: 'y' })).resolves.toBeTruthy()
  })

  it('afterInbound drops right after the Nth delivery and auto-reconnects after downtimeMs', async () => {
    vi.useFakeTimers()
    const { mock, states, bodies } = harness({ disconnects: { afterInbound: [2], downtimeMs: 30 } })
    mock.incoming('1')
    mock.incoming('2')
    mock.incoming('3') // arrives while down → held
    expect(states()).toEqual(['closed'])
    expect(bodies()).toEqual(['1', '2'])
    await vi.advanceTimersByTimeAsync(30)
    expect(states()).toEqual(['closed', 'connecting', 'ready'])
    expect(bodies()).toEqual(['1', '2', '3'])
  })

  it('replayOnReconnect redelivers the last N events (offline-sync duplicates)', async () => {
    const { mock, chaos, got } = harness({ disconnects: { replayOnReconnect: 2 } })
    mock.incoming('a', { id: 'a' })
    mock.incoming('b', { id: 'b' })
    mock.incoming('c', { id: 'c' })
    chaos.disconnect()
    chaos.reconnect()
    const ids = got.flatMap((e) => (e.kind === 'message' ? [e.message.ref.id] : []))
    expect(ids).toEqual(['a', 'b', 'c', 'b', 'c'])
    expect(chaos.log.some((l) => l.type === 'replay')).toBe(true)
  })

  it('reason rateLimited carries retryAfterMs', () => {
    const { chaos, got } = harness({})
    chaos.disconnect({ reason: 'rateLimited', retryAfterMs: 500 })
    expect(got[0]).toEqual({ kind: 'connection', update: { state: 'closed', reason: 'rateLimited', retryAfterMs: 500 } })
  })
})

describe('ChaosProvider — lifecycle helpers', () => {
  it('replay() redelivers the last delivered inbound events on demand', () => {
    const { mock, chaos, got } = harness({})
    mock.incoming('a', { id: 'a' })
    chaos.replay()
    expect(got.map((e) => (e.kind === 'message' ? e.message.ref.id : ''))).toEqual(['a', 'a'])
    expect(chaos.delivered).toHaveLength(2)
    chaos.replay(0)
    expect(chaos.delivered).toHaveLength(2)
  })

  it('stop() cancels pending deliveries', async () => {
    const { mock, chaos, bodies } = harness({ latency: 10 })
    mock.incoming('never')
    await chaos.stop()
    await tick(30)
    expect(bodies()).toEqual([])
  })

  it('is deterministic end to end for a given seed', async () => {
    const run = async () => {
      const { mock, chaos, got } = harness({
        seed: 2024, duplicates: 0.3, reorder: 3, latency: { min: 0, max: 5 },
        aliases: { map: { u1: ['u1-alias'] }, probability: 0.5 },
      })
      for (let i = 0; i < 12; i++) mock.incoming(`m${i}`, { id: `m${i}`, from: i % 2 ? 'u1' : 'u2' })
      await chaos.settle()
      return got.map((e) => (e.kind === 'message' ? `${e.message.ref.id}@${e.message.senderId}` : e.kind))
    }
    expect(await run()).toEqual(await run())
  })
})

describe('createTestBot({ chaos })', () => {
  it('wires the bot through a ChaosProvider wrapping the MockProvider', async () => {
    const { bot, provider, chaos, chat } = await createTestBot({}, { chaos: { seed: 1 } })
    expect(chaos).toBeInstanceOf(ChaosProvider)
    expect(chaos.inner).toBe(provider)
    expect(bot.getProvider()).toBe(chaos)
    bot.when('hola', async (ctx) => { await ctx.reply('👋') })
    await chat.send('hola')
    await chat.expectReply('👋')
    await bot.stop()
  })

  it('without chaos it stays a plain MockProvider', async () => {
    const { bot, provider, chaos } = await createTestBot()
    expect(chaos).toBeUndefined()
    expect(bot.getProvider()).toBe(provider)
    await bot.stop()
  })
})
