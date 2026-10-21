/**
 * Inbound id contract: `ref.id` / `interactionId` must be unique per logical
 * inbound event and stable across webhook redelivery (core dedupes by `chatId`
 * + that id), or empty when the provider cannot guarantee it. A payload with no
 * `mid` falls back to `ig_<timestamp>`; with no timestamp either, it must not
 * collapse into a shared constant (`ig_0`) that drops later events as duplicates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Bot } from '@botmesh/core'
import { InstagramProvider } from '../src/InstagramProvider.js'
import { parseInbound, type IgMessagingEvent, type IgWebhookBody } from '../src/parseInbound.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

const wrap = (...messaging: IgMessagingEvent[]): IgWebhookBody => ({
  object: 'page',
  entry: [{ id: 'page-id', time: 1, messaging }],
})

const text = (timestamp?: number): IgMessagingEvent => ({
  sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp, message: { text: 'hola' },
})
const postback = (timestamp?: number): IgMessagingEvent => ({
  sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp, postback: { payload: 'START', title: 'Start' },
})

function idOf(ev: IgMessagingEvent): string {
  const [e] = parseInbound(wrap(ev))
  if (e?.kind === 'message') return e.message.ref.id
  if (e?.kind === 'interaction') {
    expect(e.interaction.ref.id).toBe(e.interaction.interactionId)
    return e.interaction.interactionId
  }
  throw new Error(`unexpected event ${e?.kind}`)
}

describe('parseInbound (Instagram) — ids without a mid', () => {
  it('falls back to a per-event, redelivery-stable id when the timestamp is known', () => {
    expect(idOf(text(1_700_000_000_000))).toBe(idOf(text(1_700_000_000_000)))
    expect(idOf(text(1_700_000_000_000))).not.toBe(idOf(text(1_700_000_000_001)))
    expect(idOf(postback(1_700_000_000_000))).not.toBe(idOf(postback(1_700_000_000_001)))
  })

  it('without mid and timestamp the id is empty (never deduplicated), not a shared "ig_0"', () => {
    expect(idOf(text(undefined))).toBe('')
    expect(idOf(postback(undefined))).toBe('')
  })
})

describe('InstagramProvider + Bot default dedupe', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network call') }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('repeated id-less events (no mid, no timestamp) all reach handlers', async () => {
    const provider = new InstagramProvider({ accessToken: 'TOK', verifyToken: 'vt', allowUnsignedWebhooks: true })
    const bot = new Bot({ provider })
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })
    await bot.start()
    provider.ingest(wrap(text(undefined)))
    await tick()
    provider.ingest(wrap(text(undefined)))
    await tick()
    provider.ingest(wrap(postback(undefined)))
    await tick()
    provider.ingest(wrap(postback(undefined)))
    await tick()
    expect(seen).toEqual(['hola', 'hola', 'START', 'START'])
    await bot.stop()
  })
})
