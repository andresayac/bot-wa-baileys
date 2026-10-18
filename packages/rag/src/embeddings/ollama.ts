import type { Embedder, EmbedOptions } from '../types.js'
import { assertVectors, postJson, type EmbeddingHttpOptions } from './http.js'

export interface OllamaEmbedderOptions {
  /** Default `'nomic-embed-text'`. */
  model?: string
  /** Default `'http://localhost:11434'`. */
  baseUrl?: string
  /**
   * Transport options. Because Ollama is usually local, `allowHttp` and
   * `allowPrivateHosts` default to `true` here; set them to `false` for a
   * remote HTTPS endpoint.
   */
  http?: EmbeddingHttpOptions
}

/** Embeddings through Ollama's batch `/api/embed` endpoint. */
export class OllamaEmbedder implements Embedder {
  readonly id: string
  private readonly url: string
  private readonly model: string

  constructor(private readonly options: OllamaEmbedderOptions = {}) {
    this.model = options.model ?? 'nomic-embed-text'
    this.url = `${(options.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '')}/api/embed`
    this.id = `ollama:${this.model}`
  }

  async embed(texts: readonly string[], opts: EmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return []
    const json = (await postJson(
      this.url,
      { model: this.model, input: texts },
      {},
      { allowHttp: true, allowPrivateHosts: true, timeoutMs: 120_000, ...this.options.http },
      opts.signal,
    )) as { embeddings?: unknown }
    return assertVectors(json?.embeddings, texts.length)
  }
}
