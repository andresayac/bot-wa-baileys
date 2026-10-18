import type { AIClient } from './AIClient.js'

export { aiPlugin } from './plugin.js'
export { AIClient, AITimeoutError } from './AIClient.js'
export type { AIClientOptions, AIToolCallOptions } from './AIClient.js'
export { ContextManager } from './ContextManager.js'
export type { ConvStore } from './ContextManager.js'
export { chatKeyOf } from './chatKey.js'
export { MockAIProvider } from './MockAIProvider.js'
export type { MockOptions, MockTurn } from './MockAIProvider.js'
export { resolveProvider } from './providers/resolve.js'
export { AnthropicProvider } from './providers/anthropic.js'
export { OpenAIProvider } from './providers/openai.js'
export type { OpenAIProviderOptions } from './providers/openai.js'
export { OllamaProvider } from './providers/ollama.js'
export { GeminiProvider } from './providers/gemini.js'
export { LazyProvider } from './providers/LazyProvider.js'
export { PRESETS, isPreset } from './providers/presets.js'
export type { Preset, PresetName } from './providers/presets.js'
export type { AIProvider, AIMessage, AIChatMessage, AIConfig, AIProviderName, GenerateInput, GenerateResult, Effort, AIStreamConfig } from './types.js'

// ai-tools — native tool / function calling
export { defineTool, AIToolCancelledError } from './tools/types.js'
export type {
  AITool, AIToolSet, AIToolContext, AIToolDefinition, AIToolCall, AIToolResult, AIToolEvent, AIToolEventType,
  ToolConfirmer, ToolConfirmRequest, ToolConfirmation, JSONSchema, SafeParseSchema, SafeParseResult, BivariantFn,
} from './tools/types.js'
export { AI_MESSAGES, AI_LOCALES, aiText, type AIMessageKey, type AITranslatable } from './i18n.js'
export { runToolLoop, defaultConfirmPrompt, DEFAULT_MAX_STEPS, DEFAULT_TOOL_TIMEOUT_MS } from './tools/runner.js'
export type { ToolLoopOptions, ToolLoopResult } from './tools/runner.js'
export { toolDefinitions, validateArgs, parametersOf } from './tools/schema.js'
export type { ArgsValidation } from './tools/schema.js'
export { confirmWith, isAffirmative, DEFAULT_YES } from './tools/confirm.js'
export type { ConfirmWithOptions } from './tools/confirm.js'
export { toGeminiSchema } from './providers/gemini.js'
export type { OpenAIToolCall } from './providers/openai.js'

// ai-memory-rag (FEATURES.md #29 RAG + #30 long-term memory)
export type { AIChatReply, AIAugmentStage, AIReplyOptions, AIStreamReplyOptions } from './AIClient.js'
export { MemoryManager, DEFAULT_MEMORY_NAMESPACE } from './memory/MemoryManager.js'
export type { MemoryFact, AIMemoryConfig, AIMemoryExtractConfig, RememberOptions, UserDataAccessor } from './memory/MemoryManager.js'
export { factsSchema, parseFacts } from './memory/extract.js'
export { DEFAULT_RAG_INSTRUCTIONS, ragContextBlock, citedChunks, formatSources } from './rag.js'
export type { AIRetriever, AIRetrievedChunk, AIRagConfig } from './rag.js'

/**
 * Augment `@bot-wa/core` so `ctx.tools.ai` is typed as {@link AIClient} in
 * handlers (`bot.when`, `bot.onMessage`, `bot.command`, ...) — no casts needed.
 * It applies to any project that imports `@bot-wa/ai`; the value exists at
 * runtime once `aiPlugin` is plugged into the Bot (and until it is unplugged).
 */
declare module '@bot-wa/core' {
  interface DefaultTools {
    /** Injected by `aiPlugin` via `bot.provide('ai', client)`. */
    ai: AIClient
  }
}
