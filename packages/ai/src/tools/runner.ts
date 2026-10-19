import type { MessageContext } from '@bot-wa/core'
import { AI_MESSAGES, aiOverride, aiText, type AITranslatable } from '../i18n.js'
import type { AIChatMessage, GenerateInput, GenerateResult } from '../types.js'
import { toolDefinitions, validateArgs } from './schema.js'
import { DEFAULT_DEDUPE_WINDOW_MS, type ChatToolLedger } from './ledger.js'
import { agoText, argLines, summarizeValue, toolTitle } from './present.js'
import {
  AIToolCancelledError,
  type AITool, type AIToolCall, type AIToolEvent, type AIToolExecution, type AIToolResult, type AIToolSet,
  type ToolConfirmation, type ToolConfirmer, type ToolConfirmReply,
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
  /** Successful side-effecting runs of this chat (repeat notice in confirmations, `dedupe`). */
  ledger?: ChatToolLedger
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
 * the localized `ai.tools.confirm` message in `ctx`'s language (Spanish without a context)
 * with the tool's `title` (or humanized name) and its `confirmLines(args)`, else the
 * arguments as short `• ` lines (values shown with the tool's `labels`) — never the model-facing description nor raw JSON. With `previous` (the tool already
 * ran in this chat) a localized `ai.tools.confirmRepeat` line goes first.
 *
 * With `opts.buttons` (the answer is collected with Yes/No buttons) the default
 * message is `ai.tools.confirmButtons` (no "(yes/no)" hint) — or the bot's own
 * `ai.tools.confirm` override when it translates only that one. `confirmMessage`
 * is used as is in both cases.
 */
export function defaultConfirmPrompt(
  name: string,
  tool: AITool<unknown>,
  args: unknown,
  ctx?: AITranslatable,
  previous?: AIToolExecution,
  now: number = Date.now(),
  opts: { buttons?: boolean } = {},
): string {
  const title = toolTitle(name, tool)
  let prompt: string
  if (typeof tool.confirmMessage === 'string') prompt = tool.confirmMessage
  else if (typeof tool.confirmMessage === 'function') prompt = tool.confirmMessage(args)
  else {
    const lines = tool.confirmLines ? tool.confirmLines(args) : argLines(args, ctx, tool.labels)
    const params = { tool: title, args: lines.length ? `\n${lines.join('\n')}` : '' }
    prompt = opts.buttons
      ? aiOverride(ctx, AI_MESSAGES.toolConfirmButtons, params)
        ?? aiOverride(ctx, AI_MESSAGES.toolConfirm, params)
        ?? aiText(ctx, AI_MESSAGES.toolConfirmButtons, params)
      : aiText(ctx, AI_MESSAGES.toolConfirm, params)
  }
  if (!previous) return prompt
  const repeat = aiText(ctx, AI_MESSAGES.toolConfirmRepeat, {
    tool: title,
    ago: agoText(now - previous.at, ctx),
    result: summarizeValue(previous.result, ctx) || '—',
  })
  return `${repeat}\n\n${prompt}`
}

/** Tool result sent to the model when a call was not executed (JSON, so the model can read the reason). */
function notExecuted(reason: 'user_replied' | 'duplicate', extra: Record<string, unknown>): string {
  return JSON.stringify({ executed: false, reason, ...extra })
}

function dedupeWindow(tool: AITool<unknown>): number | undefined {
  if (!tool.dedupe) return undefined
  return tool.dedupe === 'args' ? DEFAULT_DEDUPE_WINDOW_MS : Math.max(0, tool.dedupe.windowMs)
}

/** A handler result reporting a failure: a plain object with a non-empty `error`. */
function isErrorResult(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const error = (value as { error?: unknown }).error
  return error !== undefined && error !== null && error !== false && error !== ''
}

function isReply(a: ToolConfirmation): a is ToolConfirmReply {
  return typeof a === 'object' && a !== null && typeof (a as { reply?: unknown }).reply === 'string'
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
      // Validated BEFORE any confirmation: the user is never asked about a call that cannot run.
      return fail(`Error: invalid arguments for "${call.name}": ${v.error}. It was not run and the user was not asked. ` +
        'Fix the arguments (use only the allowed values of the schema) and call it again, or ask the user what they meant.')
    }
    // An aborted turn (caller signal) must not ask for confirmations nor run more tools.
    opts.signal?.throwIfAborted()
    emit({ ...base, type: 'tool.call', args: v.data })

    const ledger = opts.ledger
    const window = dedupeWindow(tool)
    if (ledger && window !== undefined) {
      const dup = ledger.find(call.name, v.data, window)
      if (dup) {
        emit({ ...base, type: 'tool.duplicate', args: v.data })
        return {
          callId: call.id,
          name: call.name,
          content: notExecuted('duplicate', {
            previous: { result: dup.result, secondsAgo: Math.round((Date.now() - dup.at) / 1000) },
            instruction: `"${call.name}" already ran with these same arguments a moment ago, so it was not run again. ` +
              'Tell the user it is already done (use the previous result). Only call it again with different arguments.',
          }),
        }
      }
    }

    if (tool.confirm) {
      const previous = ledger?.last(call.name)
      const now = Date.now()
      const prompt = defaultConfirmPrompt(call.name, tool, v.data, opts.ctx, previous, now)
      const buttonsPrompt = defaultConfirmPrompt(call.name, tool, v.data, opts.ctx, previous, now, { buttons: true })
      emit({ ...base, type: 'tool.confirm.requested', args: v.data })
      const answer: ToolConfirmation = opts.confirm
        ? await opts.confirm({
            tool: call.name, callId: call.id, args: v.data, description: tool.description,
            title: toolTitle(call.name, tool), prompt, buttonsPrompt, ...(previous ? { previous } : {}),
          })
        : 'denied'
      if (answer === 'cancelled') {
        emit({ ...base, type: 'tool.confirm.cancelled' })
        throw new AIToolCancelledError(call.name)
      }
      if (isReply(answer)) {
        // Neither yes nor no (e.g. "sí pero cambia a 5 unidades"): not run, the text goes to the model.
        emit({ ...base, type: 'tool.confirm.replied' })
        return {
          callId: call.id,
          name: call.name,
          content: notExecuted('user_replied', {
            userReply: answer.reply,
            instruction: `The user answered the confirmation of "${call.name}" with this message instead of a plain yes/no, ` +
              'so the action was NOT executed. If they asked for changes, call the tool again with the corrected arguments ' +
              '(the system will ask them to confirm again); otherwise answer their message.',
          }),
        }
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
      // Side-effecting runs are remembered per chat (repeat notice / dedupe); a returned
      // `{ error }` (e.g. unknown id) did nothing, so it is not remembered as done.
      if (ledger && (tool.confirm || tool.dedupe) && !isErrorResult(value)) ledger.record(call.name, v.data, value)
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
