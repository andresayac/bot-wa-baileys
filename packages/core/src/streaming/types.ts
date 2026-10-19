/**
 * Public types of `ctx.stream()` — transport-agnostic streaming of a reply that
 * is still being generated (LLM tokens, a long report, ...).
 */

import type {
  DraftOptions,
  MessageRef,
  OutboundContent,
  ProviderCapabilities,
  SendOptions,
  SentMessage,
} from '../core/provider.js'

/**
 * Anything that yields text pieces: an async iterable (async generator, Node
 * `Readable`), a web `ReadableStream`, or a plain sync iterable. Byte chunks
 * (`Uint8Array`/`Buffer`) are decoded as UTF-8.
 */
export type StreamSource =
  | AsyncIterable<string | Uint8Array>
  | Iterable<string>
  | ReadableStream<string | Uint8Array>

/**
 * How a stream is rendered:
 * - `'draft'`  native ephemeral preview updated in place, then one final message.
 * - `'edit'`   send the first text, then throttled edits of that message.
 * - `'chunk'`  no live preview: sentence-sized messages with typing between them.
 * - `'buffer'` collect everything (typing meanwhile), then send it once (split if long).
 */
export type StreamStrategy = 'draft' | 'edit' | 'chunk' | 'buffer'

/** Options of `ctx.stream()` / {@link streamText}. */
export interface StreamOptions {
  /** `'auto'` (default) picks from `capabilities.streaming`; an unsupported choice degrades. */
  strategy?: 'auto' | StreamStrategy
  /** Minimum ms between two live updates (draft/edit). Default 400 (draft), 1000 (edit). */
  throttleMs?: number
  /** Abort the stream: reading stops and the source's `return()` is called. */
  signal?: AbortSignal
  /**
   * What to do with the text produced so far on cancellation. Default `'flush'`
   * (send it). `'discard'` sends nothing more and removes the live preview: a draft
   * simply expires and, with the edit strategy, the message being edited is deleted
   * (when the transport can delete; otherwise only its cursor is removed). Messages
   * already completed before the cancel stay.
   */
  onCancel?: 'flush' | 'discard'
  /** Max chars per message. Default `capabilities.maxTextLength`, else 4096. */
  maxLength?: number
  /** `'chunk'`: minimum chars before a chunk is sent at a sentence boundary. Default 160. */
  minChunkChars?: number
  /** `'chunk'`: hard size of a chunk with no sentence boundary. Default min(maxLength, 1500). */
  maxChunkChars?: number
  /** Show typing while waiting (chunk/buffer, and edit before its first message). Default true. */
  typing?: boolean
  /** Interval (ms) to refresh the typing indicator. Default 8000. */
  typingIntervalMs?: number
  /** Suffix shown on in-progress drafts/edits (e.g. `' ▌'`). Never in the final text. Default `''`. */
  cursor?: string
  /** Draft: show a stop button (Telegram `can_stop`). Default false. */
  canStop?: boolean
  /** Draft: keep the draft visible when the user stops it (Telegram `keep_on_stop`). */
  keepOnStop?: boolean
  /** Options for the FIRST message sent (e.g. `{ quoted: ctx.ref }`). */
  sendOptions?: SendOptions
  /** Transport passthrough for draft calls (e.g. Telegram `message_thread_id`). */
  draftPlatformData?: Record<string, unknown>
}

/** What `ctx.stream()` resolves with. */
export interface StreamResult {
  /** Full text received from the source (before splitting). */
  text: string
  /** Every message sent (several when the text was split or chunked). */
  messages: SentMessage[]
  /** Strategy actually used at the end (after any fallback). */
  strategy: StreamStrategy
  /** `true` when `signal` aborted or the user stopped the draft. */
  cancelled: boolean
  /** `true` when the user pressed the transport's stop button. */
  stoppedByUser: boolean
}

/**
 * The sink {@link streamText} renders into. `ctx.stream()` builds one from the
 * bot; tests and custom integrations can provide their own.
 */
export interface StreamTarget {
  capabilities?: Pick<ProviderCapabilities, 'streaming' | 'maxTextLength' | 'edit'>
  /** `false` for groups/channels: native drafts are attempted only when not `false`. */
  isPrivate?: boolean
  send(content: OutboundContent, options?: SendOptions): Promise<SentMessage>
  edit?(ref: MessageRef, content: OutboundContent): Promise<unknown>
  /** Deletes a message this stream sent (used by `onCancel: 'discard'`). */
  delete?(ref: MessageRef): Promise<void>
  draft?(draftId: number, text: string, opts?: DraftOptions): Promise<void>
  typing?(): Promise<void>
  /**
   * Aborted when the transport shuts down (`bot.stop()`): the stream is cancelled and
   * touches the target no more — no flush, no discard, no rate-limit wait.
   */
  shutdown?: AbortSignal
}
