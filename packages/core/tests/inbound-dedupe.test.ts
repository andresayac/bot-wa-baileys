import { describe, it, expect, vi } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { InboundDeduper, inboundDedupeKey, DEFAULT_DEDUPE_SIZE } from '../src/core/dedupe.js'
import { ConfigValidationError } from '../src/utils/validateConfig.js'
import type { InboundEvent, InboundMessage, InboundInteraction } from '../src/core/provider.js'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function message(over: Partial<InboundMessage> = {}): InboundMessage {
  const chatId = over.chatId ?? 'chat-1'
  const senderId = over.senderId ?? chatId
  return {
    ref: { id: 'm-1', chatId },
    chat: { id: chatId, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: senderId, displayName: 'Ana' },
    from: chatId, sender: senderId, chatId, senderId,
    isGroup: false, isBroadcast: false, fromMe: false,
    type: 'text', body: 'hola', timestamp: 1_700_000_000,
    mentions: [], raw: {},
    ...over,
  }
}

function interaction(over: Partial<InboundInteraction> = {}): InboundInteraction {
  const chatId = over.chatId ?? 'chat-1'
  return {
    interactionId: 'cb-1',
    ref: { id: 'menu-msg', chatId },
    chat: { id: chatId, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: chatId },
    from: chatId, sender: chatId, chatId, senderId: chatId,
    isGroup: false, kind: 'button', data: 'yes', timestamp: 1_700_000_000, raw: {},
    ...over,
  }
}

/** Emit a normalized event exactly like a webhook transport would (fresh object per delivery). */
function emit(provider: MockProvider, event: InboundEvent): void {
  ;(provider as unknown as { emitEvent(e: InboundEvent): void }).emitEvent(structuredClone(event))
}

async function botWith(config: Partial<ConstructorParameters<typeof Bot>[0]> = {}) {
  const provider = new MockProvider()
  const bot = new Bot({ provider, ...config })
  const seen: string[] = []
  bot.onMessage((ctx) => { seen.push(`${ctx.from}|${ctx.ref.id}|${ctx.body}`) })
  await bot.start()
  return { bot, provider, seen }
}

describe('InboundDeduper (unit)', () => {
  it('reports the first sighting as new and a repeat as duplicate', () => {
    const d = new InboundDeduper()
    expect(d.isDuplicate('k')).toBe(false)
    expect(d.isDuplicate('k')).toBe(true)
    expect(d.isDuplicate('other')).toBe(false)
    expect(d.size).toBe(DEFAULT_DEDUPE_SIZE)
  })

  it('is bounded: evicts the least-recently-seen key once `size` is exceeded', () => {
    const d = new InboundDeduper({ size: 2 })
    d.isDuplicate('a')
    d.isDuplicate('b')
    expect(d.isDuplicate('a')).toBe(true) // touches a → b is now the oldest
    d.isDuplicate('c') // evicts b
    expect(d.remembered).toBe(2)
    expect(d.isDuplicate('a')).toBe(true)
    expect(d.isDuplicate('b')).toBe(false) // forgotten → treated as new
  })

  it('forgets keys after `ttl` (measured from first acceptance)', () => {
    let now = 0
    const d = new InboundDeduper({ ttl: '1s', now: () => now })
    expect(d.isDuplicate('k')).toBe(false)
    now = 999
    expect(d.isDuplicate('k')).toBe(true)
    now = 1000
    expect(d.isDuplicate('k')).toBe(false)
    now = 1500
    expect(d.isDuplicate('k')).toBe(true)
  })

  it('treats the same key with a different fingerprint as new (an edit, not a retry)', () => {
    const d = new InboundDeduper()
    expect(d.isDuplicate('k', 'A')).toBe(false)
    expect(d.isDuplicate('k', 'A')).toBe(true)
    expect(d.isDuplicate('k', 'B')).toBe(false)
    expect(d.isDuplicate('k', 'A')).toBe(false) // A → B → A: each edit is processed
  })

  it('the default clock follows fake timers installed after construction', () => {
    const d = new InboundDeduper({ ttl: 1000 })
    vi.useFakeTimers()
    try {
      expect(d.isDuplicate('k')).toBe(false)
      vi.advanceTimersByTime(1500)
      expect(d.isDuplicate('k')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('release() forgets a key so a redelivery is accepted again', () => {
    const d = new InboundDeduper()
    d.isDuplicate('k')
    d.release('k')
    expect(d.isDuplicate('k')).toBe(false)
    d.clear()
    expect(d.remembered).toBe(0)
  })

  it('rejects invalid options with ConfigValidationError', () => {
    expect(() => new InboundDeduper({ size: 0 })).toThrow(ConfigValidationError)
    expect(() => new InboundDeduper({ size: 1.5 })).toThrow(ConfigValidationError)
    expect(() => new InboundDeduper({ size: -3 })).toThrow(ConfigValidationError)
    expect(() => new InboundDeduper({ ttl: -1 })).toThrow(ConfigValidationError)
    expect(() => new InboundDeduper({ ttl: 'soon' as never })).toThrow()
  })
})

describe('inboundDedupeKey', () => {
  it('keys messages by chat + message id', () => {
    const a = inboundDedupeKey({ kind: 'message', message: message({ chatId: 'c1' }) })
    const b = inboundDedupeKey({ kind: 'message', message: message({ chatId: 'c2' }) })
    expect(a?.key).toBeDefined()
    expect(a?.key).not.toBe(b?.key)
  })

  it('cannot collide when ids contain the separator', () => {
    const a = inboundDedupeKey({ kind: 'message', message: message({ chatId: 'a:b', ref: { id: 'c', chatId: 'a:b' } }) })
    const b = inboundDedupeKey({ kind: 'message', message: message({ chatId: 'a', ref: { id: 'b:c', chatId: 'a' } }) })
    expect(a?.key).not.toBe(b?.key)
  })

  it('never dedupes a message without an id', () => {
    expect(inboundDedupeKey({ kind: 'message', message: message({ ref: { id: '', chatId: 'chat-1' } }) })).toBeUndefined()
  })

  it('keys interactions by interactionId, not by the message they are attached to', () => {
    const a = inboundDedupeKey({ kind: 'interaction', interaction: interaction({ interactionId: 'cb-1' }) })
    const b = inboundDedupeKey({ kind: 'interaction', interaction: interaction({ interactionId: 'cb-2' }) })
    expect(a?.key).not.toBe(b?.key)
    expect(inboundDedupeKey({ kind: 'interaction', interaction: interaction({ interactionId: '' }) })).toBeUndefined()
  })

  it('ignores event kinds that are not handler-dispatched', () => {
    expect(inboundDedupeKey({ kind: 'connection', update: { state: 'ready' } })).toBeUndefined()
    expect(inboundDedupeKey({ kind: 'status', status: { ref: { id: 'x', chatId: 'c' }, status: 'read', timestamp: 1 } })).toBeUndefined()
  })
})

describe('Bot inbound idempotency', () => {
  it('a webhook-style redelivery of the same message runs handlers once', async () => {
    const { bot, provider, seen } = await botWith()
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    emit(provider, { kind: 'message', message: message() }) // retry after the first was handled
    await tick(5)
    expect(seen).toEqual(['chat-1|m-1|hola'])
    expect(await bot.getStore().getMessagesByChat('chat-1')).toHaveLength(1)
    await bot.stop()
  })

  it('concurrent duplicates (same tick, before any processing) run handlers once', async () => {
    const { bot, provider, seen } = await botWith()
    emit(provider, { kind: 'message', message: message() })
    emit(provider, { kind: 'message', message: message() })
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    expect(seen).toHaveLength(1)
    await bot.stop()
  })

  it('distinct messages that share an id across chats are both handled', async () => {
    const { bot, provider, seen } = await botWith()
    emit(provider, { kind: 'message', message: message({ chatId: 'chat-A', ref: { id: '42', chatId: 'chat-A' } }) })
    emit(provider, { kind: 'message', message: message({ chatId: 'chat-B', ref: { id: '42', chatId: 'chat-B' } }) })
    await tick(5)
    expect(seen.sort()).toEqual(['chat-A|42|hola', 'chat-B|42|hola'])
    await bot.stop()
  })

  it('an edited message (same id, new body) is not mistaken for a retry', async () => {
    const { bot, provider, seen } = await botWith()
    emit(provider, { kind: 'message', message: message({ body: 'hola' }) })
    await tick(5)
    emit(provider, { kind: 'message', message: message({ body: 'adios' }) })
    await tick(5)
    expect(seen).toEqual(['chat-1|m-1|hola', 'chat-1|m-1|adios'])
    await bot.stop()
  })

  it('messages without an id are never dropped', async () => {
    const { bot, provider, seen } = await botWith()
    emit(provider, { kind: 'message', message: message({ ref: { id: '', chatId: 'chat-1' } }) })
    emit(provider, { kind: 'message', message: message({ ref: { id: '', chatId: 'chat-1' } }) })
    await tick(5)
    expect(seen).toHaveLength(2)
    await bot.stop()
  })

  it('a redelivered interaction runs once; two clicks on the same menu both run', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    const data: string[] = []
    bot.onMessage((ctx) => { data.push(`${ctx.interaction?.id}:${ctx.body}`) })
    await bot.start()
    emit(provider, { kind: 'interaction', interaction: interaction({ interactionId: 'cb-1', data: 'yes' }) })
    emit(provider, { kind: 'interaction', interaction: interaction({ interactionId: 'cb-1', data: 'yes' }) })
    emit(provider, { kind: 'interaction', interaction: interaction({ interactionId: 'cb-2', data: 'no' }) })
    await tick(5)
    expect(data).toEqual(['cb-1:yes', 'cb-2:no'])
    await bot.stop()
  })

  it('dedupe: false disables the guard (every delivery is handled)', async () => {
    const { bot, provider, seen } = await botWith({ dedupe: false })
    emit(provider, { kind: 'message', message: message() })
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    expect(seen).toHaveLength(2)
    await bot.stop()
  })

  it('is bounded: with size 1 an evicted message is accepted again', async () => {
    const { bot, provider, seen } = await botWith({ dedupe: { size: 1 } })
    emit(provider, { kind: 'message', message: message({ ref: { id: 'm-1', chatId: 'chat-1' } }) })
    emit(provider, { kind: 'message', message: message({ ref: { id: 'm-2', chatId: 'chat-1' } }) })
    emit(provider, { kind: 'message', message: message({ ref: { id: 'm-1', chatId: 'chat-1' } }) })
    await tick(5)
    expect(seen.map((s) => s.split('|')[1])).toEqual(['m-1', 'm-2', 'm-1'])
    await bot.stop()
  })

  it('honours ttl: a redelivery after the window is handled again', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000_000)
      const { bot, provider, seen } = await botWith({ dedupe: { ttl: 60_000 } })
      emit(provider, { kind: 'message', message: message() })
      await tick(5)
      now.mockReturnValue(1_000_000 + 30_000)
      emit(provider, { kind: 'message', message: message() })
      await tick(5)
      now.mockReturnValue(1_000_000 + 61_000)
      emit(provider, { kind: 'message', message: message() })
      await tick(5)
      expect(seen).toHaveLength(2)
      await bot.stop()
    } finally {
      now.mockRestore()
    }
  })

  it('a message whose persistence failed is released so a redelivery is processed', async () => {
    const store = new MemoryStore()
    const original = store.saveMessage.bind(store)
    let failures = 1
    store.saveMessage = async (m) => {
      if (failures-- > 0) throw new Error('store unavailable')
      return original(m)
    }
    const { bot, provider, seen } = await botWith({ store })
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    expect(seen).toHaveLength(0)
    expect(errors).toHaveLength(1)
    emit(provider, { kind: 'message', message: message() }) // the transport retries
    await tick(5)
    expect(seen).toEqual(['chat-1|m-1|hola'])
    await bot.stop()
  })

  it('events dropped while the bot is stopped are not remembered', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.ref.id) })
    emit(provider, { kind: 'message', message: message() }) // before start(): ignored
    await bot.start()
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    expect(seen).toEqual(['m-1'])
    await bot.stop()
  })

  it('a message dropped because the bot stopped is not remembered: a redelivery after restart runs', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    bot.onMessage(async (ctx) => {
      seen.push(ctx.ref.id)
      if (ctx.ref.id === 'm-1') await gate
    })
    await bot.start()
    emit(provider, { kind: 'message', message: message({ ref: { id: 'm-1', chatId: 'chat-1' } }) })
    await tick(5)
    emit(provider, { kind: 'message', message: message({ ref: { id: 'm-2', chatId: 'chat-1' }, body: 'second' }) })
    await tick(5) // m-2 is queued behind m-1 in the chat FIFO
    const stopped = bot.stop()
    release()
    await stopped
    await tick(5)
    expect(seen).toEqual(['m-1']) // m-2's turn came after stop(): dropped

    await bot.start()
    emit(provider, { kind: 'message', message: message({ ref: { id: 'm-2', chatId: 'chat-1' }, body: 'second' }) })
    await tick(5)
    expect(seen).toEqual(['m-1', 'm-2'])
    emit(provider, { kind: 'message', message: message({ ref: { id: 'm-1', chatId: 'chat-1' } }) })
    await tick(5)
    expect(seen).toEqual(['m-1', 'm-2']) // m-1 was processed: still a duplicate
    await bot.stop()
  })

  it('validates BotConfig.dedupe at construction', () => {
    expect(() => new Bot({ provider: new MockProvider(), dedupe: { size: 0 } })).toThrow(ConfigValidationError)
    expect(() => new Bot({ provider: new MockProvider(), dedupe: 'yes' as never })).toThrow(ConfigValidationError)
    expect(() => new Bot({ provider: new MockProvider(), dedupe: false })).not.toThrow()
  })
})

describe('inbound dedupe × access lists (blocked input is never recorded as seen)', () => {
  async function setup() {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.interaction ? `it:${ctx.interaction.id}` : `msg:${ctx.ref.id}`) })
    await bot.start()
    return { bot, provider, seen }
  }

  it('a message dropped by the blacklist is processed when redelivered after un-blocking', async () => {
    const { bot, provider, seen } = await setup()
    bot.blacklist.add('chat-1')
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    expect(seen).toEqual([])
    expect(await bot.getStore().getMessagesByChat('chat-1')).toEqual([])

    bot.blacklist.remove('chat-1')
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    expect(seen).toEqual(['msg:m-1'])
    expect(bot.metrics().dropped).toEqual({ duplicate: 0, blocked: 1, handoff: 0 })

    emit(provider, { kind: 'message', message: message() })   // now a real duplicate
    await tick(5)
    expect(seen).toEqual(['msg:m-1'])
    expect(bot.metrics().dropped).toEqual({ duplicate: 1, blocked: 1, handoff: 0 })
    await bot.stop()
  })

  it('a message from a sender outside the whitelist is processed when redelivered after whitelisting', async () => {
    const { bot, provider, seen } = await setup()
    bot.whitelist.enable()
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    bot.whitelist.add('chat-1')
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    expect(seen).toEqual(['msg:m-1'])
    await bot.stop()
  })

  it('an interaction dropped by the blacklist is processed when redelivered after un-blocking', async () => {
    const { bot, provider, seen } = await setup()
    bot.blacklist.add('chat-1')
    emit(provider, { kind: 'interaction', interaction: interaction({ interactionId: 'cb-1' }) })
    await tick(5)
    bot.blacklist.remove('chat-1')
    emit(provider, { kind: 'interaction', interaction: interaction({ interactionId: 'cb-1' }) })
    await tick(5)
    expect(seen).toEqual(['it:cb-1'])
    await bot.stop()
  })

  it('every redelivery of a still-blocked message counts as blocked, never as duplicate', async () => {
    const { bot, provider, seen } = await setup()
    bot.blacklist.add('chat-1')
    emit(provider, { kind: 'message', message: message() })
    emit(provider, { kind: 'message', message: message() })
    await tick(5)
    expect(seen).toEqual([])
    expect(bot.metrics().dropped).toEqual({ duplicate: 0, blocked: 2, handoff: 0 })
    expect(bot.metrics().messages.in).toBe(0)
    await bot.stop()
  })
})
