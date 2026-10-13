/**
 * Projection of an inbound {@link CallEvent} into a message-shaped context for
 * the `CALL` trigger (see `core/triggers.ts`). Internal to the Bot.
 */

import type { CallEvent, InboundMessage } from './provider.js'

/**
 * Normalize a call into an `InboundMessage` of `type: 'call'`. The sender is the
 * caller (`CallEvent.from`); the chat is `CallEvent.chatId` (a group call) or,
 * when omitted, the DM with the caller. `isGroup` comes from the provider — the
 * core never derives a chat id or its kind from an id's shape.
 */
export function callToInbound(call: CallEvent): InboundMessage {
  const chatId = call.chatId ?? call.from
  const isGroup = call.isGroup === true
  return {
    ref: { id: call.id, chatId },
    chat: { id: chatId, kind: isGroup ? 'group' : 'dm', isGroup, isBroadcast: false },
    senderInfo: { id: call.from },
    from: chatId,
    sender: call.from,
    chatId,
    senderId: call.from,
    isGroup,
    isBroadcast: false,
    fromMe: false,
    type: 'call',
    body: '',
    timestamp: Date.now(),
    mentions: [],
    raw: call,
  }
}

/** Bounded set of recently seen ids — "fire once per call id" without unbounded growth. */
export class RecentIds {
  private readonly ids = new Set<string>()

  constructor(private readonly max = 1_000) {}

  /** Record `id`; returns `false` when it was already recorded. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    if (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
    return true
  }
}
