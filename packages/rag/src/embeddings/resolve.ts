import { RagError } from '../errors.js'
import type { Embedder } from '../types.js'
import { HashEmbedder, type HashEmbedderOptions } from './hash.js'
import { OllamaEmbedder, type OllamaEmbedderOptions } from './ollama.js'
import { OpenAIEmbedder, type OpenAIEmbedderOptions } from './openai.js'

/**
 * How to embed: a ready {@link Embedder}, a shorthand (`'local'` = hashing,
 * `'openai'`, `'ollama'`) or a provider config object.
 */
export type EmbeddingsConfig =
  | Embedder
  | 'local'
  | 'openai'
  | 'ollama'
  | ({ provider: 'local' } & HashEmbedderOptions)
  | ({ provider: 'openai' } & OpenAIEmbedderOptions)
  | ({ provider: 'ollama' } & OllamaEmbedderOptions)

/** Build the embedder described by `config` (default: local hashing). */
export function resolveEmbedder(config: EmbeddingsConfig = 'local'): Embedder {
  if (typeof config === 'string') {
    if (config === 'local') return new HashEmbedder()
    if (config === 'openai') return new OpenAIEmbedder()
    if (config === 'ollama') return new OllamaEmbedder()
    throw new RagError('INVALID_OPTIONS', `unknown embeddings provider: ${String(config)}`)
  }
  if ('embed' in config && typeof config.embed === 'function') return config
  if ('provider' in config) {
    if (config.provider === 'local') return new HashEmbedder(config)
    if (config.provider === 'openai') return new OpenAIEmbedder(config)
    if (config.provider === 'ollama') return new OllamaEmbedder(config)
  }
  throw new RagError('INVALID_OPTIONS', 'invalid embeddings config')
}
