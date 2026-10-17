import { describe, expect, it } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import type { IProvider, StoredMessage } from '../src/core/provider.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { NamespacedStore } from '../src/store/NamespacedStore.js'
import {
  MockProvider,
  REPLAY_MASKS,
  TRANSCRIPT_FORMAT,
  TRANSCRIPT_VERSION,
  TranscriptFormatError,
  TranscriptMismatchError,
  assertTranscript,
  createRedactionMap,
  createTranscript,
  parseTranscript,
  recordTranscript,
  redactTranscript,
  replayTranscript,
  serializeTranscript,
  transcriptFromMessages,
  transcriptFromStore,
  type Transcript,
} from '../src/testing/index.js'
import * as root from '../src/index.js'

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/** The bot under test, as a defineBot-style factory. `variant` lets tests break it on purpose. */
function supportBot(variant: 'v1' | 'v2' | 'extra' = 'v1') {
  return (provider: IProvider): Bot => {
    const bot = new Bot({ provider })
    bot.when('hola', async (ctx) => {
      await ctx.reply(variant === 'v2' ? '¡Buenas!' : '¡Hola! ¿En qué te ayudo?')
      if (variant === 'extra') await ctx.reply('PS: tenemos ofertas')
    })
    bot.when('menu', async (ctx) => { await ctx.buttons('Elige', [{ id: 'a', title: 'Ventas' }, { id: 'b', title: 'Soporte' }]) })
    bot.use(flow('registrar')
      .ask('¿Tu email?', 'email')
      .say((_ctx, c) => `Te escribiremos a ${String(c.state.email)}`))
    bot.when('pedido', async (ctx) => { await ctx.reply(`Pedido creado ${new Date().toISOString()}`) })
    return bot
  }
}

async function recordSession(drive: (mock: MockProvider) => Promise<void>): Promise<Transcript> {
  const mock = new MockProvider()
  const recorder = recordTranscript(mock)
  const bot = supportBot()(recorder.provider)
  await bot.start()
  await drive(mock)
  await tick(40)
  await bot.stop()
  return recorder.transcript({ name: 'support' })
}

describe('golden transcripts — format', () => {
  it('serializes and parses a versioned transcript', () => {
    const t = createTranscript([
      { dir: 'in', chatId: 'c', senderId: 'c', type: 'text', text: 'hola', t: 0 },
      { dir: 'out', chatId: 'c', kind: 'text', text: 'hi', t: 3 },
    ], { name: 'x' })
    const json = serializeTranscript(t)
    expect(json.endsWith('\n')).toBe(true)
    expect(JSON.parse(json)).toMatchObject({ format: TRANSCRIPT_FORMAT, version: TRANSCRIPT_VERSION, name: 'x' })
    expect(parseTranscript(json)).toEqual(t)
    expect(parseTranscript(JSON.parse(json))).toEqual(t)
  })

  it('rejects malformed input and unknown versions', () => {
    expect(() => parseTranscript('{nope')).toThrow(TranscriptFormatError)
    expect(() => parseTranscript({ format: 'other', version: 1, turns: [] })).toThrow(/format/)
    expect(() => parseTranscript({ format: TRANSCRIPT_FORMAT, version: 99, turns: [] })).toThrow(/version 99/)
    expect(() => parseTranscript({ format: TRANSCRIPT_FORMAT, version: 1, turns: [{ dir: 'x' }] })).toThrow(/dir/)
    expect(() => parseTranscript({ format: TRANSCRIPT_FORMAT, version: 1, turns: [{ dir: 'in', chatId: 'a' }] })).toThrow(/senderId/)
  })

  it('is exported from the root entry point too (recording + redaction)', () => {
    expect(root.recordTranscript).toBe(recordTranscript)
    expect(root.redactTranscript).toBe(redactTranscript)
    expect(root.parseTranscript).toBe(parseTranscript)
  })
})

describe('golden transcripts — recording', () => {
  it('records inbound turns and successful sends with relative times and JSON-safe content', async () => {
    const t = await recordSession(async (mock) => {
      mock.incoming('hola', { from: '573001112233@s.whatsapp.net', pushName: 'Ana' })
      await tick()
      mock.incoming('menu', { from: '573001112233@s.whatsapp.net' })
      await tick()
    })
    expect(t.source).toBe('recorder')
    expect(typeof t.startedAt).toBe('number')
    expect(t.turns.map((turn) => [turn.dir, turn.dir === 'in' ? turn.text : turn.kind])).toEqual([
      ['in', 'hola'], ['out', 'text'], ['in', 'menu'], ['out', 'buttons'],
    ])
    expect(t.turns[0]).toMatchObject({ chatId: '573001112233@s.whatsapp.net', displayName: 'Ana', t: 0 })
    expect(t.turns[1]).toMatchObject({ text: '¡Hola! ¿En qué te ayudo?', content: { kind: 'text', text: '¡Hola! ¿En qué te ayudo?' } })
    expect(t.turns[1].dir === 'out' && t.turns[1].id).toMatch(/^mock-/)
    expect(() => JSON.parse(serializeTranscript(t))).not.toThrow()
  })

  it('serializes binary media as a hash and records interactions', async () => {
    const mock = new MockProvider()
    const recorder = recordTranscript(mock)
    const bot = new Bot({ provider: recorder.provider })
    bot.onMessage(async (ctx) => { await ctx.photo(Buffer.from('png-bytes'), 'foto') })
    await bot.start()
    mock.interaction('btn:a', { from: 'u1' })
    await tick(30)
    await bot.stop()
    const [inbound, out] = recorder.transcript().turns
    expect(inbound).toMatchObject({ dir: 'in', event: 'interaction', text: 'btn:a' })
    expect(out).toMatchObject({ dir: 'out', kind: 'image', text: 'foto', content: { media: { $binary: { bytes: 9 } } } })
  })

  it('drops failed sends, supports pause/resume and clear', async () => {
    const mock = new MockProvider()
    let fail = true
    const send = mock.send.bind(mock)
    mock.send = async (...args) => { if (fail) { fail = false; throw new Error('boom') } return send(...args) }
    const recorder = recordTranscript(mock)
    await recorder.provider.send('c', { kind: 'text', text: 'lost' }).catch(() => undefined)
    await recorder.provider.send('c', { kind: 'text', text: 'kept' })
    recorder.pause()
    await recorder.provider.send('c', { kind: 'text', text: 'paused' })
    recorder.resume()
    expect(recorder.transcript().turns.map((turn) => turn.text)).toEqual(['kept'])
    recorder.clear()
    expect(recorder.transcript().turns).toEqual([])
    expect(mock.outbox.map((o) => o.content.kind === 'text' && o.content.text)).toEqual(['kept', 'paused'])
  })

  it('builds a transcript from a store message log', async () => {
    // Bot namespaces keys in its store; read back through the same namespace.
    const store = new NamespacedStore(new MemoryStore(), { tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'mock', connectionId: 'c' })
    const mock = new MockProvider()
    const bot = new Bot({ provider: mock, store })
    bot.when('hola', async (ctx) => { await ctx.reply('hey') })
    await bot.start()
    mock.incoming('hola', { from: 'chat-1' })
    await tick(30)
    await bot.stop()
    const t = await transcriptFromStore(store, 'chat-1', { name: 'from-store' })
    expect(t.source).toBe('store')
    expect(t.turns).toMatchObject([
      { dir: 'in', chatId: 'chat-1', senderId: 'chat-1', text: 'hola', t: 0 },
      { dir: 'out', chatId: 'chat-1', kind: 'text', text: 'hey' },
    ])
    expect((t.turns[1] as { content?: unknown }).content).toBeUndefined()
  })

  it('orders store messages by timestamp and skips failed / unknown outbound rows', () => {
    const msgs: StoredMessage[] = [
      { ref: { id: 'o1', chatId: 'c' }, chatId: 'c', timestamp: 2000, type: 'text', body: 'b', direction: 'outbound' },
      { ref: { id: 'i1', chatId: 'c' }, chatId: 'c', senderId: 's', timestamp: 1000, type: 'text', body: 'a', direction: 'inbound' },
      { ref: { id: 'o2', chatId: 'c' }, chatId: 'c', timestamp: 3000, type: 'text', body: 'x', direction: 'outbound', status: 'failed' },
      { ref: { id: 'o3', chatId: 'c' }, chatId: 'c', timestamp: 3500, type: 'unknown', fromMe: true },
    ]
    const t = transcriptFromMessages(msgs)
    expect(t.turns.map((turn) => [turn.dir, turn.text, turn.t])).toEqual([['in', 'a', 0], ['out', 'b', 1000]])
    expect(transcriptFromMessages(msgs, { includeFailed: true }).turns).toHaveLength(3)
  })
})

describe('golden transcripts — redaction', () => {
  const raw = createTranscript([
    { dir: 'in', chatId: '573001112233@s.whatsapp.net', senderId: '573001112233@s.whatsapp.net', type: 'text', text: 'mi correo es ana@mail.com y mi cel +57 300 111 2233', displayName: 'Ana Pérez', id: 'WAMSG1', t: 0 },
    { dir: 'out', chatId: '573001112233@s.whatsapp.net', kind: 'text', text: 'Gracias, te escribo a ana@mail.com', content: { kind: 'text', text: 'Gracias, te escribo a ana@mail.com' }, id: 'mock-9', t: 5 },
    { dir: 'in', chatId: 'grp-123@g.us', senderId: '573001112233@s.whatsapp.net', type: 'text', text: 'pedido ORD-7781', isGroup: true, id: 'WAMSG2', t: 9 },
    { dir: 'out', chatId: 'grp-123@g.us', kind: 'text', text: 'Hola 573001112233@s.whatsapp.net, tu pedido ORD-7781 sale hoy', id: 'mock-10', t: 12 },
  ], { name: 'pii', startedAt: 1_760_000_000_000 })

  it('replaces ids, emails and phones with stable placeholders and drops names/start time', () => {
    const t = redactTranscript(raw, { rules: [{ name: 'order', pattern: /ORD-\d+/ }] })
    expect(t.redacted).toBe(true)
    expect(t.startedAt).toBeUndefined()
    expect(t.turns[0]).toEqual({ dir: 'in', chatId: '<user:1>', senderId: '<user:1>', type: 'text', text: 'mi correo es <email:1> y mi cel <phone:1>', id: '<msg:1>', t: 0 })
    expect(t.turns[1]).toMatchObject({ chatId: '<user:1>', text: 'Gracias, te escribo a <email:1>', content: { text: 'Gracias, te escribo a <email:1>' }, id: '<msg:2>' })
    expect(t.turns[2]).toMatchObject({ chatId: '<chat:1>', senderId: '<user:1>', text: 'pedido <order:1>' })
    expect(t.turns[3]).toMatchObject({ text: 'Hola <user:1>, tu pedido <order:1> sale hoy' })
    expect(JSON.stringify(t)).not.toMatch(/573001112233|ana@mail|Ana Pérez|7781/)
    // input untouched
    expect(raw.turns[0].chatId).toBe('573001112233@s.whatsapp.net')
  })

  it('is deterministic and idempotent', () => {
    const once = redactTranscript(raw)
    expect(redactTranscript(raw)).toEqual(once)
    expect(redactTranscript(once)).toEqual(once)
  })

  it('shares placeholders across transcripts with a redaction map', () => {
    const map = createRedactionMap()
    const a = redactTranscript(raw, { map })
    const b = redactTranscript(createTranscript([
      { dir: 'in', chatId: 'other', senderId: 'other', type: 'text', text: 'x' },
      { dir: 'in', chatId: '573001112233@s.whatsapp.net', senderId: '573001112233@s.whatsapp.net', type: 'text', text: 'ana@mail.com' },
    ]), { map })
    expect(a.turns[0].chatId).toBe('<user:1>')
    expect(b.turns[0].chatId).toBe('<user:2>')
    expect(b.turns[1]).toMatchObject({ chatId: '<user:1>', text: '<email:1>' })
  })

  it('honours switches and allow-lists', () => {
    const t = redactTranscript(raw, { ids: false, emails: false, allow: ['+57 300 111 2233'], dropDisplayNames: false, dropStartedAt: false })
    expect(t.turns[0]).toMatchObject({ chatId: '573001112233@s.whatsapp.net', text: 'mi correo es ana@mail.com y mi cel +57 300 111 2233', displayName: 'Ana Pérez' })
    expect(t.startedAt).toBe(1_760_000_000_000)
    expect(() => redactTranscript(raw, { rules: [{ name: 'Bad Name', pattern: /x/ }] })).toThrow(/rule name/)
  })
})

describe('golden transcripts — replay', () => {
  async function golden(): Promise<Transcript> {
    const recorded = await recordSession(async (mock) => {
      const from = '573001112233@s.whatsapp.net'
      mock.incoming('hola', { from })
      await tick()
      mock.incoming('registrar', { from })
      await tick()
      mock.incoming('ana@mail.com', { from })
      await tick()
      mock.incoming('menu', { from })
      await tick()
    })
    // Round-trip through the file format, as a committed golden would.
    return parseTranscript(serializeTranscript(redactTranscript(recorded)))
  }

  it('replays a redacted golden cleanly against the same bot', async () => {
    const t = await golden()
    const result = await replayTranscript(t, supportBot())
    expect(result.report()).toBe('✓ transcript "support" matches')
    expect(result.ok).toBe(true)
    expect(result.actual.turns.filter((turn) => turn.dir === 'out').map((turn) => turn.text)).toEqual([
      '¡Hola! ¿En qué te ayudo?', '¿Tu email?', 'Te escribiremos a <email:1>', 'Elige',
    ])
    await expect(assertTranscript(t, supportBot())).resolves.toMatchObject({ ok: true })
  })

  it('reports a text mismatch with the triggering turn', async () => {
    const result = await replayTranscript(await golden(), supportBot('v2'))
    expect(result.ok).toBe(false)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0]).toMatchObject({ kind: 'mismatch', step: 0, trigger: 'hola', field: 'text', position: 0 })
    expect(result.report()).toContain('- expected text: "¡Hola! ¿En qué te ayudo?"')
    expect(result.report()).toContain('+ actual   text: "¡Buenas!"')
    await expect(assertTranscript(await golden(), supportBot('v2'))).rejects.toBeInstanceOf(TranscriptMismatchError)
  })

  it('reports unexpected and missing replies', async () => {
    const extra = await replayTranscript(await golden(), supportBot('extra'))
    expect(extra.diffs).toMatchObject([{ kind: 'unexpected', step: 0, actual: { text: 'PS: tenemos ofertas' } }])

    const t = createTranscript([
      { dir: 'in', chatId: 'u', senderId: 'u', type: 'text', text: 'hola' },
      { dir: 'out', chatId: 'u', kind: 'text', text: '¡Hola! ¿En qué te ayudo?' },
      { dir: 'out', chatId: 'u', kind: 'text', text: 'never sent' },
    ])
    const missing = await replayTranscript(t, supportBot(), { stepTimeoutMs: 200 })
    expect(missing.diffs).toMatchObject([{ kind: 'missing', position: 1, expected: { text: 'never sent' } }])
  })

  it('compares full content and supports ignored fields', async () => {
    const t = createTranscript([
      { dir: 'in', chatId: 'u', senderId: 'u', type: 'text', text: 'menu' },
      { dir: 'out', chatId: 'u', kind: 'buttons', text: 'Elige', content: { kind: 'buttons', text: 'Elige', buttons: [{ id: 'a', title: 'Ventas' }, { id: 'b', title: 'Quejas' }] } },
    ])
    const strict = await replayTranscript(t, supportBot())
    expect(strict.diffs).toMatchObject([{ kind: 'mismatch', field: 'content.buttons.1.title' }])
    expect((await replayTranscript(t, supportBot(), { ignoreContentFields: ['buttons.1.title'] })).ok).toBe(true)
    expect((await replayTranscript(t, supportBot(), { compareContent: false })).ok).toBe(true)
  })

  it('tolerates volatile values with masks and whitespace normalisation', async () => {
    const t = createTranscript([
      { dir: 'in', chatId: 'u', senderId: 'u', type: 'text', text: 'pedido' },
      { dir: 'out', chatId: 'u', kind: 'text', text: 'Pedido   creado 2020-01-01T00:00:00.000Z' },
    ])
    expect((await replayTranscript(t, supportBot())).ok).toBe(false)
    expect((await replayTranscript(t, supportBot(), { masks: [REPLAY_MASKS.isoDate] })).ok).toBe(true)
    expect((await replayTranscript(t, supportBot(), { masks: [REPLAY_MASKS.isoDate], normalizeWhitespace: false })).ok).toBe(false)
  })

  it('ignores ids and timestamps by default; tolerance options make them count', async () => {
    const t = createTranscript([
      { dir: 'in', chatId: 'u', senderId: 'u', type: 'text', text: 'hola', t: 0 },
      { dir: 'out', chatId: 'u', kind: 'text', text: '¡Hola! ¿En qué te ayudo?', id: 'recorded-id', t: 60_000 },
    ])
    expect((await replayTranscript(t, supportBot())).ok).toBe(true)
    const timing = await replayTranscript(t, supportBot(), { timestamps: { toleranceMs: 1000 } })
    expect(timing.diffs).toMatchObject([{ kind: 'timing', field: 't' }])
    expect((await replayTranscript(t, supportBot(), { timestamps: { toleranceMs: 120_000 } })).ok).toBe(true)
    const ids = await replayTranscript(t, supportBot(), { compareIds: true })
    expect(ids.diffs).toMatchObject([{ kind: 'mismatch', field: 'id' }])
  })

  it('handles several chats: per-chat ordering by default, strict on demand', async () => {
    const t = createTranscript([
      { dir: 'in', chatId: 'grp', senderId: 'u1', type: 'text', text: 'hola', isGroup: true },
      { dir: 'out', chatId: 'grp', kind: 'text', text: '¡Hola! ¿En qué te ayudo?' },
      { dir: 'in', chatId: 'dm', senderId: 'dm', type: 'text', text: 'hola' },
      { dir: 'out', chatId: 'dm', kind: 'text', text: '¡Hola! ¿En qué te ayudo?' },
    ])
    expect((await replayTranscript(t, supportBot())).ok).toBe(true)
    expect((await replayTranscript(t, supportBot(), { order: 'strict' })).ok).toBe(true)
    const wrongChat = createTranscript([
      { dir: 'in', chatId: 'a', senderId: 'a', type: 'text', text: 'hola' },
      { dir: 'out', chatId: 'b', kind: 'text', text: '¡Hola! ¿En qué te ayudo?' },
    ])
    expect((await replayTranscript(wrongChat, supportBot(), { order: 'strict', stepTimeoutMs: 200 })).diffs).toMatchObject([{ field: 'chatId' }])
    const perChat = await replayTranscript(wrongChat, supportBot(), { stepTimeoutMs: 200 })
    expect(perChat.diffs.map((d) => d.kind).sort()).toEqual(['missing', 'unexpected'])
  })

  it('replays interactions and stops the bot afterwards', async () => {
    let stopped = false
    const t = createTranscript([
      { dir: 'in', event: 'interaction', chatId: 'u', senderId: 'u', type: 'button', text: 'btn:x' },
      { dir: 'out', chatId: 'u', kind: 'text', text: 'got btn:x' },
    ])
    const result = await replayTranscript(t, (provider) => {
      const bot = new Bot({ provider })
      bot.onMessage(async (ctx) => { await ctx.reply(`got ${ctx.body}`) })
      const stop = bot.stop.bind(bot)
      bot.stop = async (...args) => { stopped = true; return stop(...args) }
      return bot
    })
    expect(result.ok).toBe(true)
    expect(stopped).toBe(true)
  })
})
