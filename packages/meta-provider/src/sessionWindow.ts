/**
 * sessionWindow — WhatsApp Cloud API 24-hour customer-service window manager.
 *
 * Free-form (non-template) messages can only be sent within 24 h of the
 * user's last inbound message; outside it Meta rejects them with 131047
 * (mapped to `OutsideSessionWindowError`). This manager:
 *
 * - remembers each chat's last inbound time in a pluggable
 *   {@link SessionWindowStore} (default: bounded in-memory);
 * - when a free-form send fails with `OutsideSessionWindowError` — or before
 *   even trying, when the window is known closed (`proactive`) — sends a
 *   configured approved template to reopen the conversation;
 * - queues the original content and retries it once the user replies,
 *   reporting every outcome through `onReport`.
 *
 * The pending queue holds the original `OutboundContent` (which may carry
 * buffers/streams), so it is always in memory and bounded; only the window
 * state goes through the store.
 */

import {
  OutsideSessionWindowError,
  type ChatId,
  type OutboundContent,
  type SendOptions,
  type SendResult,
} from '@bot-wa/core'
import type { MaybePromise } from './identity.js'

/** Graph error code for "re-engagement message" (outside the 24 h window). */
export const SESSION_WINDOW_ERROR_CODE = 131047

/** Default customer-service window: 24 h. */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000

/** Inbound timestamps up to this much older than a recorded close still reopen the window. */
const INBOUND_SKEW_MS = 60_000

/* --- Store ---------------------------------------------------------------- */

/** Persisted window state of one chat. All times are epoch ms. */
export interface SessionWindowState {
  /** Time of the user's last inbound message. */
  lastInboundAt?: number
  /** Time Meta last reported the window closed (131047), if after `lastInboundAt`. */
  closedAt?: number
}

/**
 * Where window state is kept. Sync or async; implement it over Redis/SQL to
 * keep window state across restarts and processes.
 */
export interface SessionWindowStore {
  get(chatId: ChatId): MaybePromise<SessionWindowState | undefined>
  set(chatId: ChatId, state: SessionWindowState): MaybePromise<void>
  delete(chatId: ChatId): MaybePromise<void>
}

export interface MemorySessionWindowStoreOptions {
  /** Max chats remembered (least recently written evicted). Default 10 000. */
  maxChats?: number
}

/** Bounded in-memory {@link SessionWindowStore} (lost on restart). */
export class MemorySessionWindowStore implements SessionWindowStore {
  private readonly map = new Map<ChatId, SessionWindowState>()
  private readonly max: number

  constructor(options: MemorySessionWindowStoreOptions = {}) {
    this.max = Math.max(1, options.maxChats ?? 10_000)
  }

  get(chatId: ChatId): SessionWindowState | undefined {
    const s = this.map.get(chatId)
    return s ? { ...s } : undefined
  }

  set(chatId: ChatId, state: SessionWindowState): void {
    this.map.delete(chatId)
    this.map.set(chatId, { ...state })
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as ChatId)
  }

  delete(chatId: ChatId): void {
    this.map.delete(chatId)
  }

  get size(): number {
    return this.map.size
  }
}

/* --- Options & reports ---------------------------------------------------- */

/** An approved Cloud API template (`OutboundContent` of kind `template`). */
export type SessionTemplate = Extract<OutboundContent, { kind: 'template' }>

/** Why the manager is reopening a chat. */
export type ReopenReason = 'error' | 'proactive' | 'status'

export interface ReopenContext {
  chatId: ChatId
  /** The free-form content that could not be sent. */
  content: OutboundContent
  reason: ReopenReason
  /** Last inbound time known for the chat (epoch ms). */
  lastInboundAt?: number
}

/** Picks the reopen template for a chat/content; `undefined` → do not reopen. */
export type ReopenTemplateResolver = (ctx: ReopenContext) => MaybePromise<SessionTemplate | undefined>

export type SessionReportOutcome =
  /** Content queued; a reopen template was sent (or already pending). */
  | 'queued'
  /** Reopen template sent; content not queued (`retryOnReply: false`). */
  | 'reopened'
  /** Queued content delivered after the user replied. */
  | 'sent'
  /** Queued content failed again on retry. */
  | 'failed'
  /** Queued content discarded: older than `pendingTtlMs` when the user replied. */
  | 'expired'
  /** Queued content discarded: the chat's queue or the chat table was full. */
  | 'dropped'
  /** No template configured/resolved for this content: nothing reopened. */
  | 'no-template'
  /** The reopen template itself failed to send. */
  | 'reopen-failed'

export interface SessionReport {
  chatId: ChatId
  outcome: SessionReportOutcome
  reason?: ReopenReason
  /** The original free-form content (absent for `reopened`/`reopen-failed` of a status-only failure). */
  content?: OutboundContent
  template?: SessionTemplate
  /** The retried send (outcome `sent`) or the reopen template send (`queued`/`reopened`). */
  result?: SendResult<unknown>
  error?: unknown
}

export interface SessionWindowOptions {
  /** Window state store. Default: bounded {@link MemorySessionWindowStore}. */
  store?: SessionWindowStore
  /** Window length in ms. Default 24 h. */
  windowMs?: number
  /**
   * When the window is known closed (last inbound older than `windowMs`, or
   * Meta reported 131047 since), skip the doomed free-form send and go
   * straight to reopen + queue. Only applies when a template resolves; an
   * unknown chat is never treated as closed. Default true.
   */
  proactive?: boolean
  /** Reopen template for any content kind, or a resolver callback. */
  reopenTemplate?: SessionTemplate | ReopenTemplateResolver
  /** Reopen template per content kind; takes precedence over `reopenTemplate`. */
  reopenTemplateByKind?: Partial<Record<OutboundContent['kind'], SessionTemplate>>
  /** Queue the original content and retry it when the user replies. Default true. */
  retryOnReply?: boolean
  /** Max queued sends per chat (oldest dropped). Default 20. */
  maxPendingPerChat?: number
  /** Max chats with queued sends (oldest chat's queue dropped). Default 1 000. */
  maxPendingChats?: number
  /** Queued sends older than this are discarded on reply. Default 24 h. */
  pendingTtlMs?: number
  /**
   * What `send()` does after reopening: `'reject'` (default) throws a
   * {@link SessionWindowReopenedError} (an `OutsideSessionWindowError`);
   * `'resolve'` returns the reopen template's send result with
   * `raw: { queued, template, result }`.
   */
  onReopened?: 'reject' | 'resolve'
  /** Outcome callback (queued, sent, failed, expired, ...). Errors thrown here are swallowed. */
  onReport?: (report: SessionReport) => void
  /** Free-form sends remembered (by message id) to react to async 131047 status failures. Default 500. */
  maxTrackedSends?: number
  /** Clock (epoch ms). Default `Date.now`. */
  now?: () => number
}

/**
 * Thrown by `send()` (with `onReopened: 'reject'`) when the content could not
 * be sent now but a reopen template went out (or was pending) and the content
 * was queued for retry. `instanceof OutsideSessionWindowError` still holds.
 */
export class SessionWindowReopenedError extends OutsideSessionWindowError {
  constructor(
    chatId: ChatId,
    /** The template sent to reopen the chat (or already pending). */
    public readonly template: SessionTemplate,
    /** True when the content waits in the retry queue. */
    public readonly queued: boolean,
    /** Send result of the reopen template; undefined when one was already pending. */
    public readonly templateResult?: SendResult<unknown>,
  ) {
    super(chatId, `Outside session window for ${chatId}; reopened with template "${template.name}"${queued ? ', message queued until the user replies' : ''}`)
    this.name = 'SessionWindowReopenedError'
  }
}

/** The underlying (unmanaged) send the manager wraps. */
export type RawSend = (chatId: ChatId, content: OutboundContent, options?: SendOptions) => Promise<SendResult<unknown>>

interface PendingSend {
  content: OutboundContent
  options?: SendOptions
  queuedAt: number
}

interface PendingChat {
  items: PendingSend[]
  /** Set while a reopen template awaits the user's reply. */
  reopenedAt?: number
  template?: SessionTemplate
}

/* --- Manager -------------------------------------------------------------- */

export class SessionWindowManager {
  readonly store: SessionWindowStore
  readonly windowMs: number
  private readonly opts: SessionWindowOptions
  private readonly now: () => number
  private readonly pendingChats = new Map<ChatId, PendingChat>()
  private readonly flushing = new Map<ChatId, Promise<void>>()
  private readonly recentSends = new Map<string, { chatId: ChatId; content: OutboundContent; options?: SendOptions }>()

  constructor(options: SessionWindowOptions = {}) {
    this.opts = options
    this.store = options.store ?? new MemorySessionWindowStore()
    this.windowMs = options.windowMs ?? SESSION_WINDOW_MS
    this.now = options.now ?? Date.now
  }

  /* Window state --------------------------------------------------------- */

  /**
   * `open` (last inbound within the window), `closed` (expired, or Meta said
   * so) or `unknown` (never saw an inbound for this chat).
   */
  async state(chatId: ChatId): Promise<'open' | 'closed' | 'unknown'> {
    return this.classify(await this.store.get(chatId))
  }

  /** True only when the window is known open. */
  async isOpen(chatId: ChatId): Promise<boolean> {
    return (await this.state(chatId)) === 'open'
  }

  /** When the current window closes (epoch ms), or undefined if not known open. */
  async expiresAt(chatId: ChatId): Promise<number | undefined> {
    const s = await this.store.get(chatId)
    return this.classify(s) === 'open' && s?.lastInboundAt !== undefined ? s.lastInboundAt + this.windowMs : undefined
  }

  /** Number of sends queued for a chat. */
  pending(chatId: ChatId): number {
    return this.pendingChats.get(chatId)?.items.length ?? 0
  }

  /** Discard a chat's queued sends (each reported as `dropped`). */
  clearPending(chatId: ChatId): void {
    const chat = this.pendingChats.get(chatId)
    if (!chat) return
    this.pendingChats.delete(chatId)
    for (const item of chat.items) this.report({ chatId, outcome: 'dropped', content: item.content })
  }

  private classify(s: SessionWindowState | undefined): 'open' | 'closed' | 'unknown' {
    if (!s || s.lastInboundAt === undefined) return s?.closedAt !== undefined ? 'closed' : 'unknown'
    if (s.closedAt !== undefined && s.closedAt > s.lastInboundAt) return 'closed'
    return this.now() - s.lastInboundAt < this.windowMs ? 'open' : 'closed'
  }

  private async markClosed(chatId: ChatId): Promise<void> {
    const s = (await this.store.get(chatId)) ?? {}
    await this.store.set(chatId, { ...s, closedAt: this.now() })
  }

  /**
   * Record an inbound message from the user (opens the window) and retry the
   * chat's queued sends through `rawSend`. `at` is epoch ms (default now).
   */
  async noteInbound(chatId: ChatId, rawSend: RawSend, at?: number): Promise<void> {
    const when = at !== undefined && Number.isFinite(at) && at > 0 ? Math.min(at, this.now()) : this.now()
    const s = await this.store.get(chatId)
    const next: SessionWindowState = { lastInboundAt: Math.max(when, s?.lastInboundAt ?? 0) }
    // A replayed/out-of-order webhook clearly older than Meta's 131047 must not
    // reopen the window. Webhook timestamps have 1 s precision, so a live reply
    // can look slightly older than the close it answers: allow some skew.
    if (s?.closedAt !== undefined && s.closedAt - INBOUND_SKEW_MS > when) next.closedAt = s.closedAt
    await this.store.set(chatId, next)
    if (this.classify(next) === 'open') await this.flush(chatId, rawSend)
  }

  private flush(chatId: ChatId, rawSend: RawSend): Promise<void> {
    const prev = this.flushing.get(chatId) ?? Promise.resolve()
    const run = prev.then(() => this.drain(chatId, rawSend))
    this.flushing.set(chatId, run)
    void run.finally(() => { if (this.flushing.get(chatId) === run) this.flushing.delete(chatId) })
    return run
  }

  private async drain(chatId: ChatId, rawSend: RawSend): Promise<void> {
    const chat = this.pendingChats.get(chatId)
    if (!chat) return
    this.pendingChats.delete(chatId)
    const ttl = this.opts.pendingTtlMs ?? SESSION_WINDOW_MS
    for (const item of chat.items) {
      if (this.now() - item.queuedAt > ttl) {
        this.report({ chatId, outcome: 'expired', content: item.content })
        continue
      }
      try {
        const result = await rawSend(chatId, item.content, item.options)
        this.track(result, chatId, item.content, item.options)
        this.report({ chatId, outcome: 'sent', content: item.content, result })
      } catch (error) {
        this.report({ chatId, outcome: 'failed', content: item.content, error })
      }
    }
  }

  /* Sending -------------------------------------------------------------- */

  /** Send through `rawSend`, reopening + queueing when the window is closed. */
  async send(chatId: ChatId, content: OutboundContent, options: SendOptions | undefined, rawSend: RawSend): Promise<SendResult<unknown>> {
    // Templates are allowed outside the window; they are the way back in.
    if (content.kind === 'template') return rawSend(chatId, content, options)

    if (this.opts.proactive !== false) {
      const s = await this.store.get(chatId)
      if (this.classify(s) === 'closed' || this.pendingChats.get(chatId)?.reopenedAt !== undefined) {
        const template = await this.resolveTemplate({ chatId, content, reason: 'proactive', lastInboundAt: s?.lastInboundAt })
        if (template) return this.reopen(chatId, content, options, 'proactive', template, rawSend)
      }
    }

    try {
      const result = await rawSend(chatId, content, options)
      this.track(result, chatId, content, options)
      return result
    } catch (err) {
      if (!(err instanceof OutsideSessionWindowError)) throw err
      await this.markClosed(chatId)
      const s = await this.store.get(chatId)
      const template = await this.resolveTemplate({ chatId, content, reason: 'error', lastInboundAt: s?.lastInboundAt })
      if (!template) {
        this.report({ chatId, outcome: 'no-template', reason: 'error', content, error: err })
        throw err
      }
      return this.reopen(chatId, content, options, 'error', template, rawSend, err)
    }
  }

  /**
   * React to a `failed` status webhook: when it is a 131047 for a free-form
   * message this manager sent, mark the window closed, reopen and queue the
   * content (reported through `onReport`, since `send()` already resolved).
   */
  async noteFailedStatus(chatId: ChatId, messageId: string, code: number | string | undefined, rawSend: RawSend): Promise<void> {
    if (Number(code) !== SESSION_WINDOW_ERROR_CODE) return
    await this.markClosed(chatId)
    const sent = this.recentSends.get(messageId)
    if (!sent) return
    this.recentSends.delete(messageId)
    const s = await this.store.get(sent.chatId)
    const template = await this.resolveTemplate({ chatId: sent.chatId, content: sent.content, reason: 'status', lastInboundAt: s?.lastInboundAt })
    if (!template) {
      this.report({ chatId: sent.chatId, outcome: 'no-template', reason: 'status', content: sent.content })
      return
    }
    try {
      await this.reopen(sent.chatId, sent.content, sent.options, 'status', template, rawSend)
    } catch {
      // Already reported (reopen-failed / reopened as rejection).
    }
  }

  private async resolveTemplate(ctx: ReopenContext): Promise<SessionTemplate | undefined> {
    const byKind = this.opts.reopenTemplateByKind?.[ctx.content.kind]
    if (byKind) return byKind
    const t = this.opts.reopenTemplate
    if (!t) return undefined
    return typeof t === 'function' ? await t(ctx) : t
  }

  private async reopen(
    chatId: ChatId,
    content: OutboundContent,
    options: SendOptions | undefined,
    reason: ReopenReason,
    template: SessionTemplate,
    rawSend: RawSend,
    cause?: unknown,
  ): Promise<SendResult<unknown>> {
    const queue = this.opts.retryOnReply !== false
    if (queue) this.enqueue(chatId, { content, options, queuedAt: this.now() })
    const chat = this.pendingChats.get(chatId)
    const awaitingReply = chat?.reopenedAt !== undefined && this.now() - chat.reopenedAt < this.windowMs

    let templateResult: SendResult<unknown> | undefined
    if (!awaitingReply) {
      try {
        templateResult = await rawSend(chatId, template)
      } catch (error) {
        this.report({ chatId, outcome: 'reopen-failed', reason, content, template, error })
        throw cause ?? error
      }
      const target = this.touchChat(chatId)
      target.reopenedAt = this.now()
      target.template = template
    }

    this.report({ chatId, outcome: queue ? 'queued' : 'reopened', reason, content, template, ...(templateResult ? { result: templateResult } : {}) })
    if (this.opts.onReopened === 'resolve') {
      return {
        ref: templateResult?.ref ?? { id: '', chatId },
        raw: { queued: queue, template, result: templateResult },
      }
    }
    throw new SessionWindowReopenedError(chatId, template, queue, templateResult)
  }

  private touchChat(chatId: ChatId): PendingChat {
    let chat = this.pendingChats.get(chatId)
    if (!chat) {
      chat = { items: [] }
      this.pendingChats.set(chatId, chat)
      const max = Math.max(1, this.opts.maxPendingChats ?? 1_000)
      while (this.pendingChats.size > max) {
        const [oldestId, oldest] = this.pendingChats.entries().next().value as [ChatId, PendingChat]
        this.pendingChats.delete(oldestId)
        for (const item of oldest.items) this.report({ chatId: oldestId, outcome: 'dropped', content: item.content })
      }
    }
    return chat
  }

  private enqueue(chatId: ChatId, item: PendingSend): void {
    const chat = this.touchChat(chatId)
    chat.items.push(item)
    const max = Math.max(1, this.opts.maxPendingPerChat ?? 20)
    while (chat.items.length > max) {
      const dropped = chat.items.shift()
      if (dropped) this.report({ chatId, outcome: 'dropped', content: dropped.content })
    }
  }

  private track(result: SendResult<unknown>, chatId: ChatId, content: OutboundContent, options?: SendOptions): void {
    const id = result.ref.id
    if (!id || content.kind === 'template') return
    this.recentSends.set(id, { chatId, content, ...(options ? { options } : {}) })
    const max = Math.max(0, this.opts.maxTrackedSends ?? 500)
    while (this.recentSends.size > max) this.recentSends.delete(this.recentSends.keys().next().value as string)
  }

  private report(report: SessionReport): void {
    try {
      this.opts.onReport?.(report)
    } catch {
      // A failing observer must not break sending.
    }
  }
}
