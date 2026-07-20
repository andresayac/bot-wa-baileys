import type { AIProvider, AIConfig } from '../types.js'
import { loadModule } from './loadModule.js'
import { AnthropicProvider } from './anthropic.js'
import type { AnthropicLike } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import type { OpenAILike } from './openai.js'
import { OllamaProvider } from './ollama.js'
import { GeminiProvider } from './gemini.js'
import type { GeminiLike } from './gemini.js'
import { PRESETS, isPreset } from './presets.js'

/**
 * Resolve the configured AI backend. Preset names (deepseek, qwen, glm, kimi,
 * groq, openrouter, mistral, grok, together) map to the OpenAI client pointed
 * at that vendor's endpoint — no extra dependency beyond `openai`. API keys
 * fall back to each preset's conventional env var.
 */
export async function resolveProvider(cfg: AIConfig): Promise<AIProvider> {
  const name = cfg.provider ?? 'anthropic'

  if (isPreset(name)) {
    const preset = PRESETS[name]
    const mod = await loadModule<{ default: new (o: { apiKey?: string; baseURL?: string }) => OpenAILike }>(
      'openai',
      'pnpm add openai',
    )
    const apiKey = cfg.apiKey ?? process.env[preset.env]
    const baseURL = cfg.baseUrl ?? preset.baseUrl
    const client = new mod.default({ apiKey, baseURL })
    // Default the model to the preset's unless the caller overrode it.
    const presetCfg: AIConfig = cfg.model ? cfg : { ...cfg, model: preset.model }
    return new OpenAIProvider(client, presetCfg, { name, maxTokensField: preset.maxTokensField })
  }

  switch (name) {
    case 'anthropic': {
      const mod = await loadModule<{ default: new (o: { apiKey?: string }) => AnthropicLike }>(
        '@anthropic-ai/sdk',
        'pnpm add @anthropic-ai/sdk',
      )
      return new AnthropicProvider(new mod.default({ apiKey: cfg.apiKey }), cfg)
    }
    case 'openai': {
      const mod = await loadModule<{ default: new (o: { apiKey?: string; baseURL?: string }) => OpenAILike }>(
        'openai',
        'pnpm add openai',
      )
      return new OpenAIProvider(new mod.default({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl }), cfg)
    }
    case 'ollama':
      return new OllamaProvider(cfg)
    case 'gemini': {
      const mod = await loadModule<{ GoogleGenerativeAI: new (apiKey?: string) => GeminiLike }>(
        '@google/generative-ai',
        'pnpm add @google/generative-ai',
      )
      const apiKey = cfg.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
      return new GeminiProvider(new mod.GoogleGenerativeAI(apiKey), cfg)
    }
    default:
      throw new Error(`Proveedor desconocido: ${String(name)}`)
  }
}
