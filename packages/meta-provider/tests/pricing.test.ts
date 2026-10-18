import { describe, it, expect } from 'vitest'
import type { DeliveryStatus, InboundEvent } from '@bot-wa/core'
import { parseInbound } from '../src/parseInbound.js'
import { UsageTracker, parsePricing, parseConversation, pricingOf } from '../src/pricing.js'
import { fixture } from './support-fixtures.js'

const statuses = (events: InboundEvent[]): DeliveryStatus[] =>
  events.flatMap((e) => (e.kind === 'status' ? [e.status] : []))

describe('status pricing → platformData', () => {
  it('parses PMP per-message pricing of a billable marketing template', () => {
    const [st] = statuses(parseInbound(fixture('status-pmp-marketing')))
    expect(st.status).toBe('delivered')
    expect(st.platformData).toEqual({
      pricing: { billable: true, pricingModel: 'PMP', category: 'marketing', type: 'regular' },
    })
  })

  it('parses free customer-service PMP statuses', () => {
    const list = statuses(parseInbound(fixture('status-pmp-free-service')))
    expect(list.map((s) => pricingOf(s.platformData))).toEqual([
      { billable: false, pricingModel: 'PMP', category: 'utility', type: 'free_customer_service' },
      { billable: false, pricingModel: 'PMP', category: 'service', type: 'free_customer_service' },
    ])
  })

  it('parses legacy CBP pricing plus the conversation object', () => {
    const [st] = statuses(parseInbound(fixture('status-cbp-conversation')))
    expect(st.platformData).toEqual({
      pricing: { billable: true, pricingModel: 'CBP', category: 'utility' },
      conversation: { id: 'CONVERSATION_ID', originType: 'utility', expiresAt: 1719086400_000 },
    })
  })

  it('omits platformData when the status carries no billing info', () => {
    const [st] = statuses(parseInbound(fixture('status-failed-131047')))
    expect(st.status).toBe('failed')
    expect(st.error).toEqual({ code: 131047, message: 'Re-engagement message' })
    expect(st.platformData).toBeUndefined()
  })

  it('tolerates malformed pricing / conversation objects', () => {
    expect(parsePricing(null)).toBeUndefined()
    expect(parsePricing('PMP')).toBeUndefined()
    expect(parsePricing({})).toBeUndefined()
    expect(parsePricing({ billable: 'yes', category: 5 })).toBeUndefined()
    expect(parsePricing({ type: 'regular' })).toEqual({ billable: true, type: 'regular' })
    expect(parseConversation({ expiration_timestamp: 'never' })).toBeUndefined()
    expect(pricingOf({ pricing: { category: 'x' } })).toBeUndefined()
  })
})

describe('UsageTracker', () => {
  const mkt = { billable: true, pricingModel: 'PMP', category: 'marketing', type: 'regular' }
  const svc = { billable: false, pricingModel: 'PMP', category: 'service', type: 'free_customer_service' }

  it('aggregates per chat and category, counting each message once', () => {
    const usage = new UsageTracker({ rates: { marketing: 0.05 } })
    expect(usage.record('A', 'm1', mkt)).toBe(true)
    expect(usage.record('A', 'm1', mkt)).toBe(false) // delivered/read repeat the pricing
    usage.record('A', 'm2', svc)
    usage.record('B', 'm3', mkt)
    expect(usage.forChat('A')).toEqual({
      messages: 2, billable: 1, free: 1, estimatedCost: 0.05,
      byCategory: {
        marketing: { messages: 1, billable: 1, free: 0, estimatedCost: 0.05 },
        service: { messages: 1, billable: 0, free: 1, estimatedCost: 0 },
      },
    })
    const totals = usage.totals()
    expect(totals.messages).toBe(3)
    expect(totals.estimatedCost).toBeCloseTo(0.1)
    expect(totals.byCategory.marketing.billable).toBe(2)
  })

  it('accepts a rate function (e.g. per-country pricing)', () => {
    const usage = new UsageTracker({ rates: ({ chatId }) => (chatId.startsWith('57') ? 0.0125 : 0.025) })
    usage.record('573001', 'x1', mkt)
    usage.record('1555', 'x2', mkt)
    expect(usage.totals().estimatedCost).toBeCloseTo(0.0375)
  })

  it('is bounded: evicts least recently updated chats but keeps totals', () => {
    const usage = new UsageTracker({ maxChats: 2, maxTrackedMessages: 2 })
    usage.record('A', 'a', mkt)
    usage.record('B', 'b', mkt)
    usage.record('C', 'c', mkt)
    expect(usage.chats()).toEqual(['B', 'C'])
    expect(usage.forChat('A')).toBeUndefined()
    expect(usage.totals().messages).toBe(3)
    // 'a' fell out of the dedupe window → would be counted again (documented bound).
    expect(usage.record('A', 'a', mkt)).toBe(true)
  })

  it('returns copies and supports reset', () => {
    const usage = new UsageTracker()
    usage.record('A', 'a', mkt)
    const snap = usage.forChat('A')!
    snap.messages = 99
    expect(usage.forChat('A')!.messages).toBe(1)
    usage.reset('A')
    expect(usage.forChat('A')).toBeUndefined()
    expect(usage.totals().messages).toBe(1)
    usage.reset()
    expect(usage.totals().messages).toBe(0)
  })
})
