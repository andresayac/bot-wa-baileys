/** JSON-serialisable metadata attached to a document and inherited by its chunks. */
export type RagMetadata = Record<string, string | number | boolean | null>

/** A loaded document, before chunking. */
export interface RagDocument {
  /** Stable id (defaults to the source). Re-adding the same id replaces its chunks. */
  id: string
  /** Plain text (markdown is kept as-is). */
  text: string
  /** Human-readable origin used in citations (file path, URL, title...). */
  source: string
  /** Format hint: markdown documents get heading-aware chunking. */
  format?: 'markdown' | 'text'
  metadata?: RagMetadata
}

/** A piece of a document — the unit that is embedded and retrieved. */
export interface RagChunk {
  /** `${docId}#${index}`. */
  id: string
  docId: string
  source: string
  /** 0-based position of the chunk inside its document. */
  index: number
  /** Heading path for markdown documents (`'Envíos › Plazos'`). */
  section?: string
  text: string
  metadata?: RagMetadata
}

/** One retrieval hit. Structurally compatible with `AIRetrievedChunk` of `@botmesh/ai`. */
export interface RetrievedChunk extends RagChunk {
  /** Cosine similarity with the query, in [-1, 1] (higher is closer). */
  score: number
  /** Short label for citations: `'faq.md › Envíos'` or `'faq.md#2'`. */
  citation: string
}

/** Options of {@link Embedder} / retrieval calls that may be cancelled. */
export interface EmbedOptions {
  signal?: AbortSignal
}

/**
 * Turns texts into vectors. Implementations must return one vector per input,
 * in order, all with the same dimension.
 */
export interface Embedder {
  /**
   * Identity of the vector space (`'openai:text-embedding-3-small'`,
   * `'hash:256'`). Persisted indexes built with a different id are discarded.
   */
  readonly id: string
  embed(texts: readonly string[], options?: EmbedOptions): Promise<number[][]>
}
