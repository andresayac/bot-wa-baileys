/**
 * pricing — parse the `pricing` / `conversation` objects Meta attaches to
 * WhatsApp Cloud API status webhooks, and aggregate them into per-chat usage
 * counters.
 *
 * Since 2025-07-01 WhatsApp bills per delivered template message ("PMP",
 * per-message pricing): every status carries
 * `pricing: { billable, pricing_model: 'PMP', category, type }` where `type`
 * is `regular`, `free_customer_service` or `free_entry_point`. Before that,
 * conversation-based pricing ("CBP") sent `pricing.category` plus a
 * `conversation` object. Both shapes are accepted.
 */

import type { ChatId } from '@bot-wa/core'

/* --- Raw webhook shapes --------------------------------------------------- */

export interface GraphPricing {
  /** Whether Meta charges for this message. */
  billable?: boolean
  /** `PMP` (per-message, since 2025-07) or `CBP` (legacy conversation-based). */
  pricing_model?: string
  /** `marketing`, `utility`, `authentication`, `authentication_international`, `service`, `marketing_lite`, ... */
  category?: string
  /** PMP only: `regular`, `free_customer_service` or `free_entry_point`. */
  type?: string
}

export interface GraphConversation {
  id?: string
  /** Epoch seconds. */
  expiration_timestamp?: string | number
  origin?: { type?: string }
}

/* --- Normalized shapes ---------------------------------------------------- */

/** Normalized `pricing` object, exposed as `DeliveryStatus.platformData.pricing`. */
export interface StatusPricing {
  billable: boolean
  pricingModel?: string
  category?: string
  type?: string
}

/** Normalized `conversation` object, exposed as `DeliveryStatus.platformData.conversation`. */
export interface StatusConversation {
  id?: string
  originType?: string
  /** Epoch ms. */
  expiresAt?: number
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** Normalize a raw `pricing` object; `undefined` when absent/malformed. */
export function parsePricing(raw: unknown): StatusPricing | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as GraphPricing
  const pricingModel = str(p.pricing_model)
  const category = str(p.category)
  const type = str(p.type)
  if (typeof p.billable !== 'boolean' && !pricingModel && !category && !type) return undefined
  return {
    // Meta always sends `billable`; when missing, only a `regular` PMP message is billed.
    billable: typeof p.billable === 'boolean' ? p.billable : type === 'regular',
    ...(pricingModel ? { pricingModel } : {}),
    ...(category ? { category } : {}),
    ...(type ? { type } : {}),
  }
}

/** Normalize a raw `conversation` object; `undefined` when absent/malformed. */
export function parseConversation(raw: unknown): StatusConversation | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const c = raw as GraphConversation
  const id = str(c.id)
  const originType = str(c.origin?.type)
  const exp = Number(c.expiration_timestamp)
  const expiresAt = Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  if (!id && !originType && expiresAt === undefined) return undefined
  return {
    ...(id ? { id } : {}),
    ...(originType ? { originType } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

/** `DeliveryStatus.platformData` for a status item, or undefined when it has no billing info. */
export function statusPlatformData(st: { pricing?: unknown; conversation?: unknown }): Record<string, unknown> | undefined {
  const pricing = parsePricing(st.pricing)
  const conversation = parseConversation(st.conversation)
  if (!pricing && !conversation) return undefined
  return { ...(pricing ? { pricing } : {}), ...(conversation ? { conversation } : {}) }
}

/** Read the normalized pricing back from a status event's platformData. */
export function pricingOf(platformData: Record<string, unknown> | undefined): StatusPricing | undefined {
  const p = platformData?.pricing
  return p && typeof p === 'object' && typeof (p as StatusPricing).billable === 'boolean' ? (p as StatusPricing) : undefined
}

/* --- Usage tracker -------------------------------------------------------- */

export interface UsageCounter {
  /** Messages with a pricing object (each message counted once). */
  messages: number
  billable: number
  free: number
  /** Sum of the configured rates over billable messages (0 without `rates`). */
  estimatedCost: number
}

export interface UsageSummary extends UsageCounter {
  /** Keyed by pricing category (`unknown` when Meta sent none). */
  byCategory: Record<string, UsageCounter>
}

/** One counted message, passed to a rate function. */
export interface UsageEntry {
  chatId: ChatId
  messageId: string
  pricing: StatusPricing
}

export interface UsageTrackerOptions {
  /**
   * Price per billable message: a map by category (e.g. `{ marketing: 0.0625 }`)
   * or a function (rates vary by recipient country). Unknown → 0.
   */
  rates?: Record<string, number> | ((entry: UsageEntry) => number | undefined)
  /** Max chats with per-chat counters (least recently updated evicted). Default 10 000. */
  maxChats?: number
  /** Max message ids remembered to count each message once. Default 10 000. */
  maxTrackedMessages?: number
}

const emptyCounter = (): UsageCounter => ({ messages: 0, billable: 0, free: 0, estimatedCost: 0 })
const emptySummary = (): UsageSummary => ({ ...emptyCounter(), byCategory: {} })

function add(counter: UsageCounter, billable: boolean, cost: number): void {
  counter.messages += 1
  if (billable) { counter.billable += 1; counter.estimatedCost += cost } else counter.free += 1
}

function cloneSummary(s: UsageSummary): UsageSummary {
  const byCategory: Record<string, UsageCounter> = {}
  for (const [k, v] of Object.entries(s.byCategory)) byCategory[k] = { ...v }
  return { messages: s.messages, billable: s.billable, free: s.free, estimatedCost: s.estimatedCost, byCategory }
}

/**
 * Aggregates the pricing of status webhooks per chat and per category. Meta
 * repeats the pricing object on `sent`, `delivered` and `read`; each message
 * id is counted once. Memory is bounded (`maxChats`, `maxTrackedMessages`);
 * the global {@link totals} survive per-chat eviction.
 */
export class UsageTracker {
  private readonly chatsMap = new Map<ChatId, UsageSummary>()
  private readonly seen = new Set<string>()
  private total: UsageSummary = emptySummary()
  private readonly maxChats: number
  private readonly maxSeen: number

  constructor(private readonly options: UsageTrackerOptions = {}) {
    this.maxChats = Math.max(1, options.maxChats ?? 10_000)
    this.maxSeen = Math.max(1, options.maxTrackedMessages ?? 10_000)
  }

  /** Count one message. Returns false when this message id was already counted. */
  record(chatId: ChatId, messageId: string, pricing: StatusPricing): boolean {
    if (this.seen.has(messageId)) return false
    this.seen.add(messageId)
    if (this.seen.size > this.maxSeen) this.seen.delete(this.seen.values().next().value as string)

    const cost = pricing.billable ? this.rate({ chatId, messageId, pricing }) : 0
    const category = pricing.category ?? 'unknown'
    let chat = this.chatsMap.get(chatId)
    if (chat) this.chatsMap.delete(chatId)
    else chat = emptySummary()
    this.chatsMap.set(chatId, chat)
    if (this.chatsMap.size > this.maxChats) this.chatsMap.delete(this.chatsMap.keys().next().value as ChatId)

    for (const summary of [chat, this.total]) {
      add(summary, pricing.billable, cost)
      add((summary.byCategory[category] ??= emptyCounter()), pricing.billable, cost)
    }
    return true
  }

  private rate(entry: UsageEntry): number {
    const rates = this.options.rates
    if (!rates) return 0
    const value = typeof rates === 'function' ? rates(entry) : rates[entry.pricing.category ?? 'unknown']
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  /** Usage of one chat (a copy), or undefined when nothing was counted / it was evicted. */
  forChat(chatId: ChatId): UsageSummary | undefined {
    const s = this.chatsMap.get(chatId)
    return s ? cloneSummary(s) : undefined
  }

  /** Usage across every chat since start / the last {@link reset}. */
  totals(): UsageSummary {
    return cloneSummary(this.total)
  }

  /** Chats with per-chat counters, least recently updated first. */
  chats(): ChatId[] {
    return [...this.chatsMap.keys()]
  }

  /** Clear one chat's counters (totals kept), or everything when no chat is given. */
  reset(chatId?: ChatId): void {
    if (chatId !== undefined) { this.chatsMap.delete(chatId); return }
    this.chatsMap.clear()
    this.seen.clear()
    this.total = emptySummary()
  }
}
