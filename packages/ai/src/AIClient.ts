import type { AIMessage, MessageContext } from '@bot-wa/core'
import type { AIChatMessage, AIProvider, GenerateInput, GenerateResult, Effort } from './types.js'
import type { ContextManager } from './ContextManager.js'
import type { AIToolEvent, AIToolSet, ToolConfirmer } from './tools/types.js'
import { runToolLoop, type ToolLoopResult } from './tools/runner.js'

export interface AIClientOptions {
  persona?: string
  model?: string
  maxTokens?: number
  effort?: Effort
  refusalMessage?: string
  /** Hard timeout (ms) per non-streaming call. Default 60000; 0 disables. */
  timeoutMs?: number
  /** Tools the model may call from `ask` / `replyInChat` / `runTools`. */
  tools?: AIToolSet
  /** Max model calls per turn in the tool loop. Default 5. */
  maxSteps?: number
  /** Default per-tool timeout (ms). Default 15000; 0 disables. */
  toolTimeoutMs?: number
  /** Reply when the loop reaches `maxSteps` without a final answer. */
  maxStepsMessage?: string
  /** Audit sink for every tool loop event. */
  onToolEvent?: (event: AIToolEvent) => void
}

/** Per-call options of the tool-aware methods. */
export interface AIToolCallOptions {
  signal?: AbortSignal
  /** Message context of the turn — handed to tool handlers as `tctx.ctx`. */
  ctx?: MessageContext
  /**
   * Asks a human before running `confirm: true` tools. Inside your own
   * conversation use `confirmWith(c)`. Without it those tools are denied.
   */
  confirm?: ToolConfirmer
  /** Conversation key passed to tool handlers and audit events. */
  chatKey?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_REFUSAL = 'No puedo ayudar con eso.'

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

  /** True when tools are configured (the tool loop is used by `ask` / `replyInChat`). */
  get hasTools(): boolean {
    return !!this.opts.tools && Object.keys(this.opts.tools).length > 0
  }

  private base(messages: AIChatMessage[]): GenerateInput {
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

  async ask(prompt: string, opts?: AIToolCallOptions): Promise<string> {
    const messages: AIChatMessage[] = [{ role: 'user', content: prompt }]
    if (this.hasTools) {
      const r = await this.runTools({ messages }, opts)
      return r.stopReason === 'refusal' ? (this.opts.refusalMessage ?? DEFAULT_REFUSAL) : r.text
    }
    const r = await this.withTimeout(
      (signal) => this.provider.generate({ ...this.base(messages), signal }),
      opts?.signal,
    )
    return r.stopReason === 'refusal' ? (this.opts.refusalMessage ?? DEFAULT_REFUSAL) : r.text
  }

  async generate(input: Partial<GenerateInput> & { messages: AIChatMessage[] }): Promise<GenerateResult> {
    // `signal` (the internal timeout controller) MUST win over input.signal:
    // withTimeout already bridges the caller's input.signal into it, and only
    // this signal is aborted on timeout — so the provider socket gets cancelled.
    return this.withTimeout(
      (signal) => this.provider.generate({ ...this.base(input.messages), ...input, signal }),
      input.signal,
    )
  }

  stream(input: Partial<GenerateInput> & { messages: AIChatMessage[] }): AsyncIterable<string> {
    // Streaming passes the caller's signal straight through; the timeout guard
    // applies to non-streaming calls (a stream's duration is legitimately open-ended).
    return this.provider.stream({ ...this.base(input.messages), ...input })
  }

  /**
   * Run the multi-step tool loop over `input.messages` with the configured
   * tools (or `input.tools`-less when none). Each model call gets the client's
   * timeout; each tool its own (`toolTimeoutMs` / `tool.timeoutMs`). Throws
   * `AIToolCancelledError` when a confirmation is cancelled.
   */
  async runTools(
    input: Partial<Omit<GenerateInput, 'tools'>> & { messages: AIChatMessage[] },
    opts: AIToolCallOptions = {},
  ): Promise<ToolLoopResult> {
    const { messages, signal: _ignored, ...rest } = input
    return runToolLoop({
      tools: this.opts.tools ?? {},
      generate: (gi) => this.withTimeout((signal) => this.provider.generate({ ...gi, signal }), opts.signal ?? input.signal),
      base: { ...this.base([]), ...rest },
      messages,
      maxSteps: this.opts.maxSteps,
      toolTimeoutMs: this.opts.toolTimeoutMs,
      maxStepsMessage: this.opts.maxStepsMessage,
      confirm: opts.confirm,
      onEvent: this.opts.onToolEvent,
      chatKey: opts.chatKey,
      ctx: opts.ctx,
      signal: opts.signal ?? input.signal,
    })
  }

  async replyInChat(chatKey: string, userText: string, opts?: AIToolCallOptions): Promise<string> {
    const history = await this.ctx.history(chatKey)
    const messages: AIChatMessage[] = [...history, { role: 'user', content: userText }]
    let r: { text: string; stopReason?: string }
    if (this.hasTools) {
      r = await this.runTools({ messages }, { ...opts, chatKey: opts?.chatKey ?? chatKey })
    } else {
      r = await this.withTimeout(
        (signal) => this.provider.generate({ ...this.base(messages), signal }),
        opts?.signal,
      )
    }
    // Cancelled while the turn was running (e.g. `/reset` cleared the history meanwhile):
    // never write the stale turn back nor answer it.
    opts?.signal?.throwIfAborted()
    if (r.stopReason === 'refusal') {
      return this.opts.refusalMessage ?? DEFAULT_REFUSAL
    }
    // Single store write for the whole turn (user + assistant). Intermediate tool
    // turns are not persisted: the history stays plain user/assistant text.
    const turn: AIMessage[] = [
      { role: 'user', content: userText },
      { role: 'assistant', content: r.text },
    ]
    await this.ctx.appendMany(chatKey, turn)
    return r.text
  }
}
