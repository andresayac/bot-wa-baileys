import { describe, it, expect, vi } from 'vitest'
import {
  RateLimitedError,
  ProviderError,
  resolveStreamStrategy,
  splitMessage,
  findSplitPoint,
  streamText,
  type MessageRef,
  type OutboundContent,
  type SentMessage,
  type StreamTarget,
  type DraftOptions,
  type ProviderCapabilities,
} from '../src/index.js'
import { createTestBot } from '../src/testing/index.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function* gen(parts: string[], delayMs = 2): AsyncGenerator<string> {
  for (const p of parts) {
    if (delayMs) await wait(delayMs)
    yield p
  }
}

interface Recorder {
  target: StreamTarget
  sent: string[]
  edits: Array<{ id: string; text: string }>
  drafts: Array<{ id: number; text: string; opts?: DraftOptions }>
  typing: number
}

function recorder(opts: {
  streaming?: ProviderCapabilities['streaming']
  maxTextLength?: number
  draft?: boolean
  edit?: boolean
  isPrivate?: boolean
  draftImpl?: (id: number, text: string, o?: DraftOptions) => Promise<void>
  editImpl?: (ref: MessageRef, c: OutboundContent) => Promise<unknown>
} = {}): Recorder {
  const r: Recorder = { sent: [], edits: [], drafts: [], typing: 0, target: undefined as unknown as StreamTarget }
  let n = 0
  r.target = {
    capabilities: { streaming: opts.streaming ?? 'none', maxTextLength: opts.maxTextLength, edit: opts.edit ?? false },
    isPrivate: opts.isPrivate,
    async send(content): Promise<SentMessage> {
      const text = content.kind === 'text' ? content.text : ''
      r.sent.push(text)
      const id = `m${++n}`
      return { ref: { id, chatId: 'c' }, id, chatId: 'c' }
    },
    edit: opts.edit ? async (ref, content) => {
      if (opts.editImpl) await opts.editImpl(ref, content)
      r.edits.push({ id: ref.id, text: content.kind === 'text' ? content.text : '' })
    } : undefined,
    draft: opts.draft ? async (id, text, o) => {
      if (opts.draftImpl) await opts.draftImpl(id, text, o)
      r.drafts.push({ id, text, opts: o })
    } : undefined,
    async typing() { r.typing++ },
  }
  return r
}

describe('splitMessage', () => {
  it('returns one piece when it fits', () => {
    expect(splitMessage('hola mundo', 50)).toEqual(['hola mundo'])
  })

  it('never exceeds max and prefers paragraph, sentence and word boundaries', () => {
    const text = 'Primera frase corta. Segunda frase algo mas larga que la primera.\n\nOtro parrafo con varias palabras aqui.'
    const parts = splitMessage(text, 40)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(40)
    expect(parts[0]).toBe('Primera frase corta.')
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
  })

  it('hard-cuts text without boundaries and never splits a surrogate pair', () => {
    const emoji = '😀'.repeat(10) // 20 UTF-16 units
    const parts = splitMessage(emoji, 5)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(5)
      expect(p).not.toMatch(/[\uD800-\uDBFF]$/)
    }
    expect(parts.join('')).toBe(emoji)
  })

  it('findSplitPoint returns the length when it fits', () => {
    expect(findSplitPoint('abc', 10)).toBe(3)
  })

  it('rejects a non-positive max', () => {
    expect(() => splitMessage('x', 0)).toThrow(RangeError)
  })
})

describe('resolveStreamStrategy', () => {
  it('draft for draft providers in private chats', () => {
    expect(resolveStreamStrategy(recorder({ streaming: 'draft', draft: true, edit: true }).target)).toBe('draft')
  })
  it('degrades draft to edit outside private chats', () => {
    expect(resolveStreamStrategy(recorder({ streaming: 'draft', draft: true, edit: true, isPrivate: false }).target)).toBe('edit')
  })
  it('edit for edit providers', () => {
    expect(resolveStreamStrategy(recorder({ streaming: 'edit', edit: true }).target)).toBe('edit')
  })
  it('chunk for none / unset', () => {
    expect(resolveStreamStrategy(recorder({ streaming: 'none', edit: true }).target)).toBe('chunk')
    expect(resolveStreamStrategy({ send: async () => ({ ref: { id: '1', chatId: 'c' }, id: '1', chatId: 'c' }) })).toBe('chunk')
  })
  it('honours explicit choices and degrades unsupported ones', () => {
    const t = recorder({ streaming: 'none' }).target
    expect(resolveStreamStrategy(t, 'buffer')).toBe('buffer')
    expect(resolveStreamStrategy(t, 'draft')).toBe('chunk')
    expect(resolveStreamStrategy(t, 'edit')).toBe('chunk')
  })
})

describe('streamText — chunk strategy (WhatsApp-like)', () => {
  it('sends sentence-sized chunks with typing and the remainder at the end', async () => {
    const r = recorder({ streaming: 'none' })
    const res = await streamText(r.target, gen(['Hola, ', 'esto es la primera frase. ', 'Y esta ', 'es la segunda. ', 'Fin']), { minChunkChars: 10 })
    expect(res.strategy).toBe('chunk')
    expect(r.sent).toEqual(['Hola, esto es la primera frase.', 'Y esta es la segunda.', 'Fin'])
    expect(res.text).toBe('Hola, esto es la primera frase. Y esta es la segunda. Fin')
    expect(res.messages).toHaveLength(3)
    expect(r.typing).toBeGreaterThan(0)
  })

  it('never exceeds the provider limit, even without boundaries', async () => {
    const r = recorder({ streaming: 'none', maxTextLength: 50 })
    const words = Array.from({ length: 60 }, (_, i) => `w${i} `)
    await streamText(r.target, gen(words, 0))
    for (const s of r.sent) expect(s.length).toBeLessThanOrEqual(50)
    expect(r.sent.join(' ').split(/\s+/).filter(Boolean)).toHaveLength(60)
  })
})

describe('streamText — buffer strategy', () => {
  it('collects everything and sends once, split by the limit', async () => {
    const r = recorder({ maxTextLength: 20 })
    const res = await streamText(r.target, gen(['uno dos tres ', 'cuatro cinco seis ', 'siete']), { strategy: 'buffer' })
    expect(res.strategy).toBe('buffer')
    for (const s of r.sent) expect(s.length).toBeLessThanOrEqual(20)
    expect(r.sent.join(' ')).toBe('uno dos tres cuatro cinco seis siete')
  })

  it('sends nothing for an empty stream', async () => {
    const r = recorder()
    const res = await streamText(r.target, gen([]))
    expect(r.sent).toEqual([])
    expect(res.messages).toEqual([])
  })
})

describe('streamText — draft strategy (Telegram-like)', () => {
  it('updates one draft and finishes with a real message', async () => {
    const r = recorder({ streaming: 'draft', draft: true, edit: true })
    const res = await streamText(r.target, gen(['Hola', ' que', ' tal'], 5), { throttleMs: 0, canStop: true })
    expect(res.strategy).toBe('draft')
    expect(r.drafts.length).toBeGreaterThan(0)
    expect(new Set(r.drafts.map((d) => d.id)).size).toBe(1)
    expect(r.drafts[0].id).toBeGreaterThan(0)
    expect(r.drafts[0].opts?.canStop).toBe(true)
    expect(r.sent).toEqual(['Hola que tal'])
    expect(r.edits).toEqual([])
  })

  it('throttles draft updates', async () => {
    const r = recorder({ streaming: 'draft', draft: true })
    const parts = Array.from({ length: 30 }, (_, i) => `t${i} `)
    await streamText(r.target, gen(parts, 2), { throttleMs: 1000 })
    expect(r.drafts.length).toBeLessThanOrEqual(2)
    expect(r.sent).toHaveLength(1)
  })

  it('commits a full segment and starts a new draft when the limit is reached', async () => {
    const r = recorder({ streaming: 'draft', draft: true, maxTextLength: 30 })
    const parts = Array.from({ length: 20 }, (_, i) => `pal${i} `)
    const res = await streamText(r.target, gen(parts, 1), { throttleMs: 0, cursor: ' ▌' })
    for (const s of r.sent) expect(s.length).toBeLessThanOrEqual(30)
    for (const d of r.drafts) expect(d.text.length).toBeLessThanOrEqual(30)
    expect(r.sent.length).toBeGreaterThan(1)
    expect(new Set(r.drafts.map((d) => d.id)).size).toBeGreaterThan(1)
    expect(r.sent.join(' ')).toBe(res.text.trim())
    for (const s of r.sent) expect(s).not.toContain('▌')
  })

  it('falls back to edits when the transport refuses drafts', async () => {
    const r = recorder({
      streaming: 'draft', draft: true, edit: true,
      draftImpl: async () => { throw new ProviderError('Bad Request: chat is not private') },
    })
    const res = await streamText(r.target, gen(['Hola', ' mundo', ' bonito'], 5), { throttleMs: 0 })
    expect(res.strategy).toBe('edit')
    expect(r.sent[0].startsWith('Hola')).toBe(true)
    const final = r.edits.at(-1)?.text ?? r.sent[0]
    expect(final).toBe('Hola mundo bonito')
  })

  it('a user stop cancels the source and flushes the partial text', async () => {
    const r = recorder({ streaming: 'draft', draft: true })
    const returned = vi.fn()
    async function* slow(): AsyncGenerator<string> {
      try {
        for (let i = 0; i < 1000; i++) { await wait(3); yield `w${i} ` }
      } finally { returned() }
    }
    const p = streamText(r.target, slow(), { throttleMs: 0, canStop: true })
    await wait(30)
    r.drafts.at(-1)!.opts!.onStop!()
    const res = await p
    expect(res.cancelled).toBe(true)
    expect(res.stoppedByUser).toBe(true)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toBe(res.text.trim())
    await wait(10)
    expect(returned).toHaveBeenCalled()
  })
})

describe('streamText — edit strategy (Discord-like)', () => {
  it('sends once, edits in place and ends with the full text (cursor removed)', async () => {
    const r = recorder({ streaming: 'edit', edit: true })
    const res = await streamText(r.target, gen(['Uno', ' dos', ' tres', ' cuatro'], 5), { throttleMs: 0, cursor: ' ▌' })
    expect(res.strategy).toBe('edit')
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].endsWith(' ▌')).toBe(true)
    expect(r.edits.every((e) => e.id === 'm1')).toBe(true)
    expect(r.edits.at(-1)!.text).toBe('Uno dos tres cuatro')
    expect(res.messages).toHaveLength(1)
  })

  it('freezes a full message and continues in a new one past the limit', async () => {
    const r = recorder({ streaming: 'edit', edit: true, maxTextLength: 25 })
    const parts = Array.from({ length: 15 }, (_, i) => `x${i} `)
    const res = await streamText(r.target, gen(parts, 1), { throttleMs: 0 })
    for (const s of [...r.sent, ...r.edits.map((e) => e.text)]) expect(s.length).toBeLessThanOrEqual(25)
    expect(r.sent.length).toBeGreaterThan(1)
    expect(res.messages.length).toBe(r.sent.length)
  })

  it('skips failed intermediate edits and retries a rate-limited final edit once', async () => {
    let calls = 0
    const r = recorder({
      streaming: 'edit', edit: true,
      editImpl: async () => { calls++; if (calls <= 2) throw new RateLimitedError(5) },
    })
    await streamText(r.target, gen(['a', ' b', ' c', ' d'], 5), { throttleMs: 0 })
    expect(r.edits.at(-1)!.text).toBe('a b c d')
  })

  it('backs off for retryAfterMs after a rate-limited intermediate edit', async () => {
    const attempts: number[] = []
    let failed = false
    const r = recorder({
      streaming: 'edit', edit: true,
      editImpl: async () => {
        attempts.push(Date.now())
        if (!failed) { failed = true; throw new RateLimitedError(120) }
      },
    })
    const parts = Array.from({ length: 40 }, (_, i) => `w${i} `)
    await streamText(r.target, gen(parts, 3), { throttleMs: 0 })
    expect(attempts.length).toBeGreaterThan(1)
    // No edit is attempted while the transport asked us to wait.
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(110)
    expect(r.edits.at(-1)!.text).toBe(parts.join('').trim())
  })

  it('the final edit waits out repeated rate limits instead of failing', async () => {
    let calls = 0
    const r = recorder({
      streaming: 'edit', edit: true,
      editImpl: async () => { calls++; if (calls <= 3) throw new RateLimitedError(20) },
    })
    const res = await streamText(r.target, gen(['a', ' b'], 5), { throttleMs: 0 })
    expect(res.messages).toHaveLength(1)
    expect(r.edits.at(-1)!.text).toBe('a b')
  })

  it("onCancel: 'discard' deletes the live message the user already saw", async () => {
    const r = recorder({ streaming: 'edit', edit: true })
    const deleted: string[] = []
    r.target.delete = async (ref) => { deleted.push(ref.id) }
    const ac = new AbortController()
    async function* endless(): AsyncGenerator<string> { for (let i = 0; ; i++) { await wait(3); yield `t${i} ` } }
    setTimeout(() => ac.abort(), 40)
    const res = await streamText(r.target, endless(), { throttleMs: 0, signal: ac.signal, onCancel: 'discard' })
    expect(res.cancelled).toBe(true)
    expect(r.sent).toHaveLength(1)
    expect(deleted).toEqual(['m1'])
    expect(res.messages).toEqual([])
  })

  it('throws (after stopping) when the first send fails', async () => {
    const r = recorder({ streaming: 'edit', edit: true })
    r.target.send = async () => { throw new ProviderError('boom') }
    await expect(streamText(r.target, gen(['a', 'b'], 5), { throttleMs: 0 })).rejects.toThrow('boom')
  })
})

describe('streamText — cancellation, errors and sources', () => {
  it('abort signal stops reading, calls return() and flushes', async () => {
    const r = recorder()
    const returned = vi.fn()
    async function* src(): AsyncGenerator<string> {
      try { for (let i = 0; ; i++) { await wait(3); yield `p${i} ` } } finally { returned() }
    }
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    const res = await streamText(r.target, src(), { signal: ac.signal, strategy: 'buffer' })
    expect(res.cancelled).toBe(true)
    expect(res.stoppedByUser).toBe(false)
    expect(r.sent.join(' ')).toBe(res.text.trim())
    await wait(10)
    expect(returned).toHaveBeenCalled()
  })

  it("onCancel: 'discard' drops the pending text", async () => {
    const r = recorder()
    const ac = new AbortController()
    ac.abort()
    const res = await streamText(r.target, gen(['x', 'y']), { signal: ac.signal, onCancel: 'discard', strategy: 'buffer' })
    expect(res.cancelled).toBe(true)
    expect(r.sent).toEqual([])
  })

  it('a source error flushes what was produced, then rejects', async () => {
    const r = recorder()
    async function* bad(): AsyncGenerator<string> { yield 'parcial'; throw new Error('llm down') }
    await expect(streamText(r.target, bad(), { strategy: 'buffer' })).rejects.toThrow('llm down')
    expect(r.sent).toEqual(['parcial'])
  })

  it('accepts a web ReadableStream of bytes (multi-byte chars split across chunks)', async () => {
    const bytes = new TextEncoder().encode('¡Hola señor! ✅')
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1, 9)); c.enqueue(bytes.slice(9)); c.close() },
    })
    const r = recorder()
    const res = await streamText(r.target, stream, { strategy: 'buffer' })
    expect(res.text).toBe('¡Hola señor! ✅')
    expect(r.sent).toEqual(['¡Hola señor! ✅'])
  })

  it('accepts a sync iterable', async () => {
    const r = recorder()
    await streamText(r.target, ['a', 'b', 'c'], { strategy: 'buffer' })
    expect(r.sent).toEqual(['abc'])
  })
})

describe('ctx.stream (Bot integration)', () => {
  it('uses edits on an edit-capable provider', async () => {
    const { bot, provider, chat } = await createTestBot({}, { provider: { streaming: 'edit' } })
    let result: Awaited<ReturnType<typeof streamText>> | undefined
    bot.when('cuento', async (ctx) => { result = await ctx.stream(gen(['Había', ' una', ' vez'], 5), { throttleMs: 0 }) })
    await chat.send('cuento')
    await vi.waitFor(() => expect(result).toBeDefined())
    expect(result!.strategy).toBe('edit')
    expect(provider.outbox).toHaveLength(1)
    expect(provider.edits.at(-1)!.content).toEqual({ kind: 'text', text: 'Había una vez' })
    await bot.stop()
  })

  it('uses native drafts in private chats and sends the final message through the send pipeline', async () => {
    const { bot, provider, chat } = await createTestBot({}, { provider: { streaming: 'draft' } })
    const seen: string[] = []
    bot.before('send', (p) => { const c = (p as { content: OutboundContent }).content; if (c.kind === 'text') seen.push(c.text) })
    let done = false
    bot.when('hola', async (ctx) => { await ctx.stream(gen(['Hola', ' humano'], 5), { throttleMs: 0, canStop: true }); done = true })
    await chat.send('hola')
    await vi.waitFor(() => expect(done).toBe(true))
    expect(provider.drafts.length).toBeGreaterThan(0)
    expect(provider.drafts[0].chatId).toBe(chat.jid)
    expect(chat.replies()).toEqual(['Hola humano'])
    expect(seen.at(-1)).toBe('Hola humano')
    await bot.stop()
  })

  it('runs before(send) on every edit: a redacting hook covers the live edits too', async () => {
    const { bot, provider, chat } = await createTestBot({}, { provider: { streaming: 'edit' } })
    const kinds: Array<string | undefined> = []
    bot.before('send', (p) => {
      const payload = p as { content: OutboundContent; stream?: string }
      kinds.push(payload.stream)
      if (payload.content.kind === 'text') payload.content = { kind: 'text', text: payload.content.text.replaceAll('secret', '***') }
    })
    let done = false
    bot.when('x', async (ctx) => {
      await ctx.stream(gen(['my secret ', 'is secret', ' and more text'], 15), { throttleMs: 0 })
      done = true
    })
    await chat.send('x')
    await vi.waitFor(() => expect(done).toBe(true))
    const shown = [...provider.outbox.map((m) => m.content), ...provider.edits.map((e) => e.content)]
      .map((c) => (c.kind === 'text' ? c.text : ''))
    expect(provider.edits.length).toBeGreaterThan(0)
    expect(shown.join(' ')).not.toContain('secret')
    expect(kinds).toContain('edit')
    await bot.stop()
  })

  it("marks every stream message in before(send): stream 'message' for new messages, 'edit'/'draft' for previews", async () => {
    for (const streaming of ['none', 'edit', 'draft'] as const) {
      const { bot, chat } = await createTestBot({}, { provider: { streaming } })
      const kinds: Array<string | undefined> = []
      bot.before('send', (p) => { kinds.push((p as { stream?: string }).stream) })
      let done = false
      bot.when('x', async (ctx) => {
        await ctx.stream(gen(['Una frase. ', 'Otra frase.'], 5), { throttleMs: 0 })
        await ctx.reply('normal')
        done = true
      })
      await chat.send('x')
      await vi.waitFor(() => expect(done).toBe(true))
      expect(kinds.at(-1)).toBeUndefined()
      const streamed = kinds.slice(0, -1)
      expect(streamed.length).toBeGreaterThan(0)
      expect(streamed.every((k) => k === 'message' || k === 'edit' || k === 'draft')).toBe(true)
      expect(streamed).toContain('message')
      await bot.stop()
    }
  })

  it('an aborting before(send) hook also blocks the native drafts', async () => {
    const { bot, provider, chat } = await createTestBot({}, { provider: { streaming: 'draft' } })
    bot.before('send', (p) => {
      const payload = p as { content: OutboundContent; abort(): void }
      if (payload.content.kind === 'text' && payload.content.text.includes('blocked')) payload.abort()
    })
    let done = false
    bot.when('x', async (ctx) => { await ctx.stream(gen(['blocked ', 'content'], 10), { throttleMs: 0 }); done = true })
    await chat.send('x')
    await vi.waitFor(() => expect(done).toBe(true))
    expect(provider.drafts).toHaveLength(0)
    expect(chat.replies()).toEqual([])
    await bot.stop()
  })

  it('edit strategy: the message log ends with the text the user sees (no cursor, not the first preview)', async () => {
    const { bot, provider, chat } = await createTestBot({}, { provider: { streaming: 'edit' } })
    const store = bot.getStore()
    let done = false
    bot.when('x', async (ctx) => {
      await ctx.stream(gen(['Había', ' una', ' vez'], 15), { throttleMs: 0, cursor: ' ▌', sendOptions: { quoted: ctx.ref } })
      done = true
    })
    await chat.send('x')
    await vi.waitFor(() => expect(done).toBe(true))
    expect(provider.outbox).toHaveLength(1)
    const out = (await store.getMessagesByChat(chat.jid)).filter((m) => m.direction === 'outbound')
    expect(out).toHaveLength(1)
    expect(out[0].body).toBe('Había una vez')
    expect(out[0].quoted).toBeDefined()
    await bot.stop()
  })

  it("onCancel: 'discard' deletes the streamed message from the chat and the message log", async () => {
    const { bot, provider, chat } = await createTestBot({}, { provider: { streaming: 'edit' } })
    const store = bot.getStore()
    async function* endless(): AsyncGenerator<string> { for (let i = 0; ; i++) { await wait(3); yield `t${i} ` } }
    let res: { cancelled: boolean } | undefined
    bot.when('x', async (ctx) => {
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 40)
      res = await ctx.stream(endless(), { throttleMs: 0, signal: ac.signal, onCancel: 'discard' })
    })
    await chat.send('x')
    await vi.waitFor(() => expect(res?.cancelled).toBe(true))
    expect(provider.outbox).toHaveLength(1)
    expect(provider.deleted).toHaveLength(1)
    const out = (await store.getMessagesByChat(chat.jid)).filter((m) => m.direction === 'outbound')
    expect(out).toEqual([])
    await bot.stop()
  })

  it('MockProvider.stopDraft simulates the stop button', async () => {
    const { bot, provider, chat } = await createTestBot({}, { provider: { streaming: 'draft' } })
    let result: Awaited<ReturnType<typeof streamText>> | undefined
    async function* endless(): AsyncGenerator<string> { for (let i = 0; ; i++) { await wait(3); yield `t${i} ` } }
    bot.when('go', async (ctx) => { result = await ctx.stream(endless(), { throttleMs: 0, canStop: true }) })
    await chat.send('go')
    await vi.waitFor(() => expect(provider.drafts.length).toBeGreaterThan(0))
    expect(provider.stopDraft()).toBe(true)
    await vi.waitFor(() => expect(result).toBeDefined())
    expect(result!.stoppedByUser).toBe(true)
    expect(provider.outbox).toHaveLength(1)
    await bot.stop()
  })

  it('degrades to chunks on the default MockProvider (no streaming)', async () => {
    const { bot, provider, chat } = await createTestBot()
    expect(provider.capabilities.streaming).toBe('none')
    expect(provider.editMessage).toBeUndefined()
    let res: Awaited<ReturnType<typeof streamText>> | undefined
    bot.when('x', async (ctx) => { res = await ctx.stream(gen(['Una frase. ', 'Otra.'], 1), { minChunkChars: 5 }) })
    await chat.send('x')
    await vi.waitFor(() => expect(res).toBeDefined())
    expect(res!.strategy).toBe('chunk')
    expect(chat.replies()).toEqual(['Una frase.', 'Otra.'])
    await bot.stop()
  })
})

describe('ctx.stream + BotConfig.typing (messaging)', () => {
  it('stream messages skip the reply pacer (no BotConfig.typing wait on top of the stream own typing)', async () => {
    const { Bot } = await import('../src/core/Bot.js')
    const { MockProvider } = await import('../src/testing/MockProvider.js')
    class TypingMock extends MockProvider {
      typings: string[] = []
      async typing(chatId: string): Promise<void> { this.typings.push(chatId) }
    }
    const provider = new TypingMock({ streaming: 'edit' })
    // A huge minimum typing time: any paced send would visibly stall the test.
    const bot = new Bot({ provider, typing: { minMs: 60_000, maxMs: 60_000 } })
    await bot.start()
    let done = false
    bot.when('cuento', async (ctx) => {
      await ctx.stream(gen(['Había', ' una', ' vez'], 2), { throttleMs: 0 })
      done = true
    })
    provider.incoming('cuento', { from: 'u1' })
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 2000 })
    expect(provider.edits.at(-1)!.content).toEqual({ kind: 'text', text: 'Había una vez' })
    await bot.stop()
  })
})
