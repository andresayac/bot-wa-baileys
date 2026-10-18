import { describe, it, expect, afterEach } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { flow } from '../src/flows/FlowBuilder.js'
import {
  DEFAULT_TYPING,
  ExternalSendClock,
  PacedSendCancelled,
  TYPING_REFRESH_MS,
  UnsupportedContentError,
  createPacer,
  messagingSupport,
  normalizeTypingConfig,
  parseReplyDelay,
  resolveReplyTyping,
  typingDuration,
  type BotConfig,
  type EditResult,
  type MessageContext,
  type MessageRef,
  type OutboundContent,
  type ProviderCapabilities,
  type SendResult,
} from '../src/index.js'

type LogEntry =
  | { op: 'typing'; chatId: string; state?: string }
  | { op: 'send'; chatId: string; content: OutboundContent }
  | { op: 'edit'; ref: MessageRef; content: OutboundContent }

/** MockProvider + typing/edit seams, all recorded in one ordered log. */
class MessagingMock extends MockProvider {
  log: LogEntry[] = []
  typingError: Error | null = null
  typingThrowsSync = false
  editError: Error | null = null
  constructor(caps: Partial<ProviderCapabilities> = {}, opts: { edit?: boolean } = {}) {
    // `supports.edit: false` hides the editMessage override below (an unsupported seam).
    super(opts.edit === false ? { supports: { edit: false } } : {})
    Object.assign(this.capabilities, caps)
  }
  override async send(chatId: string, content: OutboundContent, options?: Parameters<MockProvider['send']>[2]): Promise<SendResult> {
    this.log.push({ op: 'send', chatId, content })
    return super.send(chatId, content, options)
  }
  typing(chatId: string, state?: 'typing' | 'recording' | 'paused'): Promise<void> {
    if (this.typingThrowsSync) throw new Error('sync typing boom')
    this.log.push({ op: 'typing', chatId, state })
    return this.typingError ? Promise.reject(this.typingError) : Promise.resolve()
  }
  override async editMessage(ref: MessageRef, content: OutboundContent): Promise<SendResult> {
    if (this.editError) throw this.editError
    this.log.push({ op: 'edit', ref, content })
    return { ref }
  }
}

const bots: Bot[] = []
afterEach(async () => {
  while (bots.length) await bots.pop()!.stop()
})

async function makeBot(provider: MessagingMock, config: Omit<BotConfig, 'provider'> = {}): Promise<Bot> {
  const bot = new Bot({ ...config, provider })
  bots.push(bot)
  await bot.start()
  return bot
}

/** Per-bot slot holding the handler for the next inbound 'go' (so a bot can be driven repeatedly). */
const slots = new WeakMap<Bot, { next?: (ctx: MessageContext) => Promise<void> }>()

/** Run `handler` for the next inbound 'go' and resolve with its value (or reject with its error). */
function runHandler<T>(bot: Bot, provider: MessagingMock, handler: (ctx: MessageContext) => Promise<T>): Promise<T> {
  let slot = slots.get(bot)
  if (!slot) {
    const created: { next?: (ctx: MessageContext) => Promise<void> } = {}
    slot = created
    slots.set(bot, created)
    bot.when('go', async (ctx) => { const fn = created.next; created.next = undefined; await fn?.(ctx) })
  }
  const target = slot
  return new Promise<T>((resolve, reject) => {
    target.next = async (ctx) => {
      try { resolve(await handler(ctx)) } catch (error) { reject(error) }
    }
    provider.incoming('go', { from: 'chat-1' })
  })
}

const fast = { minMs: 20, maxMs: 30, charsPerSecond: 1000 }

describe('typing config helpers', () => {
  it('sizes the indicator by length and clamps it to [minMs, maxMs]', () => {
    const cfg = { minMs: 800, maxMs: 3000, charsPerSecond: 20 }
    expect(typingDuration('hi', cfg)).toBe(800)
    expect(typingDuration('x'.repeat(40), cfg)).toBe(2000)
    expect(typingDuration('x'.repeat(500), cfg)).toBe(3000)
    // Counts code points, not UTF-16 units.
    expect(typingDuration('👋'.repeat(40), cfg)).toBe(2000)
  })

  it('normalizes BotConfig.typing and rejects invalid timings', () => {
    expect(normalizeTypingConfig(undefined)).toEqual(DEFAULT_TYPING)
    expect(normalizeTypingConfig(true)).toEqual({ ...DEFAULT_TYPING, enabled: true })
    expect(normalizeTypingConfig({ enabled: true, minMs: 100 })).toMatchObject({ enabled: true, minMs: 100, maxMs: 3000 })
    expect(normalizeTypingConfig({ minMs: 5000 })).toMatchObject({ minMs: 5000, maxMs: 5000 })
    expect(() => normalizeTypingConfig({ minMs: -1 })).toThrow(RangeError)
    expect(() => normalizeTypingConfig({ maxMs: Number.NaN })).toThrow(RangeError)
    expect(() => normalizeTypingConfig({ charsPerSecond: 0 })).toThrow(RangeError)
    expect(() => normalizeTypingConfig({ minMs: 500, maxMs: 100 })).toThrow(RangeError)
  })

  it('merges a per-reply override over the bot policy', () => {
    const off = normalizeTypingConfig(false)
    expect(resolveReplyTyping(off, undefined).enabled).toBe(false)
    expect(resolveReplyTyping(off, true).enabled).toBe(true)
    expect(resolveReplyTyping(normalizeTypingConfig(true), false).enabled).toBe(false)
    expect(resolveReplyTyping(off, { maxMs: 1000 })).toMatchObject({ enabled: true, maxMs: 1000, minMs: 800 })
    expect(resolveReplyTyping(off, { enabled: false }).enabled).toBe(false)
  })

  it('an explicit maxMs below the inherited minMs lowers the min instead of throwing', () => {
    expect(normalizeTypingConfig({ maxMs: 500 })).toMatchObject({ minMs: 500, maxMs: 500 })
    expect(resolveReplyTyping(normalizeTypingConfig(true), { maxMs: 500 })).toMatchObject({ enabled: true, minMs: 500, maxMs: 500 })
    // Both bounds explicit and inconsistent is still a configuration error.
    expect(() => resolveReplyTyping(normalizeTypingConfig(true), { minMs: 900, maxMs: 500 })).toThrow(RangeError)
  })

  it('parses reply delays', () => {
    expect(parseReplyDelay(undefined)).toBe(0)
    expect(parseReplyDelay(250)).toBe(250)
    expect(parseReplyDelay('1.5s')).toBe(1500)
    expect(() => parseReplyDelay(-5)).toThrow(RangeError)
    expect(() => parseReplyDelay('soon')).toThrow()
  })

  it('reports native / degraded / unsupported per feature', () => {
    const full = new MessagingMock({ edit: true })
    expect(messagingSupport(full, 'typing')).toBe('native')
    expect(messagingSupport(full, 'edit')).toBe('native')
    expect(messagingSupport(full, 'react')).toBe('native')
    expect(messagingSupport(full, 'delay')).toBe('native')
    const poor = new MessagingMock({ typing: false, edit: false, reactions: false })
    expect(messagingSupport(poor, 'typing')).toBe('unsupported')
    expect(messagingSupport(poor, 'edit')).toBe('degraded')
    expect(messagingSupport(poor, 'react')).toBe('unsupported')
    // Capability flag set but method missing → not native.
    const noMethod = new MessagingMock({ edit: true }, { edit: false })
    expect(messagingSupport(noMethod, 'edit')).toBe('degraded')
    expect(messagingSupport(new MockProvider(), 'typing')).toBe('unsupported')
  })

  it('ExternalSendClock ticks per external send and is bounded', () => {
    const c = new ExternalSendClock(2)
    expect(c.now()).toBe(0)
    expect(c.lastExternal('a')).toBe(0)
    c.mark('a')
    const at = c.now()
    expect(c.lastExternal('a')).toBe(at)
    c.mark('b')
    expect(c.lastExternal('b')).toBeGreaterThan(at)
    c.mark('c') // evicts 'a'
    expect(c.lastExternal('a')).toBe(0)
    expect(c.lastExternal('c')).toBe(c.now())
  })
})

describe('createPacer', () => {
  it('waits the delay, shows typing, re-issues it on long waits, then pauses after the send', async () => {
    const provider = new MessagingMock()
    const waits: number[] = []
    const pacer = createPacer({
      provider,
      typing: normalizeTypingConfig({ enabled: true, minMs: 9000, maxMs: 9000 }),
      sleep: async (ms) => { waits.push(ms) },
    })
    const result = await pacer.run('c', 'hola', { delay: 100 }, async () => {
      provider.log.push({ op: 'send', chatId: 'c', content: { kind: 'text', text: 'hola' } })
      return 'ok'
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(result).toBe('ok')
    expect(waits).toEqual([100, TYPING_REFRESH_MS, TYPING_REFRESH_MS, 1000])
    expect(provider.log.map((e) => e.op === 'typing' ? `typing:${e.state}` : e.op)).toEqual([
      'typing:typing', 'typing:typing', 'typing:typing', 'send', 'typing:paused',
    ])
  })

  it('sends immediately when typing is disabled or unsupported', async () => {
    const waits: number[] = []
    const sleep = async (ms: number) => { waits.push(ms) }
    const off = createPacer({ provider: new MessagingMock(), typing: DEFAULT_TYPING, sleep })
    await off.run('c', 'x', undefined, async () => 1)
    const unsupported = createPacer({ provider: new MessagingMock({ typing: false }), typing: normalizeTypingConfig(true), sleep })
    await unsupported.run('c', 'x', undefined, async () => 1)
    expect(waits).toEqual([])
  })

  it('pauses the indicator even when the send fails', async () => {
    const provider = new MessagingMock()
    const pacer = createPacer({ provider, typing: normalizeTypingConfig({ enabled: true, ...fast }), sleep: async () => {} })
    await expect(pacer.run('c', 'x', undefined, async () => { throw new Error('send failed') })).rejects.toThrow('send failed')
    await new Promise((r) => setTimeout(r, 0))
    expect(provider.log.at(-1)).toEqual({ op: 'typing', chatId: 'c', state: 'paused' })
  })
})

describe('automatic typing on ctx replies', () => {
  it('is off by default', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider)
    await runHandler(bot, provider, (ctx) => ctx.reply('hola'))
    expect(provider.log.filter((e) => e.op === 'typing')).toEqual([])
  })

  it('BotConfig.typing shows composing → waits → sends → paused', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider, { typing: { enabled: true, ...fast } })
    const started = Date.now()
    await runHandler(bot, provider, (ctx) => ctx.reply('hola'))
    const elapsed = Date.now() - started
    await new Promise((r) => setTimeout(r, 0))
    expect(elapsed).toBeGreaterThanOrEqual(15)
    expect(provider.log.map((e) => e.op === 'typing' ? `typing:${e.state}` : e.op)).toEqual([
      'typing:typing', 'send', 'typing:paused',
    ])
    expect(provider.log[0]).toMatchObject({ chatId: 'chat-1' })
  })

  it('applies to say/answer/text/quote and flow .say, not to media or reactions', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider, { typing: { enabled: true, minMs: 1, maxMs: 1 } })
    await runHandler(bot, provider, async (ctx) => {
      await ctx.say('a'); await ctx.answer('b'); await ctx.text('c'); await ctx.quote('d')
      await ctx.photo('https://example.test/x.png')
      await ctx.react('👍')
    })
    const typingStarts = provider.log.filter((e) => e.op === 'typing' && e.state === 'typing')
    expect(typingStarts).toHaveLength(4)

    provider.log = []
    bot.use(flow('registro').say('Bienvenido'))
    provider.incoming('registro', { from: 'chat-2' })
    await new Promise((r) => setTimeout(r, 50))
    expect(provider.log.map((e) => e.op === 'typing' ? `typing:${e.state}` : e.op)).toEqual(['typing:typing', 'send', 'typing:paused'])
  })

  it('per-reply { typing } overrides the bot policy both ways', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider, { typing: { enabled: true, ...fast } })
    await runHandler(bot, provider, (ctx) => ctx.reply('sin typing', { typing: false }))
    expect(provider.log.filter((e) => e.op === 'typing')).toEqual([])

    const provider2 = new MessagingMock()
    const bot2 = await makeBot(provider2)
    await runHandler(bot2, provider2, (ctx) => ctx.reply('con typing', { typing: { minMs: 1, maxMs: 1 } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(provider2.log.map((e) => e.op === 'typing' ? `typing:${e.state}` : e.op)).toEqual(['typing:typing', 'send', 'typing:paused'])
  })

  it('never fails a send when the typing indicator rejects or throws', async () => {
    const provider = new MessagingMock()
    provider.typingError = new Error('presence down')
    const bot = await makeBot(provider, { typing: { enabled: true, minMs: 1, maxMs: 1 } })
    const sent = await runHandler(bot, provider, (ctx) => ctx.reply('igual llega'))
    expect(sent.skipped).toBeFalsy()
    expect(provider.outbox.map((m) => m.content)).toEqual([{ kind: 'text', text: 'igual llega' }])

    const provider2 = new MessagingMock()
    provider2.typingThrowsSync = true
    const bot2 = await makeBot(provider2, { typing: { enabled: true, minMs: 1, maxMs: 1 } })
    await runHandler(bot2, provider2, (ctx) => ctx.reply('también'))
    expect(provider2.outbox).toHaveLength(1)
  })

  it('skips indicator and wait on providers without typing capability', async () => {
    const provider = new MessagingMock({ typing: false })
    const bot = await makeBot(provider, { typing: { enabled: true, minMs: 5000, maxMs: 5000 } })
    const started = Date.now()
    await runHandler(bot, provider, (ctx) => ctx.reply('rápido'))
    expect(Date.now() - started).toBeLessThan(1000)
    expect(provider.log.filter((e) => e.op === 'typing')).toEqual([])
  })

  it('a per-reply maxMs below the bot minMs still sends', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider, { typing: { enabled: true, minMs: 50, maxMs: 100 } })
    const sent = await runHandler(bot, provider, (ctx) => ctx.reply('ok', { typing: { maxMs: 5 } }))
    expect(sent.skipped).toBeFalsy()
    expect(provider.outbox.map((m) => m.content)).toEqual([{ kind: 'text', text: 'ok' }])
  })

  it('rejects an invalid BotConfig.typing at construction', () => {
    expect(() => new Bot({ provider: new MessagingMock(), typing: { minMs: -1 } })).toThrow(RangeError)
  })
})

describe('reply delay', () => {
  it('waits { delay } before sending, on any provider', async () => {
    const provider = new MessagingMock({ typing: false })
    const bot = await makeBot(provider)
    const started = Date.now()
    await runHandler(bot, provider, (ctx) => ctx.reply('luego', { delay: 40 }))
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
    expect(provider.outbox).toHaveLength(1)
  })

  it('accepts duration strings and rejects invalid delays without sending', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider)
    await expect(runHandler(bot, provider, (ctx) => ctx.say('x', { delay: -1 }))).rejects.toThrow(RangeError)
    expect(provider.outbox).toHaveLength(0)
  })
})

describe('pacing cancellation', () => {
  const slow = { enabled: true, minMs: 60, maxMs: 60 }

  it('does not send a paced reply when the chat is handed off during the wait', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider, { typing: slow })
    const res = await runHandler(bot, provider, (ctx) => {
      const pending = ctx.reply('tarde')
      void bot.handoff('chat-1')
      return pending
    })
    expect(res.skipped).toBe(true)
    expect(provider.outbox).toHaveLength(0)
  })

  it('still sends when the chat was already handed off before the reply started', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider, { typing: slow })
    const res = await runHandler(bot, provider, async (ctx) => {
      await bot.handoff('chat-1')
      return ctx.reply('aviso')
    })
    expect(res.skipped).toBeFalsy()
    expect(provider.outbox).toHaveLength(1)
  })

  it('does not send a paced reply after bot.stop()', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider, { typing: slow })
    const res = await runHandler(bot, provider, async (ctx) => {
      const pending = ctx.reply('tarde', { delay: 30 })
      await bot.stop()
      return pending
    })
    expect(res.skipped).toBe(true)
    expect(provider.outbox).toHaveLength(0)
  })

  it('stop({ drain: true }) waits for a paced reply and delivers it', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider, { typing: slow })
    let pending: Promise<unknown> | undefined
    await runHandler(bot, provider, async (ctx) => { pending = ctx.reply('drenado') })
    await bot.stop({ drain: true })
    await pending
    expect(provider.outbox.map((m) => m.content)).toEqual([{ kind: 'text', text: 'drenado' }])
  })

  it('a flow .say aborted during typing sends nothing', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider, { typing: slow })
    bot.use(flow('registro').say('Bienvenido').say('Segundo'))
    provider.incoming('registro', { from: 'chat-2' })
    await new Promise((r) => setTimeout(r, 15))
    expect(bot.abortConversation('chat-2')).toBe(true)
    await new Promise((r) => setTimeout(r, 150))
    expect(provider.outbox).toHaveLength(0)
  })
})

describe('ctx.edit', () => {
  it('edits the bot\'s last message in the chat natively', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    let first: MessageRef | undefined
    const res = await runHandler(bot, provider, async (ctx) => {
      first = (await ctx.reply('Procesando…')).ref
      await ctx.react('👀') // reactions are not "last sent"
      return ctx.edit('Listo ✅')
    })
    expect(res.edited).toBe(true)
    expect(res.ref).toEqual(first)
    expect(provider.log.at(-1)).toEqual({ op: 'edit', ref: first, content: { kind: 'text', text: 'Listo ✅' } })
    expect(provider.outbox).toHaveLength(2) // reply + reaction, no new message
  })

  it('edits a given ref with arbitrary content', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    const ref = { id: 'm-9', chatId: 'chat-1' }
    const content: OutboundContent = { kind: 'image', media: 'https://example.test/a.png', caption: 'nuevo' }
    const res = await runHandler(bot, provider, async (ctx) => {
      const a = await ctx.edit(ref, 'texto')
      const b = await ctx.edit(ref, content)
      return [a, b] as EditResult[]
    })
    expect(res.every((r) => r.edited)).toBe(true)
    expect(provider.log.filter((e) => e.op === 'edit')).toEqual([
      { op: 'edit', ref, content: { kind: 'text', text: 'texto' } },
      { op: 'edit', ref, content },
    ])
  })

  it('never targets a message sent outside ctx (bot.send / sendTo)', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    await bot.sendText('chat-1', 'desde fuera')
    const res = await runHandler(bot, provider, (ctx) => ctx.edit('corregido'))
    expect(res.edited).toBe(false)
    expect(provider.log.filter((e) => e.op === 'edit')).toEqual([])

    // A human agent's sendTo after a bot reply invalidates the implicit target.
    const res2 = await runHandler(bot, provider, async (ctx) => {
      await ctx.reply('bot')
      await bot.sendTo('chat-1', 'agente humano')
      return ctx.edit('editado', { fallback: 'skip' })
    })
    expect(res2).toMatchObject({ edited: false, skipped: true })
    expect(provider.log.filter((e) => e.op === 'edit')).toEqual([])
  })

  it('does not edit text over a last message of another kind', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    const res = await runHandler(bot, provider, async (ctx) => {
      await ctx.reply('texto')
      await ctx.photo('https://example.test/x.png')
      return ctx.edit('nuevo texto', { fallback: 'skip' })
    })
    expect(res).toMatchObject({ edited: false, skipped: true })
    expect(provider.log.filter((e) => e.op === 'edit')).toEqual([])
  })

  it('routes edits through before/after(send) hooks and the outbound ledger', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    const seen: unknown[] = []
    bot.before('send', async (p: { content: OutboundContent; edit?: MessageRef }, next: () => Promise<void>) => {
      if (p.content.kind === 'text') p.content = { kind: 'text', text: p.content.text.replace('secreto', '***') }
      await next()
    })
    bot.after('send', (p: { content: OutboundContent; edit?: MessageRef }) => { seen.push({ content: p.content, edit: p.edit }) })
    let first: MessageRef | undefined
    const res = await runHandler(bot, provider, async (ctx) => {
      first = (await ctx.reply('v1')).ref
      return ctx.edit('v2 secreto')
    })
    expect(res.edited).toBe(true)
    expect(provider.log.at(-1)).toEqual({ op: 'edit', ref: first, content: { kind: 'text', text: 'v2 ***' } })
    expect(seen.at(-1)).toEqual({ content: { kind: 'text', text: 'v2 ***' }, edit: first })
    const stored = await bot.getStore().getMessage(first!)
    expect(stored?.body).toBe('v2 ***')
  })

  it('a before(send) hook can block an edit', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    bot.before('send', async (p: { abort(): void; edit?: MessageRef }, next: () => Promise<void>) => { if (p.edit) p.abort(); else await next() })
    const res = await runHandler(bot, provider, async (ctx) => {
      await ctx.reply('v1')
      return ctx.edit('v2')
    })
    expect(res).toMatchObject({ edited: false, skipped: true })
    expect(provider.log.filter((e) => e.op === 'edit')).toEqual([])
    expect(provider.outbox).toHaveLength(1)
  })

  it('degrades to a new message when the provider cannot edit', async () => {
    const provider = new MessagingMock({ edit: false })
    const bot = await makeBot(provider)
    expect(await runHandler(bot, provider, (ctx) => Promise.resolve(ctx.supports('edit')))).toBe('degraded')
    const res = await runHandler(bot, provider, async (ctx) => {
      await ctx.reply('v1')
      return ctx.edit('v2')
    })
    expect(res.edited).toBe(false)
    expect(res.skipped).toBeFalsy()
    expect(provider.log.filter((e) => e.op === 'edit')).toEqual([])
    expect(provider.outbox.map((m) => m.content)).toEqual([{ kind: 'text', text: 'v1' }, { kind: 'text', text: 'v2' }])
  })

  it('with { fallback: "skip" } sends nothing when it cannot edit', async () => {
    const provider = new MessagingMock({ edit: false })
    const bot = await makeBot(provider)
    const res = await runHandler(bot, provider, (ctx) => ctx.edit('v2', { fallback: 'skip' }))
    expect(res).toMatchObject({ edited: false, skipped: true })
    expect(provider.outbox).toHaveLength(0)
  })

  it('falls back when there is no previous bot message in the chat', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    const res = await runHandler(bot, provider, (ctx) => ctx.edit('primero'))
    expect(res.edited).toBe(false)
    expect(provider.outbox.map((m) => m.content)).toEqual([{ kind: 'text', text: 'primero' }])
  })

  it('falls back on UnsupportedContentError but propagates other edit errors', async () => {
    const provider = new MessagingMock({ edit: true })
    provider.editError = new UnsupportedContentError('image', 'only text is editable')
    const bot = await makeBot(provider)
    const ref = { id: 'm-1', chatId: 'chat-1' }
    const res = await runHandler(bot, provider, (ctx) => ctx.edit(ref, { kind: 'image', media: 'https://example.test/b.png' }))
    expect(res.edited).toBe(false)
    expect(provider.outbox).toHaveLength(1)

    provider.editError = new Error('message too old')
    await expect(runHandler(bot, provider, (ctx) => ctx.edit(ref, 'x'))).rejects.toThrow('message too old')
  })

  it('does not record a send skipped by a before(send) hook', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    bot.before('send', async (p: { abort(): void; content: OutboundContent }, next: () => Promise<void>) => {
      if (p.content.kind === 'text' && p.content.text === 'bloqueado') p.abort()
      else await next()
    })
    const res = await runHandler(bot, provider, async (ctx) => {
      await ctx.reply('bloqueado')
      return ctx.edit('x', { fallback: 'skip' })
    })
    expect(res).toMatchObject({ edited: false, skipped: true })
  })
})

describe('ctx.edit scoping', () => {
  it('falls back to the chat of the ref when the provider cannot edit', async () => {
    const provider = new MessagingMock({ edit: false })
    const bot = await makeBot(provider)
    const res = await runHandler(bot, provider, (ctx) => ctx.edit({ id: 'm-1', chatId: 'other-chat' }, 'secret'))
    expect(res).toMatchObject({ edited: false, chatId: 'other-chat' })
    expect(provider.outbox.map((m) => m.chatId)).toEqual(['other-chat'])
  })

  it('falls back to the chat of the ref on UnsupportedContentError', async () => {
    const provider = new MessagingMock({ edit: true })
    provider.editError = new UnsupportedContentError('image', 'only text is editable')
    const bot = await makeBot(provider)
    const res = await runHandler(bot, provider, (ctx) =>
      ctx.edit({ id: 'm-1', chatId: 'other-chat' }, { kind: 'image', media: 'https://example.test/b.png' }))
    expect(res).toMatchObject({ edited: false, chatId: 'other-chat' })
    expect(provider.outbox.map((m) => m.chatId)).toEqual(['other-chat'])
  })

  it('an implicit edit never targets a reply from an earlier handler run', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    await runHandler(bot, provider, (ctx) => ctx.reply('old answer from yesterday'))
    const res = await runHandler(bot, provider, (ctx) => ctx.edit('new status', { fallback: 'skip' }))
    expect(res).toMatchObject({ edited: false, skipped: true })
    expect(provider.log.filter((e) => e.op === 'edit')).toEqual([])
  })

  it('a detached context edits its own reply, not one sent meanwhile by another context in the chat', async () => {
    const provider = new MessagingMock({ edit: true })
    const bot = await makeBot(provider)
    // Two contexts of the same chat (e.g. two group participants' flows) interleave their sends.
    const [ctxA, refA] = await runHandler(bot, provider, async (ctx) => [ctx, (await ctx.reply('A: working')).ref] as const)
    await runHandler(bot, provider, (ctx) => ctx.reply('B: hello'))
    const res = await ctxA.edit('A: done')
    expect(res).toMatchObject({ edited: true, ref: refA })
    expect(provider.log.at(-1)).toEqual({ op: 'edit', ref: refA, content: { kind: 'text', text: 'A: done' } })
  })
})

describe('ctx.react', () => {
  it('reacts to the inbound message, or to a given target', async () => {
    const provider = new MessagingMock()
    const bot = await makeBot(provider)
    const target = { id: 'other', chatId: 'chat-1' }
    let inboundRef: MessageRef | undefined
    await runHandler(bot, provider, async (ctx) => {
      inboundRef = ctx.ref
      await ctx.react('👍')
      await ctx.react('🔥', target)
      await ctx.react('') // removal is passed through
    })
    expect(provider.outbox.map((m) => m.content)).toEqual([
      { kind: 'reaction', emoji: '👍', target: inboundRef },
      { kind: 'reaction', emoji: '🔥', target },
      { kind: 'reaction', emoji: '', target: inboundRef },
    ])
  })

  it('resolves skipped (no send, no error) on providers that cannot send reactions', async () => {
    const provider = new MessagingMock({ reactions: false })
    const bot = await makeBot(provider)
    const [support, res] = await runHandler(bot, provider, async (ctx) => [ctx.supports('react'), await ctx.react('👍')] as const)
    expect(support).toBe('unsupported')
    expect(res.skipped).toBe(true)
    expect(provider.outbox).toHaveLength(0)
  })
})

describe('createPacer cancellation', () => {
  it('drops the send after the wait when a guard or cancelIf says so', async () => {
    const provider = new MessagingMock()
    const pacer = createPacer({ provider, typing: normalizeTypingConfig({ enabled: true, ...fast }), sleep: async () => {} })
    let sent = 0
    const send = async () => { sent++; return 'sent' }
    expect(await pacer.run('c', 'x', undefined, send, { cancelled: () => true, skip: () => 'skipped' })).toBe('skipped')
    await expect(pacer.run('c', 'x', { cancelIf: () => true }, send)).rejects.toBeInstanceOf(PacedSendCancelled)
    // No wait → nothing to re-check: sent immediately.
    const off = createPacer({ provider, typing: DEFAULT_TYPING, sleep: async () => {} })
    expect(await off.run('c', 'x', { cancelIf: () => true }, send)).toBe('sent')
    expect(sent).toBe(1)
  })
})
