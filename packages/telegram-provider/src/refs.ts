/**
 * MessageRef ⇄ Bot API target resolution.
 *
 * Telegram addresses a message in three mutually exclusive ways, and the
 * opaque `MessageRef.id` emitted by parseInbound encodes which one applies:
 *  - regular message:   `id` = String(message_id), native `{ chat_id, message_id }`
 *  - inline-mode message (sent via the bot in inline mode; only reachable from
 *    a callback_query): `id` = inline_message_id, native `{ inline_message_id }`
 *  - ephemeral message (Bot API 10.2, `message_id` is always 0):
 *    `id` = `eph:<ephemeral_message_id>`, native `{ chat_id, ephemeral_message_id }`
 * Events with no addressable message get `upd:<update_id>` (stable across
 * webhook retries, never targetable).
 */

import type { MessageRef } from '@bot-wa/core'

export type TelegramTarget =
  | { kind: 'message'; chat_id: number | string; message_id: number }
  | { kind: 'inline'; inline_message_id: string }
  | { kind: 'ephemeral'; chat_id: number | string; ephemeral_message_id: number }
  | { kind: 'none' }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Resolve how (if at all) the Bot API can address the message behind `ref`. */
export function targetOf(ref: MessageRef): TelegramTarget {
  const n = isRecord(ref.native) ? ref.native : undefined
  if (n && typeof n.inline_message_id === 'string' && n.inline_message_id) {
    return { kind: 'inline', inline_message_id: n.inline_message_id }
  }
  const chatId = n && (typeof n.chat_id === 'number' || typeof n.chat_id === 'string') ? n.chat_id : ref.chatId
  if (n && typeof n.ephemeral_message_id === 'number') {
    return { kind: 'ephemeral', chat_id: chatId, ephemeral_message_id: n.ephemeral_message_id }
  }
  if (n && typeof n.message_id === 'number' && n.message_id > 0) {
    return { kind: 'message', chat_id: chatId, message_id: n.message_id }
  }
  if (/^\d+$/.test(ref.id) && Number(ref.id) > 0) {
    return { kind: 'message', chat_id: chatId, message_id: Number(ref.id) }
  }
  return { kind: 'none' }
}

/**
 * `reply_parameters` for quoting `ref` from an ordinary send, or undefined when
 * it cannot be quoted. Ephemeral messages are never quoted: per the Bot API a
 * reply to an ephemeral message must itself be ephemeral (and sent within 15 s),
 * so quoting one from a regular sendMessage would be rejected — it goes out unquoted.
 */
export function replyParametersOf(ref: MessageRef): Record<string, unknown> | undefined {
  const t = targetOf(ref)
  if (t.kind === 'message') return { message_id: t.message_id }
  return undefined
}
