/**
 * Broadcast engine behind `bot.broadcast()`: sends one content to many chats in
 * batches, with bounded concurrency, a pause between batches, cooperative
 * cancellation (`AbortSignal`) and back-off on {@link RateLimitedError}
 * (`retryAfterMs` pauses EVERY worker, since transport rate limits are per account).
 *
 * Sends go straight through the bot's outbound path (`before`/`after('send')` hooks,
 * outbound ledger, the provider's own rate limiter). They never enter the
 * dispatcher's per-chat FIFO queues, so inbound traffic keeps flowing meanwhile.
 */

import { RateLimitedError } from '../core/provider.js'
import type { ChatId, OutboundContent, SendOptions, SentMessage } from '../core/types.js'
import { parseDuration } from '../utils/duration.js'

/** Progress info passed to {@link BroadcastOptions.onProgress} after each chat settles. */
export interface BroadcastProgress {
  chatId: ChatId
  /** `true` when the provider accepted the send (or a `before('send')` hook skipped it). */
  ok: boolean
  sent: number
  failed: number
}

export interface BroadcastOptions {
  /** Chats per batch (default 10). */
  batchSize?: number
  /** Pause between batches: ms or a duration string (`'2s'`, `'1m'`). Default 0. */
  delayBetween?: string | number
  /** Parallel sends inside a batch (default 1 — strictly sequential). */
  concurrency?: number
  /** Retries per chat after a {@link RateLimitedError} (default 3). Other errors are not retried. */
  maxRetries?: number
  /** Options forwarded to every send (`quoted`, `mentions`, …). */
  sendOptions?: SendOptions
  /** Called after each chat settles: `(done, total, last)`. Errors thrown here are reported, never fatal. */
  onProgress?: (done: number, total: number, last: BroadcastProgress) => void
  /** Called for each chat that finally failed. Errors thrown here are reported, never fatal. */
  onFail?: (chatId: ChatId, error: Error) => void
  /** Abort to stop: no new send starts; in-flight sends finish; the rest land in `pending`. */
  signal?: AbortSignal
}

export interface BroadcastFailure {
  chatId: ChatId
  error: Error
}

export interface BroadcastResult {
  /** Distinct chats targeted (duplicate ids are sent once). */
  total: number
  /** Chats the provider accepted. */
  sent: number
  /** Chats whose send failed for good. */
  failed: number
  /** Chats a `before('send')` hook skipped (counted neither as sent nor failed). */
  skipped: number
  errors: BroadcastFailure[]
  /** The accepted sends, in completion order. */
  messages: SentMessage[]
  /** `true` when `signal` aborted the broadcast before every chat was attempted. */
  cancelled: boolean
  /** Chats never attempted because of the abort. */
  pending: ChatId[]
}

export interface BroadcastDeps {
  send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SentMessage>
  /** Report a callback error (onProgress/onFail threw). */
  reportError?(error: unknown): void
  /** Fallback wait when a RateLimitedError carries no usable `retryAfterMs` (default 1000 ms). */
  defaultRetryAfterMs?: number
}

/** Run a broadcast. Never rejects for per-chat failures; rejects only for invalid options. */
export async function runBroadcast(
  deps: BroadcastDeps,
  chatIds: readonly ChatId[],
  content: OutboundContent,
  opts: BroadcastOptions = {},
): Promise<BroadcastResult> {
  const batchSize = positiveInt(opts.batchSize ?? 10, 'batchSize')
  const concurrency = positiveInt(opts.concurrency ?? 1, 'concurrency')
  const maxRetries = nonNegativeInt(opts.maxRetries ?? 3, 'maxRetries')
  const delayMs = opts.delayBetween === undefined ? 0 : parseDuration(opts.delayBetween)
  const fallbackRetryMs = deps.defaultRetryAfterMs ?? 1000
  const { signal } = opts

  const targets = [...new Set(chatIds)]
  const result: BroadcastResult = {
    total: targets.length, sent: 0, failed: 0, skipped: 0, errors: [], messages: [], cancelled: false, pending: [],
  }
  /** Shared back-off: a rate limit seen by one worker pauses all of them. */
  let pausedUntil = 0
  let done = 0

  const safely = (fn: () => void) => { try { fn() } catch (error) { deps.reportError?.(error) } }

  const settle = (chatId: ChatId, ok: boolean) => {
    done++
    safely(() => opts.onProgress?.(done, result.total, { chatId, ok, sent: result.sent, failed: result.failed }))
  }

  const attempt = async (chatId: ChatId): Promise<'done' | 'aborted'> => {
    for (let retry = 0; ; retry++) {
      const wait = pausedUntil - Date.now()
      if (wait > 0 && (await sleep(wait, signal))) return 'aborted'
      if (signal?.aborted) return 'aborted'
      try {
        const sent = await deps.send(chatId, content, opts.sendOptions)
        if (sent.skipped) result.skipped++
        else { result.sent++; result.messages.push(sent) }
        settle(chatId, true)
        return 'done'
      } catch (raw) {
        const error = raw instanceof Error ? raw : new Error(String(raw))
        if (error instanceof RateLimitedError && retry < maxRetries) {
          const after = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : fallbackRetryMs
          pausedUntil = Math.max(pausedUntil, Date.now() + after)
          continue
        }
        result.failed++
        result.errors.push({ chatId, error })
        safely(() => opts.onFail?.(chatId, error))
        settle(chatId, false)
        return 'done'
      }
    }
  }

  let aborted = false
  for (let start = 0; start < targets.length && !aborted; start += batchSize) {
    if ((start > 0 && delayMs > 0 && (await sleep(delayMs, signal))) || signal?.aborted) {
      aborted = true
      result.pending.push(...targets.slice(start))
      break
    }
    const batch = targets.slice(start, start + batchSize)
    let next = 0
    const unattempted: ChatId[] = []
    const worker = async () => {
      while (next < batch.length) {
        const chatId = batch[next++]!
        if (aborted || signal?.aborted || (await attempt(chatId)) === 'aborted') {
          aborted = true
          unattempted.push(chatId)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker))
    result.pending.push(...batch.filter((id) => unattempted.includes(id)))
    if (signal?.aborted) aborted = true
    if (aborted) result.pending.push(...targets.slice(start + batchSize))
  }
  result.cancelled = result.pending.length > 0
  return result
}

/** Abortable sleep: resolves `true` when `signal` aborted (immediately if it already was). */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(true) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(false) }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function positiveInt(n: number, name: string): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`broadcast: ${name} must be a positive integer (got ${n})`)
  return n
}

function nonNegativeInt(n: number, name: string): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`broadcast: ${name} must be a non-negative integer (got ${n})`)
  return n
}
