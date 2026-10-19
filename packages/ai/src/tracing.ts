/**
 * Tracing of model and tool calls through the core's `BotTracing` (`bot.tracing`; the
 * aiPlugin passes it, a standalone `AIClient` takes `AIClientOptions.tracing`).
 *
 * Spans follow the OpenTelemetry GenAI conventions: `chat {model}` (kind client) per
 * model call with the request/response model, token usage and finish reason, and
 * `execute_tool {name}` per tool call with its outcome. Prompts, completions, tool
 * arguments and results are NEVER recorded.
 *
 * Without tracing (or with a disabled one) every helper calls straight through.
 */
import { TRACE_ATTR, type BotSpan, type BotTracing, type TraceAttributes } from '@bot-wa/core'

import type { GenerateResult } from './types.js'

/** What a model call is for (`bot.ai.purpose`). */
export type ModelPurpose = 'reply' | 'ask' | 'generate' | 'memory' | 'tool_step'

export interface ModelCallInfo {
  purpose: ModelPurpose
  /** `gen_ai.provider.name` (e.g. `anthropic`, `openai`). */
  provider: string
  model?: string
  maxTokens?: number
  /** Tool loop step (1-based). */
  step?: number
  streamed?: boolean
}

/** The tracing to use: `undefined` when absent or disabled. */
export function activeTracing(tracing: BotTracing | undefined): BotTracing | undefined {
  return tracing?.enabled ? tracing : undefined
}

function requestAttributes(info: ModelCallInfo): TraceAttributes {
  return {
    [TRACE_ATTR.genAiOperation]: 'chat',
    [TRACE_ATTR.genAiProvider]: info.provider,
    [TRACE_ATTR.genAiRequestModel]: info.model,
    [TRACE_ATTR.genAiRequestMaxTokens]: info.maxTokens,
    [TRACE_ATTR.aiPurpose]: info.purpose,
    [TRACE_ATTR.aiStep]: info.step,
    [TRACE_ATTR.aiStreamed]: info.streamed ? true : undefined,
  }
}

/** Response attributes of a finished model call (no text). */
export function setResponseAttributes(
  span: BotSpan,
  r: { model?: string; stopReason?: string; usage?: { input: number; output: number } },
): void {
  span.setAttributes({
    [TRACE_ATTR.genAiResponseModel]: r.model || undefined,
    [TRACE_ATTR.genAiInputTokens]: r.usage?.input,
    [TRACE_ATTR.genAiOutputTokens]: r.usage?.output,
    [TRACE_ATTR.genAiFinishReasons]: r.stopReason ? [r.stopReason] : undefined,
  })
}

/** A failed model call: sanitized error; an AI timeout is `error.type = 'timeout'`. */
export function recordModelError(tracing: BotTracing, span: BotSpan, error: unknown): void {
  tracing.recordError(span, error)
  if ((error as { name?: unknown } | null)?.name === 'AITimeoutError') span.setAttribute(TRACE_ATTR.errorType, 'timeout')
}

export function startModelSpan(tracing: BotTracing, info: ModelCallInfo): BotSpan {
  return tracing.startSpan(info.model ? `chat ${info.model}` : 'chat', { kind: 'client', attributes: requestAttributes(info) })
}

/**
 * One non-streaming model call inside a `chat {model}` span. Returns `op`'s own promise
 * (the span ends on a side branch).
 */
export function traceModelCall(
  tracing: BotTracing | undefined,
  info: ModelCallInfo,
  op: () => Promise<GenerateResult>,
): Promise<GenerateResult> {
  const t = activeTracing(tracing)
  if (!t) return op()
  const span = startModelSpan(t, info)
  let p: Promise<GenerateResult>
  try {
    p = t.withSpan(span, op)
  } catch (error) {
    recordModelError(t, span, error)
    span.end()
    throw error
  }
  p.then((r) => { setResponseAttributes(span, r); span.end() }, (error: unknown) => { recordModelError(t, span, error); span.end() })
  return p
}

/** Stream-end info the provider reports (`GenerateInput.onStreamEnd`). */
export type StreamEndInfo = { stopReason?: string; usage?: { input: number; output: number } }

/**
 * A streamed model call: the `chat {model}` span starts at the first `next()` and ends
 * when the stream is done, throws, or is stopped early (`return()` → `bot.ai.cancelled`).
 * `open(onStreamEnd)` creates the provider stream; it receives the span's stream-end
 * recorder to chain into `GenerateInput.onStreamEnd`.
 */
export function traceStream(
  tracing: BotTracing,
  info: ModelCallInfo,
  open: (onStreamEnd: (end: StreamEndInfo) => void) => AsyncIterable<string>,
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let span: BotSpan | undefined
      let inner: AsyncIterator<string> | undefined
      let end: StreamEndInfo | undefined
      const finish = (outcome: 'done' | 'cancelled', error?: unknown): void => {
        if (!span) return
        const s = span
        span = undefined
        if (end) setResponseAttributes(s, { ...end, model: undefined })
        if (outcome === 'cancelled') s.setAttribute(TRACE_ATTR.aiCancelled, true)
        if (error !== undefined) recordModelError(tracing, s, error)
        s.end()
      }
      const start = (): AsyncIterator<string> => {
        if (inner) return inner
        span = startModelSpan(tracing, { ...info, streamed: true })
        inner = tracing.withSpan(span, () => open((e) => { end = e })[Symbol.asyncIterator]())
        return inner
      }
      return {
        async next(): Promise<IteratorResult<string>> {
          const it = start()
          try {
            const r = await (span ? tracing.withSpan(span, () => it.next()) : it.next())
            if (r.done) finish('done')
            return r
          } catch (error) {
            finish('done', error)
            throw error
          }
        },
        async return(value?: unknown): Promise<IteratorResult<string>> {
          finish('cancelled')
          const r = await inner?.return?.(value)
          return r ?? { done: true, value: undefined }
        },
        async throw(error?: unknown): Promise<IteratorResult<string>> {
          finish('done', error)
          if (inner?.throw) return inner.throw(error)
          throw error
        },
      }
    },
  }
}

/** Tool loop event type → `bot.ai.tool.outcome`. */
const TOOL_OUTCOMES: Record<string, string> = {
  'tool.result': 'ok',
  'tool.error': 'error',
  'tool.timeout': 'timeout',
  'tool.invalid_args': 'invalid_args',
  'tool.unknown': 'unknown',
  'tool.duplicate': 'duplicate',
  'tool.confirm.denied': 'confirm.denied',
  'tool.confirm.replied': 'confirm.replied',
  'tool.confirm.cancelled': 'confirm.cancelled',
}

/** The `execute_tool {name}` span of one tool call, fed by the loop's own events. */
export class ToolCallSpan {
  private outcome?: string
  constructor(private readonly tracing: BotTracing, readonly span: BotSpan) {}

  static start(tracing: BotTracing, call: { name: string; id: string }, step: number): ToolCallSpan {
    const span = tracing.startSpan(`execute_tool ${call.name}`, {
      attributes: {
        [TRACE_ATTR.genAiOperation]: 'execute_tool',
        [TRACE_ATTR.genAiToolName]: call.name,
        [TRACE_ATTR.genAiToolCallId]: call.id,
        [TRACE_ATTR.aiStep]: step,
      },
    })
    return new ToolCallSpan(tracing, span)
  }

  /** A loop event of this call (`AIToolEvent.type`). */
  event(type: string): void {
    if (type === 'tool.confirm.requested') this.span.addEvent('confirm.requested')
    else if (type === 'tool.confirm.approved') this.span.addEvent('confirm.approved')
    const outcome = TOOL_OUTCOMES[type]
    if (outcome) this.outcome = outcome
  }

  end(error?: unknown): void {
    if (error !== undefined && this.outcome !== 'confirm.cancelled') this.tracing.recordError(this.span, error)
    const outcome = this.outcome ?? (error !== undefined ? 'error' : undefined)
    this.span.setAttribute(TRACE_ATTR.aiToolOutcome, outcome)
    if (outcome === 'error' || outcome === 'timeout') this.span.setStatus({ code: 'error' })
    if (outcome === 'timeout') this.span.setAttribute(TRACE_ATTR.errorType, 'timeout')
    this.span.end()
  }
}
