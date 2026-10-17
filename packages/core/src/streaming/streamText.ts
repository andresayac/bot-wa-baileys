/**
 * streamText — render a text stream (LLM tokens, ...) into a chat with the best
 * strategy the transport supports. Transport-agnostic: it only talks to a
 * {@link StreamTarget} (send / edit / draft / typing), never to a provider.
 *
 * Guarantees:
 *  - live updates (draft/edit) are throttled and never run concurrently;
 *  - no message exceeds the length limit (long text is split at natural boundaries);
 *  - cancellation (`signal`, or the user's stop button on drafts) stops reading the
 *    source, calls its `return()`, and flushes (or discards) what was produced.
 *
 * @example
 * ```ts
 * bot.when('cuento', async (ctx) => {
 *   await ctx.stream(ai.stream({ messages: [{ role: 'user', content: 'Un cuento corto' }] }))
 * })
 * ```
 */

import { RateLimitedError } from '../core/provider.js'
import type { DraftOptions, MessageRef, SentMessage } from '../core/provider.js'
import { findSplitPoint, lastBoundaryAfter, splitMessage } from './split.js'
import type { StreamOptions, StreamResult, StreamSource, StreamStrategy, StreamTarget } from './types.js'

const DEFAULT_MAX_LENGTH = 4096
const DEFAULT_THROTTLE_DRAFT_MS = 400
const DEFAULT_THROTTLE_EDIT_MS = 1000
const DEFAULT_MIN_CHUNK = 160
const DEFAULT_MAX_CHUNK = 1500
const DEFAULT_TYPING_INTERVAL_MS = 8000
const MAX_FINAL_RETRY_WAIT_MS = 5000

const ABORTED: unique symbol = Symbol('aborted')

const noop = (): void => undefined
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A fresh non-zero 31-bit draft id. */
function newDraftId(): number {
  return 1 + Math.floor(Math.random() * 0x7ffffffe)
}

/**
 * Pick the strategy for `target`. `requested` (`'auto'` by default) is honoured
 * when the target supports it, otherwise it degrades: draft → edit → chunk.
 */
export function resolveStreamStrategy(target: StreamTarget, requested: StreamOptions['strategy'] = 'auto'): StreamStrategy {
  const caps = target.capabilities
  const mode = caps?.streaming ?? 'none'
  const canDraft = typeof target.draft === 'function' && target.isPrivate !== false
  const canEdit = typeof target.edit === 'function' && caps?.edit !== false
  if (requested === 'chunk' || requested === 'buffer') return requested
  if (requested === 'draft') return canDraft ? 'draft' : canEdit ? 'edit' : 'chunk'
  if (requested === 'edit') return canEdit ? 'edit' : 'chunk'
  if (mode === 'draft' && canDraft) return 'draft'
  if ((mode === 'draft' || mode === 'edit') && canEdit) return 'edit'
  return 'chunk'
}

type AnyIterator = AsyncIterator<string | Uint8Array> | Iterator<string>

function toIterator(source: StreamSource): AnyIterator {
  const s = source as Partial<AsyncIterable<string | Uint8Array> & Iterable<string> & ReadableStream<string | Uint8Array>>
  if (typeof s[Symbol.asyncIterator] === 'function') return s[Symbol.asyncIterator]!()
  if (typeof s.getReader === 'function') {
    const reader = s.getReader()
    return {
      next: async () => {
        const r = await reader.read()
        return r.done ? { done: true, value: undefined } : { done: false, value: r.value }
      },
      return: async () => {
        await reader.cancel().catch(noop)
        return { done: true, value: undefined }
      },
    }
  }
  if (typeof s[Symbol.iterator] === 'function') return s[Symbol.iterator]!()
  throw new TypeError('stream source must be an AsyncIterable, an Iterable or a ReadableStream')
}

class StreamSession {
  private strategy: StreamStrategy
  private readonly maxLength: number
  private readonly cursor: string
  private readonly throttleMs: number | undefined
  private readonly minChunk: number
  private readonly maxChunk: number
  private readonly canEdit: boolean

  private full = ''
  private current = ''
  private readonly messages: SentMessage[] = []
  private draftId = newDraftId()
  private editRef?: MessageRef
  private lastShown?: string
  private chain: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private previewQueued = false
  private lastPreviewAt = 0
  private typingTimer?: ReturnType<typeof setInterval>
  private fatal?: unknown
  private cancelled = false
  private stoppedByUser = false
  private resolveAbort: () => void = noop
  private readonly abortPromise: Promise<typeof ABORTED>

  constructor(private readonly target: StreamTarget, private readonly opts: StreamOptions) {
    this.strategy = resolveStreamStrategy(target, opts.strategy)
    const capMax = target.capabilities?.maxTextLength
    this.maxLength = Math.max(1, Math.floor(opts.maxLength ?? capMax ?? DEFAULT_MAX_LENGTH))
    this.cursor = opts.cursor ?? ''
    if (this.cursor.length >= this.maxLength) this.cursor = ''
    this.throttleMs = opts.throttleMs
    this.maxChunk = Math.max(1, Math.min(this.maxLength, opts.maxChunkChars ?? DEFAULT_MAX_CHUNK))
    this.minChunk = Math.max(1, Math.min(this.maxChunk, opts.minChunkChars ?? DEFAULT_MIN_CHUNK))
    this.canEdit = typeof target.edit === 'function' && target.capabilities?.edit !== false
    this.abortPromise = new Promise((resolve) => { this.resolveAbort = () => resolve(ABORTED) })
  }

  /** Per-segment limit while a live preview (with cursor) is shown. */
  private get limit(): number {
    return this.strategy === 'draft' || this.strategy === 'edit'
      ? this.maxLength - this.cursor.length
      : this.maxLength
  }

  private cancel = (): void => {
    if (this.cancelled) return
    this.cancelled = true
    this.resolveAbort()
  }

  async run(source: StreamSource): Promise<StreamResult> {
    const signal = this.opts.signal
    if (signal?.aborted) this.cancel()
    else signal?.addEventListener('abort', this.cancel, { once: true })
    if (this.strategy !== 'draft') this.startTyping()

    let sourceError: unknown
    let iterator: AnyIterator | undefined
    const decoder = new TextDecoder()
    try {
      iterator = toIterator(source)
      while (!this.cancelled && this.fatal === undefined) {
        const next = Promise.resolve(iterator.next())
        next.catch(noop)
        const r = await Promise.race([next, this.abortPromise])
        if (r === ABORTED || r.done) break
        const value = r.value as string | Uint8Array | undefined
        const piece = typeof value === 'string' ? value : value ? decoder.decode(value, { stream: true }) : ''
        if (piece) await this.append(piece)
      }
    } catch (error) {
      sourceError = error
    }
    if (iterator && (this.cancelled || this.fatal !== undefined)) {
      // Do not await: a source stuck in a pending next() would block the flush.
      try { void Promise.resolve(iterator.return?.()).catch(noop) } catch { /* ignore */ }
    }
    const tail = decoder.decode()
    if (tail && this.fatal === undefined && !this.cancelled) await this.append(tail)

    try {
      await this.finish()
    } finally {
      this.stopTyping()
      signal?.removeEventListener('abort', this.cancel)
    }
    if (sourceError !== undefined) throw sourceError
    if (this.fatal !== undefined) throw this.fatal
    return {
      text: this.full,
      messages: this.messages,
      strategy: this.strategy,
      cancelled: this.cancelled,
      stoppedByUser: this.stoppedByUser,
    }
  }

  /* --- input ------------------------------------------------------------ */

  private async append(piece: string): Promise<void> {
    this.full += piece
    this.current += piece
    try {
      while (this.current.length > this.limit) await this.enqueue(() => this.commitHead())
      if (this.strategy === 'chunk') await this.enqueue(() => this.sendReadyChunks())
      else if (this.strategy === 'draft' || this.strategy === 'edit') this.schedulePreview()
    } catch (error) {
      this.fatal ??= error
    }
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const p = this.chain.then(op)
    this.chain = p.catch(noop)
    return p
  }

  /* --- live previews ------------------------------------------------------ */

  private schedulePreview(): void {
    if (this.timer || this.previewQueued) return
    const throttle = this.throttleMs ?? (this.strategy === 'draft' ? DEFAULT_THROTTLE_DRAFT_MS : DEFAULT_THROTTLE_EDIT_MS)
    const wait = Math.max(0, this.lastPreviewAt + throttle - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.previewQueued = true
      this.enqueue(async () => {
        this.previewQueued = false
        this.lastPreviewAt = Date.now()
        await this.preview()
      }).catch((error: unknown) => { this.fatal ??= error })
    }, wait)
  }

  private draftOptions(): DraftOptions {
    return {
      ...(this.opts.canStop ? { canStop: true } : {}),
      ...(this.opts.keepOnStop ? { keepOnStop: true } : {}),
      ...(this.opts.draftPlatformData ? { platformData: this.opts.draftPlatformData } : {}),
      onStop: () => {
        this.stoppedByUser = true
        this.cancel()
      },
    }
  }

  private async preview(): Promise<void> {
    if (this.fatal !== undefined) return
    const text = this.current
    if (!text.trim() || text === this.lastShown) return
    if (this.strategy === 'draft') {
      try {
        await this.target.draft!(this.draftId, text + this.cursor, this.draftOptions())
        this.lastShown = text
      } catch (error) {
        if (error instanceof RateLimitedError) return
        this.fallbackFromDraft()
        await this.preview()
      }
      return
    }
    if (this.strategy !== 'edit') return
    if (!this.editRef) {
      const sent = await this.sendMessage(text + this.cursor)
      if (sent.skipped) {
        this.strategy = 'buffer'
        return
      }
      this.editRef = sent.ref
      this.lastShown = text
      this.stopTyping()
      return
    }
    try {
      await this.target.edit!(this.editRef, { kind: 'text', text: text + this.cursor })
      this.lastShown = text
    } catch {
      // A failed intermediate edit (rate limit, transient) is skipped; the final edit retries.
    }
  }

  /** Drafts refused (e.g. not a private chat): degrade to edits, else chunks. */
  private fallbackFromDraft(): void {
    this.strategy = this.canEdit ? 'edit' : 'chunk'
    this.lastShown = undefined
    this.startTyping()
  }

  /* --- splitting / chunks ------------------------------------------------- */

  private async commitHead(): Promise<void> {
    const limit = this.limit
    if (this.current.length <= limit) return
    const cut = findSplitPoint(this.current, limit)
    const head = this.current.slice(0, cut).trimEnd()
    this.current = this.current.slice(cut).trimStart()
    if (this.strategy === 'edit' && this.editRef) {
      await this.finalEdit(this.editRef, head)
    } else if (head) {
      await this.sendMessage(head)
    }
    this.editRef = undefined
    this.lastShown = undefined
    if (this.strategy === 'draft') this.draftId = newDraftId()
  }

  private async sendReadyChunks(): Promise<void> {
    for (;;) {
      const window = this.current.slice(0, this.maxChunk)
      let cut = lastBoundaryAfter(window, this.minChunk)
      if (cut <= 0) {
        if (this.current.length <= this.maxChunk) return
        cut = findSplitPoint(this.current, this.maxChunk)
      }
      const head = this.current.slice(0, cut).trim()
      this.current = this.current.slice(cut).trimStart()
      if (head) {
        await this.sendMessage(head)
        this.pingTyping()
      }
    }
  }

  /* --- final ----------------------------------------------------------------- */

  private async finish(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.chain
    if (this.fatal !== undefined) return
    const discard = this.cancelled && this.opts.onCancel === 'discard'
    await this.enqueue(async () => {
      if (this.strategy === 'edit' && this.editRef) {
        if (discard) {
          if (this.cursor && this.lastShown) await this.finalEdit(this.editRef, this.lastShown.trimEnd())
          return
        }
        const [first, ...rest] = splitMessage(this.current, this.maxLength)
        if (first !== undefined && (first !== this.lastShown || this.cursor)) await this.finalEdit(this.editRef, first)
        for (const part of rest) await this.sendMessage(part)
        return
      }
      if (discard) return
      for (const part of splitMessage(this.current, this.maxLength)) await this.sendMessage(part)
    }).catch((error: unknown) => { this.fatal ??= error })
  }

  /** Final edit of a message: one retry after a (bounded) rate-limit wait. */
  private async finalEdit(ref: MessageRef, text: string): Promise<void> {
    if (!text) return
    try {
      await this.target.edit!(ref, { kind: 'text', text })
    } catch (error) {
      if (!(error instanceof RateLimitedError)) throw error
      await sleep(Math.min(error.retryAfterMs, MAX_FINAL_RETRY_WAIT_MS))
      await this.target.edit!(ref, { kind: 'text', text })
    }
    this.lastShown = text
  }

  private async sendMessage(text: string): Promise<SentMessage> {
    const first = this.messages.length === 0
    const sent = await this.target.send({ kind: 'text', text }, first ? this.opts.sendOptions : undefined)
    this.messages.push(sent)
    return sent
  }

  /* --- typing ---------------------------------------------------------------- */

  private pingTyping(): void {
    if (this.opts.typing === false || !this.target.typing) return
    try { void this.target.typing().catch(noop) } catch { /* ignore */ }
  }

  private startTyping(): void {
    if (this.typingTimer || this.opts.typing === false || !this.target.typing) return
    this.pingTyping()
    this.typingTimer = setInterval(() => this.pingTyping(), this.opts.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS)
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer)
    this.typingTimer = undefined
  }
}

/**
 * Stream `source` into `target`. `ctx.stream(source, opts)` is this function
 * bound to the current chat; use it directly for custom sinks (and tests).
 * Rejects with the source's error (after flushing what was produced) or with the
 * first send error.
 */
export function streamText(target: StreamTarget, source: StreamSource, opts: StreamOptions = {}): Promise<StreamResult> {
  return new StreamSession(target, opts).run(source)
}
