/**
 * Projection of an inbound {@link CallEvent} into a message-shaped context for
 * the `CALL` trigger (see `core/triggers.ts`). Internal to the Bot.
 */

import type { CallEvent, InboundMessage } from './provider.js'

/**
 * Normalize a call into an `InboundMessage` of `type: 'call'`. The caller id is
 * used as both the chat and the sender (a DM with the caller): `CallEvent` only
 * carries `from`, and the core never derives a chat id from an id's shape.
 */
export function callToInbound(call: CallEvent): InboundMessage {
  return {
    ref: { id: call.id, chatId: call.from },
    chat: { id: call.from, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: call.from },
    from: call.from,
    sender: call.from,
    chatId: call.from,
    senderId: call.from,
    isGroup: false,
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
