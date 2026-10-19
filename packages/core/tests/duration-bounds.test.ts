import { describe, it, expect, vi } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { ConversationRuntime } from '../src/conversations/ConversationRuntime.js'
import { createControls } from '../src/conversations/controls.js'
import { MAX_TIMER_MS, parseTimerDuration } from '../src/utils/timers.js'

// Durations accept 'd'/'w' units, but a Node timer holds at most 2^31 - 1 ms (~24.8 days).
// A larger value fires after 1 ms, so every timer-backed option must reject it up front.

describe('parseTimerDuration', () => {
  it('accepts 0 and values up to MAX_TIMER_MS', () => {
    expect(parseTimerDuration(0, 'x')).toBe(0)
    expect(parseTimerDuration('24d', 'x')).toBe(24 * 86_400_000)
    expect(parseTimerDuration(MAX_TIMER_MS, 'x')).toBe(MAX_TIMER_MS)
  })

  it('rejects values a Node timer cannot hold', () => {
    expect(() => parseTimerDuration('30d', 'opt')).toThrow(RangeError)
    expect(() => parseTimerDuration('1w', 'opt')).not.toThrow()
    expect(() => parseTimerDuration('4w', 'opt')).toThrow(/opt supports at most/)
    expect(() => parseTimerDuration(-1, 'opt')).toThrow(RangeError)
    expect(() => parseTimerDuration(Number.NaN, 'opt')).toThrow(RangeError)
  })

  it('keeps the parser error for unparsable input', () => {
    expect(() => parseTimerDuration('soon', 'opt')).toThrow(/Invalid duration/)
  })
})

describe('timer-backed duration options reject overflowing values', () => {
  it('flow().timeout()', () => {
    expect(() => flow('yo').timeout('30d')).toThrow(RangeError)
    expect(() => flow('yo').timeout('2h')).not.toThrow()
  })

  it('conversation.timeout in the bot config', async () => {
    await expect(createTestBot({ conversation: { timeout: '30d' } })).rejects.toThrow(RangeError)
  })

  it('c.ask({ timeout })', async () => {
    const rt = new ConversationRuntime({ controlsFactory: (r, h, c) => createControls(r, h, c) })
    const start = { from: 'a', sender: 'a', body: 'start', type: 'text', isGroup: false, reply: vi.fn(async () => {}) }
    let caught: unknown
    await rt.enter(async (c: any) => {
      try { await c.ask('name?', { timeout: '30d' }) } catch (err) { caught = err }
    }, start as any)
    expect(caught).toBeInstanceOf(RangeError)
  })

  it('MemoryStore autoSaveInterval', () => {
    expect(() => new MemoryStore({ autoSaveInterval: '30d' })).toThrow(RangeError)
    expect(() => new MemoryStore({ autoSaveInterval: '1d' })).not.toThrow()
  })

  it('bot.stop({ timeout }) rejects before tearing the bot down', async () => {
    const { bot, provider } = await createTestBot()
    await expect(bot.stop({ drain: true, timeout: '30d' })).rejects.toThrow(RangeError)
    await bot.send('u1', 'still running')
    expect(provider.outbox).toHaveLength(1)
    await bot.stop()
  })
})
