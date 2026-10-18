/**
 * `bot.trigger()` — start a registered flow/conversation programmatically (from a
 * scheduler, a webhook, an admin panel) as if the subject had written the trigger.
 * The Bot builds a synthetic inbound from these options and runs it through the
 * same gates (access lists, human handoff) and the chat's FIFO queue.
 */

import type { ChatId, UserId } from '../core/types.js'
import type { InboundMessage } from '../core/provider.js'
import { randomId } from '../utils/timers.js'

export interface TriggerOptions {
  /** Chat to run the conversation in (an opaque transport id, used as-is). */
  chatId: ChatId
  /** Subject of the conversation (default: `chatId`). Required to target one participant of a group. */
  userId?: UserId
  /** Is `chatId` a group? (default `false`). With `conversationScope: 'participant'` it keys the conversation per `userId`. */
  isGroup?: boolean
  /** Seeds `c.state` (shallow copy) — e.g. `{ cita: 'mañana 3pm' }` → `c.state.cita`. */
  data?: Record<string, unknown>
  /**
   * What to do when the subject already has a live conversation or a dormant
   * (persisted) checkpoint: `'skip'` (default) leaves it alone and resolves
   * `{ started: false, reason: 'busy' }`; `'replace'` cancels it and starts this one.
   */
  ifActive?: 'skip' | 'replace'
}

/** Why {@link TriggerResult.started} is `false`. */
export type TriggerSkipReason =
  /** The bot is not running (`start()` not called, or stopped). */
  | 'stopped'
  /** Blacklisted, or not whitelisted while the whitelist is enabled. */
  | 'blocked'
  /** The chat is handed off to a human. */
  | 'handoff'
  /** The subject already has a conversation and `ifActive` is `'skip'`. */
  | 'busy'

export interface TriggerResult {
  /** `true` when the conversation was entered (it keeps running after this resolves). */
  started: boolean
  name: string
  chatId: ChatId
  userId: UserId
  reason?: TriggerSkipReason
}

/** Marker placed on `ctx.raw` of a triggered conversation's context. */
export interface TriggerRaw {
  synthetic: 'trigger'
  name: string
}

/** Build the synthetic inbound for `bot.trigger(name, opts)`. Ids are used verbatim, never parsed. */
export function triggerInbound(name: string, opts: TriggerOptions): InboundMessage<TriggerRaw> {
  const chatId = opts.chatId
  const senderId = opts.userId ?? chatId
  const isGroup = opts.isGroup === true
  return {
    ref: { id: randomId('trigger'), chatId },
    chat: { id: chatId, kind: isGroup ? 'group' : 'dm', isGroup, isBroadcast: false },
    senderInfo: { id: senderId },
    from: chatId,
    sender: senderId,
    chatId,
    senderId,
    isGroup,
    isBroadcast: false,
    fromMe: false,
    type: 'text',
    body: '',
    timestamp: Date.now(),
    mentions: [],
    raw: { synthetic: 'trigger', name },
  }
}

/** Throws `TypeError` for unusable trigger arguments. */
export function assertTriggerArgs(name: unknown, opts: unknown): asserts opts is TriggerOptions {
  if (typeof name !== 'string' || name === '') throw new TypeError('bot.trigger(): name must be a non-empty string')
  const o = opts as Partial<TriggerOptions> | undefined
  if (!o || typeof o.chatId !== 'string' || o.chatId === '') throw new TypeError('bot.trigger(): opts.chatId must be a non-empty string')
  if (o.userId !== undefined && (typeof o.userId !== 'string' || o.userId === '')) {
    throw new TypeError('bot.trigger(): opts.userId must be a non-empty string when given')
  }
  if (o.data !== undefined && (typeof o.data !== 'object' || o.data === null || Array.isArray(o.data))) {
    throw new TypeError('bot.trigger(): opts.data must be a plain object')
  }
  if (o.ifActive !== undefined && o.ifActive !== 'skip' && o.ifActive !== 'replace') {
    throw new TypeError("bot.trigger(): opts.ifActive must be 'skip' or 'replace'")
  }
}
