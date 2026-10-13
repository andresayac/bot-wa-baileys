/**
 * Per-chat inactivity watchers behind `bot.onIdle()` / `bot.clearIdle()`.
 *
 * Each registration keeps one one-shot `Scheduler` task per chat, (re)scheduled every
 * time the bot finishes processing an inbound message from that chat (the point where the
 * bot `'message'` event is emitted). When a chat stays quiet for the whole period the handler
 * runs once; the chat's next processed message re-arms it. Messages dropped before the
 * pipeline finishes (a `before('message')` hook that aborts, group-mode filtering) do not
 * count as activity.
 *
 * Timers are cancelled by `clearIdle()`, by the registration's unsubscribe, and on
 * `bot.stop()` — none survive a restart. Human handoff (FEATURES #5): a chat in handoff never
 * gets an idle handler — its messages (which a human agent is answering) do not arm timers, and
 * a timer that comes due while the chat is handed off is dropped. Handoff is known from two
 * sources: the bot's own handoff state (`ChatIdleDeps.isSuspended` — authoritative, it also
 * covers handoffs restored from the store, which emit no event) and the `'handoff'` /
 * `'resume'` bot events carrying `{ chatId }`, tracked for the bot's whole lifetime — not only
 * while an `onIdle()` watcher is registered. A `'handoff'` event also cancels that chat's
 * pending timers. Handler errors (sync or async) are routed to the bot `'error'` event with
 * the chat's last context, never left as unhandled rejections.
 *
 * The period must fit a Node timer (at most 2^31 − 1 ms ≈ 24.8 days, see `parseIdlePeriod`);
 * longer values are rejected instead of firing after 1 ms.
 */

import type { EventEmitter } from 'events'
import type { ChatId, MessageContext } from './provider.js'
import type { ScheduledTask } from './types.js'
import { parseIdlePeriod } from '../utils/timers.js'

/** What an idle handler learns about the quiet chat. */
export interface IdleEvent {
  /** Chat that went quiet (`ctx.from` of its last processed inbound message). */
  chatId: ChatId
  /** The registered idle period, in milliseconds. */
  idleMs: number
  /** Epoch ms when that last inbound message was processed (the period started then). */
  lastActivityAt: number
}

/**
 * Handler of `bot.onIdle()`. `ctx` is the chat's LAST processed inbound message, so
 * `ctx.reply('¿Sigues ahí?')` answers in the right chat. Errors go to the bot `'error'` event.
 */
export type IdleHandler = (ctx: MessageContext, event: IdleEvent) => unknown | Promise<unknown>

/** Collaborators injected by the Bot. */
export interface ChatIdleDeps {
  /** The bot's event emitter — source of `'message'`, `'stopped'`, `'handoff'` and `'resume'`. */
  events: Pick<EventEmitter, 'on' | 'off'>
  /** Schedule a one-shot task (the bot's `Scheduler`). */
  delay(ms: number, fn: () => Promise<void>): ScheduledTask
  /** Whether the bot is accepting inbound traffic (false while stopping/stopped). */
  isActive(): boolean
  /**
   * The bot's authoritative "is this chat handed off to a human?" check. Consulted before a
   * message arms a timer and again when the timer fires. Optional: `'handoff'` / `'resume'`
   * events are tracked as well either way.
   */
  isSuspended?(chatId: ChatId): boolean
  /** Route a handler error to the bot `'error'` event. */
  onError(error: unknown, ctx: MessageContext): void
}

interface Watch {
  readonly idleMs: number
  readonly handler: IdleHandler
  readonly timers: Map<ChatId, ScheduledTask>
}

/** Registry of the `onIdle` watchers of one Bot. Internal. */
export class ChatIdleWatchers {
  private watches = new Set<Watch>()
  /**
   * Chats put in handoff by a `'handoff'` event and not yet `'resume'`d. Tracked from
   * construction for the bot's whole lifetime, so it never misses a handoff that happened
   * before the first `onIdle()` or while no watcher was registered.
   */
  private handedOff = new Set<ChatId>()
  private unsubscribe?: () => void

  constructor(private deps: ChatIdleDeps) {
    deps.events.on('handoff', (payload: unknown) => {
      const chatId = chatIdOf(payload)
      if (chatId === undefined) return
      this.handedOff.add(chatId)
      this.clear(chatId)
    })
    deps.events.on('resume', (payload: unknown) => {
      const chatId = chatIdOf(payload)
      if (chatId !== undefined) this.handedOff.delete(chatId)
    })
  }

  /** Register a watcher; returns its unsubscribe (also cancels its pending timers). */
  add(duration: string | number, handler: IdleHandler): () => void {
    const idleMs = parseIdlePeriod(duration, 'onIdle()')
    const watch: Watch = { idleMs, handler, timers: new Map() }
    this.watches.add(watch)
    this.subscribe()
    return () => {
      if (!this.watches.delete(watch)) return
      cancelTimers(watch)
      if (this.watches.size === 0) this.unsubscribeAll()
    }
  }

  /** Cancel pending idle timers for `chatId` (every chat when omitted) until its next inbound. */
  clear(chatId?: ChatId): void {
    for (const watch of this.watches) cancelTimers(watch, chatId)
  }

  /** Is `chatId` with a human agent (no idle handler may run there)? */
  private isSuspended(chatId: ChatId): boolean {
    return this.handedOff.has(chatId) || this.deps.isSuspended?.(chatId) === true
  }

  private touch(ctx: MessageContext): void {
    if (!this.deps.isActive()) return
    const chatId = ctx.from
    if (this.isSuspended(chatId)) {
      this.clear(chatId)
      return
    }
    const lastActivityAt = Date.now()
    for (const watch of this.watches) {
      watch.timers.get(chatId)?.cancel()
      const task = this.deps.delay(watch.idleMs, async () => {
        if (watch.timers.get(chatId) !== task) return
        watch.timers.delete(chatId)
        // Re-checked at fire time: the chat may have been handed off since its last message.
        if (!this.deps.isActive() || this.isSuspended(chatId)) return
        try {
          await watch.handler(ctx, { chatId, idleMs: watch.idleMs, lastActivityAt })
        } catch (error) {
          this.deps.onError(error, ctx)
        }
      })
      watch.timers.set(chatId, task)
    }
  }

  private subscribe(): void {
    if (this.unsubscribe) return
    const { events } = this.deps
    const onMessage = (ctx: MessageContext) => this.touch(ctx)
    const onStopped = () => this.clear()
    events.on('message', onMessage)
    events.on('stopped', onStopped)
    this.unsubscribe = () => {
      events.off('message', onMessage)
      events.off('stopped', onStopped)
    }
  }

  /** Stop listening for activity. The handoff tracking (constructor) deliberately stays. */
  private unsubscribeAll(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }
}

/** `chatId` of a `'handoff'` / `'resume'` event payload, if it carries one. */
function chatIdOf(payload: unknown): ChatId | undefined {
  const chatId = (payload as { chatId?: unknown } | null | undefined)?.chatId
  return typeof chatId === 'string' ? chatId : undefined
}

function cancelTimers(watch: Watch, chatId?: ChatId): void {
  if (chatId !== undefined) {
    watch.timers.get(chatId)?.cancel()
    watch.timers.delete(chatId)
    return
  }
  for (const task of watch.timers.values()) task.cancel()
  watch.timers.clear()
}
