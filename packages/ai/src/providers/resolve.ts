import type { AIProvider, AIConfig } from '../types.js'
import { loadModule } from './loadModule.js'
import { AnthropicProvider } from './anthropic.js'
import type { AnthropicLike } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import type { OpenAILike } from './openai.js'
import { OllamaProvider } from './ollama.js'

export async function resolveProvider(cfg: AIConfig): Promise<AIProvider> {
  switch (cfg.provider ?? 'anthropic') {
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
    default:
      throw new Error(`Proveedor desconocido: ${cfg.provider}`)
  }
}
