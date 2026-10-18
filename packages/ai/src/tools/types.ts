/**
 * Tool calling (function calling) types for `@bot-wa/ai`.
 *
 * Tools are declared once, provider-neutrally, and each provider maps them to
 * its native shape (Anthropic `tools`/`tool_use`, OpenAI `tools`/`tool_calls`,
 * Gemini `functionDeclarations`/`functionCall`, Ollama `tools`/`tool_calls`).
 */
import type { MessageContext } from '@bot-wa/core'

/** A JSON Schema object (the `parameters` / `input_schema` sent to the model). */
export type JSONSchema = { [key: string]: unknown }

/** Result of a `safeParse`-compatible validator (zod, valibot adapters, ...). */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown }

/**
 * Any validator exposing `safeParse(input)` — e.g. a zod schema. When it also
 * exposes `toJSONSchema()` (zod v4) that is used for the model-facing schema;
 * otherwise pass {@link AITool.jsonSchema} explicitly.
 */
export interface SafeParseSchema<T = unknown> {
  safeParse(input: unknown): SafeParseResult<T>
}

/** Per-call context handed to a tool handler. */
export interface AIToolContext {
  /** Name of the tool being executed. */
  readonly tool: string
  /** Provider-assigned (or synthesized) id of this call. */
  readonly callId: string
  /** Conversation key (`chatKeyOf(ctx)`) when the call comes from a chat turn. */
  readonly chatKey?: string
  /** The message context that triggered the turn (autoreply / `replyInChat({ ctx })`). */
  readonly ctx?: MessageContext
  /** Aborted when the per-tool timeout expires or the turn is cancelled. */
  readonly signal: AbortSignal
}

/**
 * One tool the model may call.
 *
 * @typeParam TArgs - Shape of the validated arguments the handler receives.
 */
export interface AITool<TArgs = unknown> {
  /** What the tool does — the model reads this to decide when to call it. */
  description: string
  /**
   * Short human label of the action, shown to the user in the default
   * confirmation prompt (e.g. `'Crear pedido'`). Default: the tool name
   * humanized (`crear_pedido` → `Crear pedido`). The `description` is for the
   * model and is never shown to the user.
   */
  title?: string
  /**
   * Argument schema: a JSON Schema object (validated with a built-in subset
   * validator: `type`, `required`, `properties`, `enum`, `const`, `items`,
   * `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`) or a
   * `safeParse`-compatible validator (zod & co). Omitted → no arguments.
   */
  schema?: JSONSchema | SafeParseSchema<TArgs>
  /** Model-facing JSON Schema override (useful with `safeParse` validators). */
  jsonSchema?: JSONSchema
  /**
   * Executes the tool. The return value is sent back to the model (strings
   * as-is, anything else JSON-serialized). A thrown error is reported to the
   * model as a failed tool result, never to the end user.
   */
  handler(args: TArgs, tctx: AIToolContext): unknown
  /**
   * Require explicit human confirmation before running. In the autoreply the
   * bot asks the user (`sí`/`no`) through the conversation runtime, without
   * blocking the chat's FIFO queue. Without a confirmer the call is denied.
   */
  confirm?: boolean
  /**
   * Custom confirmation prompt. Default: the localized `ai.tools.confirm`
   * message with the `title` and the arguments as short readable lines
   * (`• 5 × torta_chocolate`), never raw JSON.
   */
  confirmMessage?: string | BivariantFn<TArgs, string>
  /**
   * Block repeated side effects: a call with the same (validated) arguments as
   * a successful run of this tool in the same chat within the window is not
   * run (nor confirmed); the model gets `{ executed: false, reason: 'duplicate', previous }`.
   * `'args'` uses a 10-minute window; `{ windowMs }` sets it. Off by default.
   */
  dedupe?: 'args' | { windowMs: number }
  /** Per-tool timeout in ms (overrides the client-wide `toolTimeoutMs`). */
  timeoutMs?: number
}

/** Map of tool name → definition, as passed to `aiPlugin({ tools })`. */
export type AIToolSet = Record<string, AITool<unknown>>

/**
 * A callback type checked bivariantly in its parameter (like a method), so an
 * `AITool<{ q: string }>` stays assignable to the `AITool<unknown>` of an
 * {@link AIToolSet}.
 */
export type BivariantFn<A, R> = { bivarianceHack(args: A): R }['bivarianceHack']

/** Provider-neutral tool definition sent to the model. */
export interface AIToolDefinition {
  name: string
  description: string
  /** JSON Schema of the arguments (always an object schema). */
  parameters: JSONSchema
}

/** A tool call requested by the model. */
export interface AIToolCall {
  id: string
  name: string
  /** Parsed arguments (raw object as produced by the model, before validation). */
  args: unknown
}

/** The outcome of one tool call, fed back to the model. */
export interface AIToolResult {
  callId: string
  name: string
  /** Serialized result (or error description). */
  content: string
  isError?: boolean
}

/**
 * The user answered a confirmation with something other than a clear yes/no
 * (e.g. "sí pero cambia a 5 unidades"): the tool is not run and `reply` is
 * returned to the model so it can adjust the call and ask again.
 */
export interface ToolConfirmReply {
  reply: string
}

/**
 * Answer of a {@link ToolConfirmer}. `cancelled` aborts the whole turn silently;
 * a {@link ToolConfirmReply} hands the user's free-text answer back to the model.
 */
export type ToolConfirmation = 'approved' | 'denied' | 'cancelled' | ToolConfirmReply

/** A previous successful run of a tool in the same chat (see {@link ToolConfirmRequest.previous}). */
export interface AIToolExecution {
  tool: string
  /** Validated arguments of that run. */
  args: unknown
  /** What the handler returned. */
  result: unknown
  /** ms since epoch. */
  at: number
}

/** A pending confirmation request for a `confirm: true` tool. */
export interface ToolConfirmRequest {
  tool: string
  callId: string
  args: unknown
  description: string
  /** Human label of the tool (`title`, or its humanized name). */
  title: string
  /** Rendered prompt to show the user. */
  prompt: string
  /** Last successful run of the same tool in this chat, when there is one (it is mentioned in `prompt`). */
  previous?: AIToolExecution
}

/** Asks a human whether a `confirm: true` tool may run. */
export type ToolConfirmer = (req: ToolConfirmRequest) => Promise<ToolConfirmation>

/** Audit trail event kinds emitted by the tool loop. */
export type AIToolEventType =
  | 'tool.call'
  | 'tool.confirm.requested'
  | 'tool.confirm.approved'
  | 'tool.confirm.denied'
  | 'tool.confirm.cancelled'
  | 'tool.confirm.replied'
  | 'tool.duplicate'
  | 'tool.result'
  | 'tool.error'
  | 'tool.timeout'
  | 'tool.invalid_args'
  | 'tool.unknown'
  | 'loop.max_steps'

/** One audit event of the tool loop (also emitted on the bot as `'ai.tool'`). */
export interface AIToolEvent {
  type: AIToolEventType
  /** ms since epoch. */
  at: number
  /** 1-based step of the loop (one model call per step). */
  step: number
  tool?: string
  callId?: string
  chatKey?: string
  /** Arguments as produced by the model (may contain user data — handle with care). */
  args?: unknown
  /** Tool duration in ms (`tool.result`, `tool.error`, `tool.timeout`). */
  durationMs?: number
  /** Error message (`tool.error`, `tool.timeout`, `tool.invalid_args`, `tool.unknown`). */
  error?: string
}

/** Thrown by the tool loop when a confirmation was cancelled (`/reset`, timeout, replaced conversation). */
export class AIToolCancelledError extends Error {
  constructor(public readonly tool: string) {
    super(`Tool "${tool}" confirmation was cancelled`)
    this.name = 'AIToolCancelledError'
  }
}

/**
 * Identity helper that infers `TArgs` from the schema / handler for editor
 * autocompletion: `defineTool<{ q: string }>({ ... })`.
 */
export function defineTool<TArgs = unknown>(tool: AITool<TArgs>): AITool<TArgs> {
  return tool
}
