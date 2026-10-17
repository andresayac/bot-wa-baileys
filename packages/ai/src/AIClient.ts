import type { AIMessage } from '@bot-wa/core'
import type { AIProvider, GenerateInput, GenerateResult, Effort } from './types.js'
import type { ContextManager } from './ContextManager.js'

export interface AIClientOptions {
  persona?: string
  model?: string
  maxTokens?: number
  effort?: Effort
  refusalMessage?: string
  /** Hard timeout (ms) per non-streaming call. Default 60000; 0 disables. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/** Thrown when an AI call exceeds its configured timeout. */
export class AITimeoutError extends Error {
  constructor(ms: number) {
    super(`AI request timed out after ${ms}ms`)
    this.name = 'AITimeoutError'
  }
}

export class AIClient {
  private readonly timeoutMs: number

  constructor(
    private provider: AIProvider,
    private ctx: ContextManager,
    private opts: AIClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private base(messages: AIMessage[]): GenerateInput {
    return {
      system: this.opts.persona,
      messages,
      model: this.opts.model,
      maxTokens: this.opts.maxTokens,
      effort: this.opts.effort,
    }
  }

  /**
   * Run an AI operation under a hard timeout. Bridges an optional caller signal
   * with an internal timeout controller: on timeout the controller aborts (so
   * SDKs that honor `signal` actually cancel the socket) AND the returned
   * promise rejects with {@link AITimeoutError}, guaranteeing the awaiter is
   * released even if the provider never honors the abort.
   */
  private async withTimeout<T>(op: (signal: AbortSignal) => Promise<T>, userSignal?: AbortSignal): Promise<T> {
    const ctrl = new AbortController()
    const onUserAbort = () => ctrl.abort()
    if (userSignal) {
      if (userSignal.aborted) ctrl.abort()
      else userSignal.addEventListener('abort', onUserAbort, { once: true })
    }
    if (this.timeoutMs <= 0) {
      try { return await op(ctrl.signal) }
      finally { if (userSignal) userSignal.removeEventListener('abort', onUserAbort) }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      // Reject FIRST, then abort: otherwise abort() can synchronously reject the
      // provider promise (via its own signal listener) and win the race, so the
      // caller would sometimes see the provider's abort error instead of a
      // deterministic AITimeoutError. The abort still fires to cancel the socket.
      timer = setTimeout(() => { reject(new AITimeoutError(this.timeoutMs)); ctrl.abort() }, this.timeoutMs)
    })
    try {
      return await Promise.race([op(ctrl.signal), timeout])
    } finally {
      if (timer) clearTimeout(timer)
      if (userSignal) userSignal.removeEventListener('abort', onUserAbort)
    }
  }

  async ask(prompt: string, opts?: { signal?: AbortSignal }): Promise<string> {
    const r = await this.withTimeout(
      (signal) => this.provider.generate({ ...this.base([{ role: 'user', content: prompt }]), signal }),
      opts?.signal,
    )
    return r.stopReason === 'refusal' ? (this.opts.refusalMessage ?? 'No puedo ayudar con eso.') : r.text
  }

  async generate(input: Partial<GenerateInput> & { messages: AIMessage[] }): Promise<GenerateResult> {
    // `signal` (the internal timeout controller) MUST win over input.signal:
    // withTimeout already bridges the caller's input.signal into it, and only
    // this signal is aborted on timeout — so the provider socket gets cancelled.
    return this.withTimeout(
      (signal) => this.provider.generate({ ...this.base(input.messages), ...input, signal }),
      input.signal,
    )
  }

  stream(input: Partial<GenerateInput> & { messages: AIMessage[] }): AsyncIterable<string> {
    // Streaming passes the caller's signal straight through; the timeout guard
    // applies to non-streaming calls (a stream's duration is legitimately open-ended).
    return this.provider.stream({ ...this.base(input.messages), ...input })
  }

  /**
   * Streaming twin of {@link replyInChat}: yields the answer piece by piece (feed
   * it to `ctx.stream()`). The turn (user + assistant) is stored once the stream
   * ends — also when the consumer stops early (the partial answer is kept, and the
   * provider request is aborted) — but not when the provider fails. `timeoutMs`
   * applies as an IDLE timeout: no chunk for that long → {@link AITimeoutError}.
   *
   * @example
   * ```ts
   * await ctx.stream(ctx.tools.ai.streamReplyInChat(chatKeyOf(ctx), ctx.body))
   * ```
   */
  async *streamReplyInChat(chatKey: string, userText: string, opts?: { signal?: AbortSignal }): AsyncGenerator<string, void, undefined> {
    const history = await this.ctx.history(chatKey)
    const messages: AIMessage[] = [...history, { role: 'user', content: userText }]
    const ctrl = new AbortController()
    const onUserAbort = () => ctrl.abort()
    if (opts?.signal) {
      if (opts.signal.aborted) ctrl.abort()
      else opts.signal.addEventListener('abort', onUserAbort, { once: true })
    }
    const iterator = this.provider.stream({ ...this.base(messages), signal: ctrl.signal })[Symbol.asyncIterator]()
    let text = ''
    let completed = false
    let failed = false
    try {
      for (;;) {
        const r = await this.nextWithIdleTimeout(iterator, ctrl)
        if (r.done) break
        if (typeof r.value !== 'string' || !r.value) continue
        text += r.value
        yield r.value
      }
      completed = true
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (opts?.signal) opts.signal.removeEventListener('abort', onUserAbort)
      if (!completed) {
        ctrl.abort()
        try { void Promise.resolve(iterator.return?.()).catch(() => undefined) } catch { /* ignore */ }
      }
      if (!failed && text) {
        await this.ctx.appendMany(chatKey, [
          { role: 'user', content: userText },
          { role: 'assistant', content: text },
        ])
      }
    }
  }

  private async nextWithIdleTimeout(iterator: AsyncIterator<string>, ctrl: AbortController): Promise<IteratorResult<string>> {
    const next = iterator.next()
    if (this.timeoutMs <= 0) return next
    next.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new AITimeoutError(this.timeoutMs)); ctrl.abort() }, this.timeoutMs)
    })
    try {
      return await Promise.race([next, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async replyInChat(chatKey: string, userText: string, opts?: { signal?: AbortSignal }): Promise<string> {
    const history = await this.ctx.history(chatKey)
    const messages: AIMessage[] = [...history, { role: 'user', content: userText }]
    const r = await this.withTimeout(
      (signal) => this.provider.generate({ ...this.base(messages), signal }),
      opts?.signal,
    )
    if (r.stopReason === 'refusal') {
      return this.opts.refusalMessage ?? 'No puedo ayudar con eso.'
    }
    // Single store write for the whole turn (user + assistant).
    await this.ctx.appendMany(chatKey, [
      { role: 'user', content: userText },
      { role: 'assistant', content: r.text },
    ])
    return r.text
  }
}
