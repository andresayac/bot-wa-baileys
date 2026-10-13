/**
 * Inbound id contract: `ref.id` / `interactionId` must be unique per logical
 * inbound event and stable across webhook redelivery, because core dedupes
 * inbound events by `chatId` + that id (BotConfig.dedupe, on by default).
 * Referral and opt-in events carry no `mid`, so the provider must not fall back
 * to a per-user constant (the PSID / user_ref) — that silently drops every later
 * referral/opt-in of the same user as a "duplicate".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Bot } from '@bot-wa/core'
import { MessengerProvider } from '../src/MessengerProvider.js'
import { parseInbound, type MessagingEvent, type PageWebhookBody } from '../src/parseInbound.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

function page(...messaging: MessagingEvent[]): PageWebhookBody {
  return { object: 'page', entry: [{ id: 'PG', time: 1, messaging }] }
}

const referral = (timestamp?: number): MessagingEvent => ({
  sender: { id: 'PSID-1' }, recipient: { id: 'PG' }, timestamp,
  referral: { ref: 'promo', source: 'SHORTLINK', type: 'OPEN_THREAD' },
})

const optin = (timestamp?: number): MessagingEvent => ({
  sender: { id: 'PSID-1' }, recipient: { id: 'PG' }, timestamp,
  optin: { ref: 'checkbox', user_ref: 'UREF-1', payload: 'OPTIN' },
})

function interactionId(ev: MessagingEvent): string {
  const [e] = parseInbound(page(ev))
  if (e?.kind !== 'interaction') throw new Error(`expected an interaction, got ${e?.kind}`)
  expect(e.interaction.ref.id).toBe(e.interaction.interactionId)
  return e.interaction.interactionId
}

describe('parseInbound — per-event ids for referral / opt-in', () => {
  it('two referrals of the same user and ref get distinct ids; a redelivery keeps its id', () => {
    const first = interactionId(referral(1_700_000_000_000))
    const again = interactionId(referral(1_700_300_000_000))
    expect(first).not.toBe(again)
    expect(first).not.toBe('PSID-1') // never the sender PSID
    expect(interactionId(referral(1_700_000_000_000))).toBe(first) // same webhook redelivered
  })

  it('two opt-ins of the same user_ref get distinct ids; a redelivery keeps its id', () => {
    const first = interactionId(optin(1_700_000_000_000))
    const again = interactionId(optin(1_700_300_000_000))
    expect(first).not.toBe(again)
    expect(first).not.toBe('UREF-1')
    expect(interactionId(optin(1_700_000_000_000))).toBe(first)
  })

  it('a referral and an opt-in in the same millisecond do not share an id', () => {
    expect(interactionId(referral(1_700_000_000_000))).not.toBe(interactionId(optin(1_700_000_000_000)))
  })

  it('without a timestamp the id is empty, so core never deduplicates the event', () => {
    expect(interactionId(referral(undefined))).toBe('')
    expect(interactionId(optin(undefined))).toBe('')
  })
})

describe('MessengerProvider + Bot default dedupe', () => {
  beforeEach(() => {
    // No network: nothing in these tests should send, but fail loudly if it does.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network call') }))
  })
  afterEach(() => vi.unstubAllGlobals())

  async function botWithMessenger() {
    const provider = new MessengerProvider({ accessToken: 'TOK', verifyToken: 'vt', allowUnsignedWebhooks: true })
    const bot = new Bot({ provider })
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(`${ctx.from}:${ctx.body}`) })
    await bot.start()
    return { bot, provider, seen }
  }

  it('a user who re-opens the same referral link days later is handled both times', async () => {
    const { bot, provider, seen } = await botWithMessenger()
    provider.ingest(page(referral(1_700_000_000_000)))
    await tick()
    provider.ingest(page(referral(1_700_300_000_000)))
    await tick()
    expect(seen).toEqual(['PSID-1:promo', 'PSID-1:promo'])
    await bot.stop()
  })

  it('a user who opts in again with the same payload is handled both times', async () => {
    const { bot, provider, seen } = await botWithMessenger()
    provider.ingest(page(optin(1_700_000_000_000)))
    await tick()
    provider.ingest(page(optin(1_700_300_000_000)))
    await tick()
    expect(seen).toEqual(['PSID-1:OPTIN', 'PSID-1:OPTIN'])
    await bot.stop()
  })

  it('a webhook retry of the same referral still runs handlers once', async () => {
    const { bot, provider, seen } = await botWithMessenger()
    provider.ingest(page(referral(1_700_000_000_000)))
    await tick()
    provider.ingest(page(referral(1_700_000_000_000))) // Meta redelivers the identical event
    await tick()
    expect(seen).toEqual(['PSID-1:promo'])
    await bot.stop()
  })
})
