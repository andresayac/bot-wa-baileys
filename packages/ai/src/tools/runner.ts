import type { MessageContext } from '@bot-wa/core'
import { AI_MESSAGES, aiText, type AITranslatable } from '../i18n.js'
import type { AIChatMessage, GenerateInput, GenerateResult } from '../types.js'
import { toolDefinitions, validateArgs } from './schema.js'
import {
  AIToolCancelledError,
  type AITool, type AIToolCall, type AIToolEvent, type AIToolResult, type AIToolSet, type ToolConfirmer,
} from './types.js'

export const DEFAULT_MAX_STEPS = 5
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000
/** Spanish default of `maxStepsMessage`; the loop sends the localized `ai.tools.maxSteps` (same Spanish text). */
export const DEFAULT_MAX_STEPS_MESSAGE = 'No pude completar la solicitud. Intenta de nuevo con más detalle.'

export interface ToolLoopOptions {
  tools: AIToolSet
  /** One model call (already wrapped with the client's timeout). */
  generate(input: GenerateInput): Promise<GenerateResult>
  /** Base input (system, model, ...); `messages`/`tools` are managed by the loop. */
  base: Omit<GenerateInput, 'messages' | 'tools'>
  messages: AIChatMessage[]
  maxSteps?: number
  toolTimeoutMs?: number
  maxStepsMessage?: string
  confirm?: ToolConfirmer
  onEvent?: (event: AIToolEvent) => void
  chatKey?: string
  ctx?: MessageContext
  signal?: AbortSignal
}

export interface ToolLoopResult {
  text: string
  model: string
  stopReason?: string
  /** Model calls made. */
  steps: number
  /** Every tool result produced during the turn, in order. */
  toolResults: AIToolResult[]
  usage?: { input: number; output: number }
  /** True when the loop stopped because of `maxSteps`. */
  maxStepsReached: boolean
}

/** Thrown inside the loop when a tool exceeds its timeout. */
class ToolTimeoutError extends Error {
  constructor(tool: string, ms: number) {
    super(`Tool "${tool}" timed out after ${ms}ms`)
    this.name = 'ToolTimeoutError'
  }
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'ok'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Default confirmation prompt for a `confirm: true` tool: its `confirmMessage`, else
 * the localized `ai.tools.confirm` message in `ctx`'s language (Spanish without a context).
 */
export function defaultConfirmPrompt(name: string, tool: AITool<unknown>, args: unknown, ctx?: AITranslatable): string {
  if (typeof tool.confirmMessage === 'string') return tool.confirmMessage
  if (typeof tool.confirmMessage === 'function') return tool.confirmMessage(args)
  const shown = args && typeof args === 'object' && Object.keys(args).length > 0 ? `\n${JSON.stringify(args, null, 2)}` : ''
  return aiText(ctx, AI_MESSAGES.toolConfirm, { tool: tool.description || name, args: shown })
}

/**
 * Multi-step tool loop: call the model with the tool definitions; while it asks
 * for tools, validate the arguments, (optionally) get human confirmation, run
 * each handler under its timeout and feed the results back. Handler errors,
 * invalid arguments, unknown tools, timeouts and denials are all returned to
 * the model as failed tool results so it can recover. A cancelled confirmation
 * throws {@link AIToolCancelledError}. Tool calls requested in the last allowed
 * step (`maxSteps`) are not run, since the model could never see their results.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxSteps = Math.max(1, opts.maxSteps ?? DEFAULT_MAX_STEPS)
  const definitions = toolDefinitions(opts.tools)
  const messages: AIChatMessage[] = [...opts.messages]
  const toolResults: AIToolResult[] = []
  const usage = { input: 0, output: 0 }
  let sawUsage = false
  let last: GenerateResult | undefined

  const emit = (e: Omit<AIToolEvent, 'at' | 'chatKey'>): void => {
    if (!opts.onEvent) return
    try { opts.onEvent({ ...e, at: Date.now(), chatKey: opts.chatKey }) } catch { /* audit sinks must not break the turn */ }
  }

  const runOne = async (call: AIToolCall, step: number): Promise<AIToolResult> => {
    const base = { step, tool: call.name, callId: call.id }
    const fail = (content: string): AIToolResult => ({ callId: call.id, name: call.name, content, isError: true })
    const tool = Object.hasOwn(opts.tools, call.name) ? opts.tools[call.name] : undefined
    if (!tool) {
      emit({ ...base, type: 'tool.unknown', args: call.args, error: 'unknown tool' })
      return fail(`Error: unknown tool "${call.name}". Available: ${Object.keys(opts.tools).join(', ') || 'none'}.`)
    }
    const v = validateArgs(tool, call.args)
    if (!v.ok) {
      emit({ ...base, type: 'tool.invalid_args', args: call.args, error: v.error })
      return fail(`Error: invalid arguments for "${call.name}": ${v.error}`)
    }
    // An aborted turn (caller signal) must not ask for confirmations nor run more tools.
    opts.signal?.throwIfAborted()
    emit({ ...base, type: 'tool.call', args: v.data })

    if (tool.confirm) {
      const prompt = defaultConfirmPrompt(call.name, tool, v.data, opts.ctx)
      emit({ ...base, type: 'tool.confirm.requested', args: v.data })
      const answer = opts.confirm
        ? await opts.confirm({ tool: call.name, callId: call.id, args: v.data, description: tool.description, prompt })
        : 'denied'
      if (answer === 'cancelled') {
        emit({ ...base, type: 'tool.confirm.cancelled' })
        throw new AIToolCancelledError(call.name)
      }
      if (answer !== 'approved') {
        emit({ ...base, type: 'tool.confirm.denied' })
        return fail(opts.confirm
          ? `The user declined to run "${call.name}". Do not retry it unless the user asks again.`
          : `"${call.name}" requires human confirmation, which is not available here. It was not run.`)
      }
      emit({ ...base, type: 'tool.confirm.approved' })
    }

    const ms = tool.timeoutMs ?? opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    const ctrl = new AbortController()
    const onOuterAbort = (): void => ctrl.abort()
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort()
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const exec = Promise.resolve().then(() => tool.handler(v.data, {
        tool: call.name, callId: call.id, chatKey: opts.chatKey, ctx: opts.ctx, signal: ctrl.signal,
      }))
      const value = ms > 0
        ? await Promise.race([exec, new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reject(new ToolTimeoutError(call.name, ms)); ctrl.abort() }, ms)
          })])
        : await exec
      emit({ ...base, type: 'tool.result', durationMs: Date.now() - started })
      return { callId: call.id, name: call.name, content: serialize(value) }
    } catch (err) {
      const durationMs = Date.now() - started
      if (err instanceof ToolTimeoutError) {
        emit({ ...base, type: 'tool.timeout', durationMs, error: err.message })
        return fail(`Error: ${err.message}`)
      }
      emit({ ...base, type: 'tool.error', durationMs, error: errorMessage(err) })
      return fail(`Error: ${errorMessage(err)}`)
    } finally {
      if (timer) clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort)
    }
  }

  for (let step = 1; step <= maxSteps; step++) {
    opts.signal?.throwIfAborted()
    const r = await opts.generate({ ...opts.base, messages, tools: definitions.length ? definitions : undefined })
    last = r
    if (r.usage) { sawUsage = true; usage.input += r.usage.input; usage.output += r.usage.output }
    const calls = r.toolCalls ?? []
    if (calls.length === 0) {
      return { text: r.text, model: r.model, stopReason: r.stopReason, steps: step, toolResults, usage: sawUsage ? usage : undefined, maxStepsReached: false }
    }
    // Last step: running these calls would be pointless (the model never sees their
    // results) and harmful for side-effecting / `confirm: true` tools — stop here.
    if (step === maxSteps) break
    messages.push({ role: 'assistant', content: r.text, toolCalls: calls, providerData: r.providerData })
    const results: AIToolResult[] = []
    for (const call of calls) results.push(await runOne(call, step))
    toolResults.push(...results)
    messages.push({ role: 'tool', content: results.map((x) => x.content).join('\n'), results })
  }

  emit({ type: 'loop.max_steps', step: maxSteps })
  return {
    text: opts.maxStepsMessage ?? aiText(opts.ctx, AI_MESSAGES.maxSteps),
    model: last?.model ?? '',
    stopReason: 'max_steps',
    steps: maxSteps,
    toolResults,
    usage: sawUsage ? usage : undefined,
    maxStepsReached: true,
  }
}
