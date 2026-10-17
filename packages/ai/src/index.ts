import type { AIClient } from './AIClient.js'

export { aiPlugin } from './plugin.js'
export { AIClient, AITimeoutError } from './AIClient.js'
export type { AIClientOptions } from './AIClient.js'
export { ContextManager } from './ContextManager.js'
export type { ConvStore } from './ContextManager.js'
export { chatKeyOf } from './chatKey.js'
export { MockAIProvider } from './MockAIProvider.js'
export type { MockOptions } from './MockAIProvider.js'
export { resolveProvider } from './providers/resolve.js'
export { AnthropicProvider } from './providers/anthropic.js'
export { OpenAIProvider } from './providers/openai.js'
export type { OpenAIProviderOptions } from './providers/openai.js'
export { OllamaProvider } from './providers/ollama.js'
export { GeminiProvider } from './providers/gemini.js'
export { LazyProvider } from './providers/LazyProvider.js'
export { PRESETS, isPreset } from './providers/presets.js'
export type { Preset, PresetName } from './providers/presets.js'
export type { AIProvider, AIMessage, AIConfig, AIProviderName, GenerateInput, GenerateResult, Effort } from './types.js'

// ai-memory-rag (FEATURES.md #29 RAG + #30 long-term memory)
export type { AIChatReply, AIAugmentStage } from './AIClient.js'
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
