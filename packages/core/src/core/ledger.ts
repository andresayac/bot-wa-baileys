/**
 * Message-log helpers of the Bot: timestamps of inbound rows, the delivery-status order
 * used to merge receipts, the text body recorded for an outbound content, and the
 * {@link MessageLog} that keeps the bot's outbound rows.
 */

import type { ChatId, DeliveryStatus, MessageRef, OutboundContent, SendOptions, StoredChat, StoredMessage, UserId } from './types.js'
import type { IStore } from '../store/IStore.js'
import type { StoreNamespace } from '../store/NamespacedStore.js'
import { KeyedQueue } from '../utils/keyedQueue.js'

export function normalizeTimestamp(timestamp: number): number {
  return timestamp > 0 && timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
}

/**
 * Persisted timestamp of a live inbound message. Providers with second-precision
 * clocks (WhatsApp, Telegram) floor to the second, while outbound rows use
 * `Date.now()`; when the message is received within that same second, use the
 * receive time so the message log orders it correctly against the bot's replies.
 * Late deliveries (history sync, retries) keep the provider time.
 */
export function receiveTimestamp(timestamp: number, now = Date.now()): number {
  const ms = normalizeTimestamp(timestamp)
  const secondPrecision = timestamp > 0 && timestamp < 1_000_000_000_000
  return secondPrecision && now >= ms && now - ms < 1000 ? now : ms
}

type StoredStatus = NonNullable<StoredMessage['status']>
/**
 * `failed` outranks `delivered`: a provider can report a failure after a delivery receipt
 * (e.g. an expired or rejected message), and that terminal error must not be dropped.
 * `read` is proof the user saw the message, so nothing regresses it.
 */
const DELIVERY_RANK: Record<StoredStatus, number> = {
  received: 0, queued: 0, sent: 1, delivered: 2, failed: 3, read: 4,
}
/** Pick the further-along delivery status so a late 'sent' write can't regress a delivered/failed/read receipt. */
export function higherDeliveryStatus(existing: StoredStatus | undefined, incoming: StoredStatus): StoredStatus {
  if (!existing) return incoming
  return (DELIVERY_RANK[existing] ?? 0) > (DELIVERY_RANK[incoming] ?? 0) ? existing : incoming
}

export function outboundBody(content: OutboundContent): string | undefined {
  switch (content.kind) {
    case 'text': return content.text
    case 'image':
    case 'video':
    case 'document': return content.caption
    case 'location': return content.name ?? content.address
    case 'contact': return content.displayName ?? content.phone
    case 'poll': return content.question
    case 'buttons':
    case 'list': return content.text
    case 'card': return content.title
    case 'template': return content.name
    case 'reaction': return content.emoji
    case 'form': return content.form.title ?? content.form.id
    default: return undefined
  }
}

export function toStoredError(error: unknown): { code?: string | number; message?: string } {
  if (!(error instanceof Error)) return { message: String(error).slice(0, 500) }
  const code = (error as Error & { code?: string | number }).code
  return { code, message: error.message.slice(0, 500) }
}

/** What the {@link MessageLog} needs from the Bot. Internal. */
export interface MessageLogDeps {
  store: Pick<IStore, 'getMessage' | 'saveMessage'>
  namespace: Readonly<StoreNamespace>
  /** The bot's own id on the transport (`provider.selfId`), recorded as the sender of its messages. */
  selfId(): UserId | undefined
  /** Upsert a chat record in order with the bot's other writes of that chat. */
  persistChat(chat: StoredChat): Promise<void>
  /** Ledger failures never fail a send that already happened: they are reported here. */
  reportError(error: unknown): void
}

/**
 * The outbound side of the message log: one row per bot message (sent or failed), kept in
 * sync with edits and delivery/read receipts. Every row update is a read-modify-write run
 * one at a time per message, so a receipt landing while the send is still being recorded
 * can never be overwritten by the older status.
 */
export class MessageLog {
  private readonly writes = new KeyedQueue()

  constructor(private readonly deps: MessageLogDeps) {}

  async outbound(input: {
    ref: MessageRef
    chatId: ChatId
    content: OutboundContent
    options?: SendOptions
    status: 'sent' | 'failed'
    error?: { code?: string | number; message?: string }
    raw?: unknown
  }): Promise<void> {
    const timestamp = Date.now()
    try {
      // A delivery/read receipt for this ref may already have landed during the
      // after-send hook window. Don't regress a more-advanced status back to
      // 'sent' — keep whichever is further along.
      await Promise.all([
        this.deps.persistChat({
          id: input.chatId,
          ...this.deps.namespace,
          lastMessageAt: timestamp,
          updatedAt: timestamp,
        }),
        this.write(input.ref, (existing) => {
          const status = higherDeliveryStatus(existing?.status, input.status)
          return {
            ref: input.ref,
            chatId: input.chatId,
            senderId: this.deps.selfId(),
            ...this.deps.namespace,
            timestamp,
            type: input.content.kind,
            body: outboundBody(input.content),
            fromMe: true,
            direction: 'outbound',
            status,
            error: status === 'failed' ? input.error : existing?.error,
            quoted: input.options?.quoted,
            raw: input.raw,
          }
        }),
      ])
    } catch (error) {
      // The provider may already have delivered the message. Reporting a false
      // send failure would encourage a retry and duplicate it, so ledger errors
      // travel through the bot error channel instead.
      this.deps.reportError(error)
    }
  }

  /** Update the ledger entry of an edited bot message (keeps its timestamp and status). */
  async edit(ref: MessageRef, content: OutboundContent, raw?: unknown): Promise<void> {
    try {
      await this.write(ref, (existing) => ({
        ...(existing ?? {
          ref,
          chatId: ref.chatId,
          senderId: this.deps.selfId(),
          timestamp: Date.now(),
          fromMe: true,
          direction: 'outbound' as const,
          status: 'sent' as const,
        }),
        ...this.deps.namespace,
        type: content.kind,
        body: outboundBody(content),
        raw: raw ?? existing?.raw,
      }))
    } catch (error) {
      // The provider already applied the edit: report the ledger failure, do not fail the edit.
      this.deps.reportError(error)
    }
  }

  /**
   * Record a delivery/read receipt. Receipts can arrive out of order (a `delivered` after
   * the `read`), so the stored status only ever moves forward. A receipt's error is always
   * recorded, even when its status does not advance the row (a `failed` after `read`), so the
   * provider diagnostic is never lost; a receipt without an error keeps the one already recorded.
   */
  async receipt(status: DeliveryStatus): Promise<void> {
    await this.write(status.ref, (existing) => {
      const next = higherDeliveryStatus(existing?.status, status.status)
      return {
        ...(existing ?? {
          ref: status.ref,
          chatId: status.ref.chatId,
          timestamp: normalizeTimestamp(status.timestamp),
          type: 'unknown' as const,
          fromMe: true,
          direction: 'outbound' as const,
        }),
        ...this.deps.namespace,
        status: next,
        error: status.error !== undefined ? status.error : existing?.error,
        timestamp: existing?.timestamp ?? normalizeTimestamp(status.timestamp),
      }
    })
  }

  /**
   * Read-modify-write one message-log row, one write at a time per message (`update`
   * receives the stored row, if any, and returns the row to save, or `undefined` to skip).
   */
  private write(ref: MessageRef, update: (existing: StoredMessage | undefined) => StoredMessage | undefined): Promise<void> {
    return this.writes.run(`${ref.chatId.length}:${ref.chatId}:${ref.id}`, async () => {
      const next = update(await this.deps.store.getMessage(ref))
      if (next) await this.deps.store.saveMessage(next)
    })
  }

  /** Keep the stored outbound message in sync with an in-place edit (body/type only). */
  async streamEdit(ref: MessageRef, content: OutboundContent): Promise<void> {
    try {
      let missing = false
      await this.write(ref, (existing) => {
        if (existing) return { ...existing, type: content.kind, body: outboundBody(content) }
        missing = true
        return undefined
      })
      if (missing) await this.outbound({ ref, chatId: ref.chatId, content, status: 'sent' })
    } catch (error) {
      this.deps.reportError(error)
    }
  }
}
