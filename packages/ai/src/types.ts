export type { AIMessage } from '@bot-wa/core'
import type { StreamOptions, TextFormat } from '@bot-wa/core'
import type { PresetName } from './providers/presets.js'
import type { AIMemoryConfig } from './memory/MemoryManager.js'
import type { AIRagConfig, AIRetriever } from './rag.js'
import type { AIToolCall, AIToolDefinition, AIToolEvent, AIToolResult, AIToolSet } from './tools/types.js'

/**
 * One turn of a model exchange. Plain `AIMessage`s (user/assistant text) are the
 * persisted history; the tool loop adds assistant turns carrying `toolCalls`
 * and `tool` turns carrying the results. Providers map them to their native shape.
 */
export type AIChatMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      /** Tool calls the model requested in this turn. */
      toolCalls?: AIToolCall[]
      /** Provider-native turn content to replay verbatim (e.g. Anthropic thinking + tool_use blocks). */
      providerData?: unknown
    }
  | { role: 'tool'; content: string; results: AIToolResult[] }

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Which AI backend to use. Besides the three native providers, any OpenAI-
 * compatible preset (DeepSeek, Qwen, GLM, Kimi, Groq, OpenRouter, Mistral,
 * Grok, Together) is accepted — each resolves to the OpenAI client pointed at
 * that vendor's endpoint.
 */
export type AIProviderName = 'anthropic' | 'openai' | 'ollama' | 'gemini' | PresetName

export interface GenerateInput {
  system?: string
  messages: AIChatMessage[]
  model?: string
  maxTokens?: number
  /**
   * Soft output-token cap used when `maxTokens` is not set: providers with a
   * built-in cap (Anthropic, OpenAI-compatible, Gemini) apply it instead of their
   * configured/default one; providers without a default cap (Ollama) ignore it,
   * so a reasoning model is not cut off by a budget nobody asked for.
   */
  defaultMaxTokens?: number
  effort?: Effort
  signal?: AbortSignal
  /** Tools the model may call this turn (native function/tool calling). */
  tools?: AIToolDefinition[]
  /**
   * Streaming only: called once when the provider stream ends normally, with the
   * provider's stop reason when it reports one (e.g. `'refusal'`, `'end_turn'`).
   */
  onStreamEnd?: (info: { stopReason?: string }) => void
}
export interface GenerateResult {
  text: string
  model: string
  stopReason?: string
  usage?: { input: number; output: number }
  /** Tool calls requested by the model (empty/absent → final answer). */
  toolCalls?: AIToolCall[]
  /** Provider-native assistant content to replay in the next step (see {@link AIChatMessage}). */
  providerData?: unknown
}
export interface AIProvider {
  readonly name: string
  generate(input: GenerateInput): Promise<GenerateResult>
  stream(input: GenerateInput): AsyncIterable<string>
}
export interface AIConfig {
  provider?: AIProviderName
  model?: string
  apiKey?: string
  baseUrl?: string
  persona?: string
  maxTokens?: number
  effort?: Effort
  /**
   * Hard timeout (ms) for a single non-streaming AI call. On expiry the request
   * is aborted (via AbortSignal where the SDK honors it) AND the promise rejects,
   * so a hung provider can never block the per-chat FIFO queue forever.
   * Default 60000. Set 0 to disable (not recommended for the autoresponder).
   */
  timeoutMs?: number
  context?: { maxMessages?: number }
  autoReply?: boolean
  resetCommand?: boolean
  errorMessage?: string
  refusalMessage?: string
  humanizeTyping?: boolean
  /**
   * Long-term per-user memory (FEATURES.md #30): facts stored in `ctx.user`
   * (namespace `'ai.memory'`) and injected into the autoreply. `true` = defaults.
   * `ctx.tools.ai.memory(userId)` / `remember()` / `forget()` work even without it.
   */
  memory?: boolean | AIMemoryConfig
  /**
   * Retrieval Augmented Generation (FEATURES.md #29): a retriever such as
   * `createRag({ documents })` from `@bot-wa/rag`, or `{ retriever, topK, appendSources }`.
   */
  rag?: AIRetriever | AIRagConfig
  /**
   * Tools the model may call (native tool/function calling). Each tool has a
   * `description`, an argument `schema` (JSON Schema or `safeParse`-compatible),
   * a `handler` and optional `confirm: true` for human approval.
   */
  tools?: AIToolSet
  /** Max model calls per turn in the tool loop (tool calls of the last one are not run). Default 5. */
  maxSteps?: number
  /** Default per-tool timeout (ms). Default 15000. */
  toolTimeoutMs?: number
  /** Reply when the tool loop hits `maxSteps` without a final answer. */
  maxStepsMessage?: string
  /** Confirmation dialog for `confirm: true` tools (autoreply). */
  toolConfirm?: {
    /** Answers accepted as "yes" (normalized, case/accents-insensitive). Default `DEFAULT_YES`: si (also "sí"), s, yes, y, ok, okay, confirmo, confirmar, dale, claro, de acuerdo, acepto, 1. */
    yes?: string[]
    /** Answers taken as "no" (same normalization). Default `DEFAULT_NO`: no, n, nop, nope, cancelar, cancela, cancelo, cancel, negativo, mejor no, no gracias, ... */
    no?: string[]
    /** How long to wait for the answer. Default '2m'. */
    timeout?: number | string
    /**
     * Ask with native Yes/No buttons (localized `ai.tools.button.yes` / `.no`) when the
     * chat's provider renders them (`capabilities.buttons`: Telegram, WhatsApp Cloud API,
     * Discord, Messenger, Instagram…); elsewhere the question asks for a typed yes/no.
     * A press resolves the confirmation like typing the answer, which keeps working.
     * `false` always asks for a typed answer. Default `true`.
     */
    buttons?: boolean
    /**
     * On a channel that cannot edit messages (WhatsApp Cloud API, Messenger, Instagram:
     * the buttons stay on screen), reply a short localized `ai.tools.confirmAnswered`
     * ("Answer received: Yes.") after a press answers the confirmation. Where the
     * provider edits, the buttons are replaced by the answer instead. Default `false`
     * (those channels already show the user's pick as their own message).
     */
    answeredNotice?: boolean
    /**
     * On a channel that cannot edit messages, reply a short localized
     * `ai.tools.confirmExpired` ("That confirmation is no longer active.") to a press on a
     * confirmation that is no longer pending (answered, superseded, timed out). The press
     * is always acknowledged and ignored; a chat in human handoff gets no notice. Default `true`.
     */
    expiredNotice?: boolean
    /**
     * System prompt note telling the model which tools the system confirms
     * itself (so it does not ask "shall I?" before calling them) and which
     * side-effecting tools already ran in the chat. Localized. `false` turns it
     * off; a string replaces the confirm note. Default `true`.
     */
    systemNote?: boolean | string
  }
  /** Audit hook for every tool loop event (also emitted on the bot as `'ai.tool'`). */
  onToolEvent?: (event: AIToolEvent) => void
  /**
   * Stream the autoresponder's answer with `ctx.stream()` (native drafts on
   * Telegram, live edits on Discord, sentence chunks with typing on WhatsApp)
   * instead of one message at the end. `true` uses the defaults; an object tunes
   * the `StreamOptions`. Default: off (one message). Falls back to the one-shot
   * reply when the core has no `ctx.stream`.
   */
  stream?: boolean | AIStreamConfig
  /**
   * Convert the model's Markdown (`**bold**`, `# heading`, `[link](url)`, `- item`)
   * before sending the autoreply: `'auto'` (default) follows the chat's format,
   * `ctx.textFormat` — the provider's per-chat `textFormatFor(chatId)` (Twilio:
   * WhatsApp vs SMS chats), else its `capabilities.textFormat` (`*bold*` on
   * WhatsApp, markers stripped on SMS/Telegram/Messenger/Instagram, untouched on
   * Discord and on providers that declare neither); a {@link TextFormat} forces
   * one; `false` sends the text as is.
   * The stored history keeps the model's original text.
   */
  format?: 'auto' | TextFormat | false
}

/** {@link AIConfig.stream} as an object: `StreamOptions` for the autoresponder. */
export type AIStreamConfig = Omit<StreamOptions, 'signal' | 'sendOptions'> & {
  /** Default true; `false` disables streaming while keeping the options around. */
  enabled?: boolean
}
