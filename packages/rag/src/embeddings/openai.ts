import { RagError } from '../errors.js'
import type { Embedder, EmbedOptions } from '../types.js'
import { assertVectors, postJson, type EmbeddingHttpOptions } from './http.js'

export interface OpenAIEmbedderOptions {
  /** API key. Default `process.env.OPENAI_API_KEY`. */
  apiKey?: string
  /** Default `'text-embedding-3-small'`. */
  model?: string
  /** OpenAI-compatible base URL (`…/v1`). Default `'https://api.openai.com/v1'`. */
  baseUrl?: string
  /** Optional `dimensions` request parameter (text-embedding-3 models). */
  dimensions?: number
  /** Inputs per request. Default 96. */
  batchSize?: number
  /** Extra headers (e.g. `OpenAI-Organization`). */
  headers?: Record<string, string>
  http?: EmbeddingHttpOptions
}

interface OpenAIEmbeddingResponse {
  data?: { index?: number; embedding?: unknown }[]
}

/**
 * Embeddings through any OpenAI-compatible `/embeddings` endpoint (OpenAI,
 * Azure-style gateways, Together, Mistral, LM Studio, vLLM...) using
 * `secureFetch` — no SDK needed.
 */
export class OpenAIEmbedder implements Embedder {
  readonly id: string
  private readonly url: string
  private readonly model: string
  private readonly batchSize: number

  constructor(private readonly options: OpenAIEmbedderOptions = {}) {
    this.model = options.model ?? 'text-embedding-3-small'
    this.url = `${(options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/embeddings`
    this.batchSize = options.batchSize ?? 96
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1) {
      throw new RagError('INVALID_OPTIONS', 'batchSize must be a positive integer')
    }
    this.id = `openai:${this.model}${options.dimensions ? `:${options.dimensions}` : ''}`
  }

  async embed(texts: readonly string[], opts: EmbedOptions = {}): Promise<number[][]> {
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) throw new RagError('INVALID_OPTIONS', 'OpenAIEmbedder needs an apiKey (or OPENAI_API_KEY)')
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const input = texts.slice(i, i + this.batchSize)
      const body: Record<string, unknown> = { model: this.model, input }
      if (this.options.dimensions) body.dimensions = this.options.dimensions
      const json = (await postJson(
        this.url,
        body,
        { authorization: `Bearer ${apiKey}`, ...this.options.headers },
        this.options.http ?? {},
        opts.signal,
      )) as OpenAIEmbeddingResponse
      const data = Array.isArray(json?.data) ? [...json.data] : undefined
      data?.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      out.push(...assertVectors(data?.map((d) => d.embedding), input.length))
    }
    return out
  }
}
