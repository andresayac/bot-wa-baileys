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
 * `bot.stop()` — none survive a restart. Human handoff (FEATURES #5): a `'handoff'` bot event
 * carrying `{ chatId }` cancels that chat's timers and suspends it — its messages (which a
 * human agent is answering) do not re-arm them — until a `'resume'` event for the same chat.
 * Handler errors (sync or async) are routed to the bot `'error'` event with the chat's last
 * context, never left as unhandled rejections.
 */

import type { EventEmitter } from 'events'
import type { ChatId, MessageContext } from './provider.js'
import type { ScheduledTask } from './types.js'
import { parseDuration } from '../utils/timers.js'

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
  /** Chats in human handoff: their messages do not re-arm idle timers until `'resume'`. */
  private suspended = new Set<ChatId>()
  private unsubscribe?: () => void

  constructor(private deps: ChatIdleDeps) {}

  /** Register a watcher; returns its unsubscribe (also cancels its pending timers). */
  add(duration: string | number, handler: IdleHandler): () => void {
    const idleMs = parseDuration(duration)
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
      throw new RangeError(`onIdle() needs a positive, finite duration — got ${JSON.stringify(duration)}`)
    }
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

  private touch(ctx: MessageContext): void {
    if (!this.deps.isActive()) return
    const chatId = ctx.from
    if (this.suspended.has(chatId)) return
    const lastActivityAt = Date.now()
    for (const watch of this.watches) {
      watch.timers.get(chatId)?.cancel()
      const task = this.deps.delay(watch.idleMs, async () => {
        if (watch.timers.get(chatId) !== task) return
        watch.timers.delete(chatId)
        if (!this.deps.isActive()) return
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
    const onHandoff = (payload: unknown) => {
      const chatId = chatIdOf(payload)
      if (chatId === undefined) return
      this.suspended.add(chatId)
      this.clear(chatId)
    }
    const onResume = (payload: unknown) => {
      const chatId = chatIdOf(payload)
      if (chatId !== undefined) this.suspended.delete(chatId)
    }
    events.on('message', onMessage)
    events.on('stopped', onStopped)
    events.on('handoff', onHandoff)
    events.on('resume', onResume)
    this.unsubscribe = () => {
      events.off('message', onMessage)
      events.off('stopped', onStopped)
      events.off('handoff', onHandoff)
      events.off('resume', onResume)
    }
  }

  private unsubscribeAll(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.suspended.clear()          // no longer listening for 'resume': don't keep stale state
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
