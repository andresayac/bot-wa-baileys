import { describe, it, expect, vi } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { RateLimitedError, RecipientUnreachableError } from '../src/core/provider.js'
import type { ChatId, OutboundContent, SendOptions, SendResult } from '../src/core/types.js'
import { runBroadcast } from '../src/index.js'

type SendImpl = (chatId: ChatId, content: OutboundContent, options?: SendOptions) => Promise<SendResult>

async function setup(sendImpl?: (base: SendImpl) => SendImpl) {
  const provider = new MockProvider()
  if (sendImpl) {
    const base = provider.send.bind(provider) as SendImpl
    provider.send = sendImpl(base) as typeof provider.send
  }
  const bot = new Bot({ provider })
  await bot.start()
  return { bot, provider }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i + 1}`)

describe('bot.broadcast', () => {
  it('sends to every chat and returns counts', async () => {
    const { bot, provider } = await setup()
    const res = await bot.broadcast(ids(5), { kind: 'text', text: 'promo' })
    expect(res).toMatchObject({ total: 5, sent: 5, failed: 0, skipped: 0, errors: [], cancelled: false, pending: [] })
    expect(res.messages).toHaveLength(5)
    expect(provider.outbox.map((m) => m.chatId)).toEqual(ids(5))
    await bot.stop()
  })

  it('accepts a string as text content and dedupes chat ids', async () => {
    const { bot, provider } = await setup()
    const res = await bot.broadcast(['a', 'b', 'a'], 'hola')
    expect(res.total).toBe(2)
    expect(provider.outbox.map((m) => [m.chatId, m.content])).toEqual([
      ['a', { kind: 'text', text: 'hola' }],
      ['b', { kind: 'text', text: 'hola' }],
    ])
    await bot.stop()
  })

  it('reports failures through onFail and the errors list and keeps going', async () => {
    const { bot } = await setup((base) => async (chatId, content, options) => {
      if (chatId === 'c2') throw new RecipientUnreachableError(chatId)
      return base(chatId, content, options)
    })
    const onFail = vi.fn()
    const progress: Array<[number, number, boolean]> = []
    const res = await bot.broadcast(ids(3), 'x', {
      onFail,
      onProgress: (done, total, last) => progress.push([done, total, last.ok]),
    })
    expect(res.sent).toBe(2)
    expect(res.failed).toBe(1)
    expect(res.errors[0]!.chatId).toBe('c2')
    expect(res.errors[0]!.error).toBeInstanceOf(RecipientUnreachableError)
    expect(onFail).toHaveBeenCalledWith('c2', expect.any(RecipientUnreachableError))
    expect(progress).toEqual([[1, 3, true], [2, 3, false], [3, 3, true]])
    await bot.stop()
  })

  it('waits retryAfterMs on RateLimitedError and retries the same chat', async () => {
    const calls: Array<[string, number]> = []
    let limited = false
    const { bot, provider } = await setup((base) => async (chatId, content, options) => {
      calls.push([chatId, Date.now()])
      if (chatId === 'c2' && !limited) { limited = true; throw new RateLimitedError(60) }
      return base(chatId, content, options)
    })
    const res = await bot.broadcast(ids(3), 'x')
    expect(res.sent).toBe(3)
    expect(res.failed).toBe(0)
    expect(calls.map(([c]) => c)).toEqual(['c1', 'c2', 'c2', 'c3'])
    expect(calls[2]![1] - calls[1]![1]).toBeGreaterThanOrEqual(50)
    expect(provider.outbox).toHaveLength(3)
    await bot.stop()
  })

  it('a rate limit pauses every concurrent worker', async () => {
    const starts: Array<[string, number]> = []
    let limited = false
    const { bot } = await setup((base) => async (chatId, content, options) => {
      starts.push([chatId, Date.now()])
      if (chatId === 'c1' && !limited) { limited = true; throw new RateLimitedError(80) }
      await new Promise((r) => setTimeout(r, 5))
      return base(chatId, content, options)
    })
    const t0 = Date.now()
    const res = await bot.broadcast(ids(4), 'x', { concurrency: 2, batchSize: 4 })
    expect(res.sent).toBe(4)
    // c2 was already in flight; everything that starts after the limit waits for it.
    const late = starts.filter(([c]) => c === 'c3' || c === 'c4')
    for (const [, at] of late) expect(at - t0).toBeGreaterThanOrEqual(70)
    await bot.stop()
  })

  it('gives up after maxRetries rate limits', async () => {
    const { bot } = await setup(() => async () => { throw new RateLimitedError(1) })
    const res = await bot.broadcast(['a'], 'x', { maxRetries: 2 })
    expect(res.failed).toBe(1)
    expect(res.errors[0]!.error).toBeInstanceOf(RateLimitedError)
    await bot.stop()
  })

  it('pauses delayBetween between batches', async () => {
    const at: number[] = []
    const { bot } = await setup((base) => async (chatId, content, options) => {
      at.push(Date.now())
      return base(chatId, content, options)
    })
    await bot.broadcast(ids(4), 'x', { batchSize: 2, delayBetween: 200 })
    expect(at[1]! - at[0]!).toBeLessThan(150)
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(190)
    expect(at[3]! - at[2]!).toBeLessThan(150)
    await bot.stop()
  })

  it('respects concurrency', async () => {
    let inflight = 0
    let peak = 0
    const { bot } = await setup((base) => async (chatId, content, options) => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 10))
      inflight--
      return base(chatId, content, options)
    })
    await bot.broadcast(ids(9), 'x', { concurrency: 3, batchSize: 9 })
    expect(peak).toBe(3)
    await bot.stop()
  })

  it('is cancellable with an AbortSignal', async () => {
    const ac = new AbortController()
    const { bot, provider } = await setup()
    const res = await bot.broadcast(ids(6), 'x', {
      batchSize: 2,
      delayBetween: '1m',
      signal: ac.signal,
      onProgress: (done) => { if (done === 2) setTimeout(() => ac.abort(), 5) },
    })
    expect(res.cancelled).toBe(true)
    expect(res.sent).toBe(2)
    expect(res.pending).toEqual(['c3', 'c4', 'c5', 'c6'])
    expect(provider.outbox).toHaveLength(2)
    await bot.stop()
  })

  it('an already-aborted signal sends nothing', async () => {
    const { bot, provider } = await setup()
    const res = await bot.broadcast(ids(3), 'x', { signal: AbortSignal.abort() })
    expect(res).toMatchObject({ sent: 0, cancelled: true, pending: ids(3) })
    expect(provider.outbox).toHaveLength(0)
    await bot.stop()
  })

  it('counts sends a before(send) hook skipped as skipped', async () => {
    const { bot } = await setup()
    bot.before('send', (p: { chatId: string; abort(): void }) => { if (p.chatId === 'c1') p.abort() })
    const res = await bot.broadcast(ids(2), 'x')
    expect(res).toMatchObject({ sent: 1, skipped: 1, failed: 0 })
    await bot.stop()
  })

  it('does not block the per-chat inbound queues', async () => {
    const { bot, provider } = await setup()
    bot.when('hola', async (ctx) => { await ctx.reply('👋') })
    const ac = new AbortController()
    const done = bot.broadcast(ids(4), 'promo', { batchSize: 1, delayBetween: '1m', signal: ac.signal })
    await new Promise((r) => setTimeout(r, 20))
    provider.incoming('hola', { from: 'c3' })
    await vi.waitFor(() => expect(provider.outbox.some((m) => m.chatId === 'c3' && m.content.kind === 'text' && m.content.text === '👋')).toBe(true), { timeout: 1000 })
    expect(provider.outbox.filter((m) => m.content.kind === 'text' && m.content.text === 'promo')).toHaveLength(1)
    ac.abort()
    expect((await done).pending).toEqual(['c2', 'c3', 'c4'])
    await bot.stop()
  })

  it('reports callback errors on the error channel without stopping', async () => {
    const { bot } = await setup()
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    const res = await bot.broadcast(ids(2), 'x', { onProgress: () => { throw new Error('boom') } })
    expect(res.sent).toBe(2)
    expect(errors).toHaveLength(2)
    await bot.stop()
  })

  it('rejects invalid options', async () => {
    await expect(runBroadcast({ send: async () => { throw new Error('x') } }, ['a'], { kind: 'text', text: 'x' }, { batchSize: 0 }))
      .rejects.toBeInstanceOf(RangeError)
    await expect(runBroadcast({ send: async () => { throw new Error('x') } }, ['a'], { kind: 'text', text: 'x' }, { concurrency: 1.5 }))
      .rejects.toBeInstanceOf(RangeError)
  })
})
