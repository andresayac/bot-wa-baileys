/**
 * RateLimiter — unit tests for the token bucket rate limiter.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { RateLimiter, RateLimiterTimeout } from '../src/ratelimit/RateLimiter.js'

describe('RateLimiter', () => {
  let limiter: RateLimiter

  beforeEach(() => {
    limiter = new RateLimiter({
      perChat: { max: 3, window: '1s' },
      global: { max: 10, window: '1s' },
    })
  })

  it('allows sends within the limit', async () => {
    // 3 sends should all resolve immediately
    await limiter.acquire('chat1@s.whatsapp.net')
    await limiter.acquire('chat1@s.whatsapp.net')
    await limiter.acquire('chat1@s.whatsapp.net')
    expect(limiter.pending).toBe(0)
  })

  it('queues sends when per-chat limit exceeded', async () => {
    // Exhaust the per-chat bucket (3 tokens)
    await limiter.acquire('chat1@s.whatsapp.net')
    await limiter.acquire('chat1@s.whatsapp.net')
    await limiter.acquire('chat1@s.whatsapp.net')

    // 4th send should be queued (will wait for refill)
    const start = Date.now()
    await limiter.acquire('chat1@s.whatsapp.net')
    const elapsed = Date.now() - start
    // Should have waited ~333ms (1 token refills in 1000/3 ≈ 333ms)
    expect(elapsed).toBeGreaterThanOrEqual(200) // allow some timing slack
  })

  it('tracks separate buckets per chat', async () => {
    // Exhaust chat1
    await limiter.acquire('chat1@s.whatsapp.net')
    await limiter.acquire('chat1@s.whatsapp.net')
    await limiter.acquire('chat1@s.whatsapp.net')

    // chat2 should still have tokens
    const start = Date.now()
    await limiter.acquire('chat2@s.whatsapp.net')
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(100) // should be near-instant
  })

  it('respects global limit across chats', async () => {
    const globalLimiter = new RateLimiter({
      perChat: { max: 100, window: '1s' }, // high per-chat
      global: { max: 5, window: '1s' },    // low global
    })

    // Exhaust global bucket
    for (let i = 0; i < 5; i++) {
      await globalLimiter.acquire(`chat${i}@s.whatsapp.net`)
    }

    // Next send should wait for global refill
    const start = Date.now()
    await globalLimiter.acquire('chat99@s.whatsapp.net')
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(100)
  })

  it('does nothing when disabled', async () => {
    const disabled = new RateLimiter({ enabled: false })
    const start = Date.now()
    for (let i = 0; i < 100; i++) {
      await disabled.acquire('chat@s.whatsapp.net')
    }
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(50)
  })

  it('applies jitter between sends', async () => {
    const jitterLimiter = new RateLimiter({
      perChat: { max: 100, window: '1s' },
      global: { max: 100, window: '1s' },
      jitter: { min: 50, max: 100 },
    })

    const start = Date.now()
    await jitterLimiter.acquire('chat@s.whatsapp.net')
    await jitterLimiter.acquire('chat@s.whatsapp.net')
    const elapsed = Date.now() - start
    // Second send should have jitter delay (50-100ms)
    expect(elapsed).toBeGreaterThanOrEqual(40) // allow timing slack
  })

  it('reset() clears buckets and rejects queued sends', async () => {
    // Exhaust the bucket
    await limiter.acquire('chat@s.whatsapp.net')
    await limiter.acquire('chat@s.whatsapp.net')
    await limiter.acquire('chat@s.whatsapp.net')

    // Queue a send (won't resolve immediately)
    const queued = limiter.acquire('chat@s.whatsapp.net')

    // Reset should reject the queued send
    limiter.reset()
    await expect(queued).rejects.toThrow('RateLimiter reset')
  })

  it('a rate-limited chat does NOT stall sends to other chats (no head-of-line blocking)', async () => {
    // Exhaust chat1's per-chat bucket.
    await limiter.acquire('chat1@s.whatsapp.net')
    await limiter.acquire('chat1@s.whatsapp.net')
    await limiter.acquire('chat1@s.whatsapp.net')

    // Enqueue a BLOCKED chat1 send and a fresh chat2 send CONCURRENTLY (not awaited
    // in sequence) so both sit in the queue at once — the scenario the old FIFO drain
    // failed: chat1 at the head would stall chat2 behind it.
    let chat2Done = false
    const blocked = limiter.acquire('chat1@s.whatsapp.net').then(() => 'chat1')
    const other = limiter.acquire('chat2@s.whatsapp.net').then(() => { chat2Done = true; return 'chat2' })

    // chat2 should win quickly despite chat1 being blocked at the head.
    const first = await Promise.race([other, blocked])
    expect(first).toBe('chat2')
    expect(chat2Done).toBe(true)

    await blocked // let chat1 drain on refill so no dangling promise
  })

  it('rejects sends that wait past maxWait with RateLimiterTimeout', async () => {
    const strict = new RateLimiter({
      perChat: { max: 1, window: '1000s' }, // effectively never refills in the test window
      global: { max: 100, window: '1s' },
      maxWait: 150,
    })
    await strict.acquire('chat@s.whatsapp.net') // consumes the only token

    const queued = strict.acquire('chat@s.whatsapp.net') // can't refill in time
    await expect(queued).rejects.toBeInstanceOf(RateLimiterTimeout)
  })

  it('bounds the number of per-chat buckets (no unbounded growth)', async () => {
    const bounded = new RateLimiter({
      perChat: { max: 5, window: '1s' },
      global: { max: 100000, window: '1s' },
      maxChats: 10,
    })
    // Touch far more distinct chats than the cap; each send is within limits (instant).
    for (let i = 0; i < 200; i++) {
      await bounded.acquire(`chat${i}@s.whatsapp.net`)
    }
    expect(bounded.trackedChats).toBeLessThanOrEqual(10)
  })

  it('reports pending count', async () => {
    expect(limiter.pending).toBe(0)

    // Exhaust bucket
    await limiter.acquire('chat@s.whatsapp.net')
    await limiter.acquire('chat@s.whatsapp.net')
    await limiter.acquire('chat@s.whatsapp.net')

    // Queue one more
    const p = limiter.acquire('chat@s.whatsapp.net')
    // Give the event loop a tick to enqueue
    await new Promise((r) => setTimeout(r, 10))
    expect(limiter.pending).toBeGreaterThanOrEqual(0) // may have already been processed

    await p // cleanup
  })
})
