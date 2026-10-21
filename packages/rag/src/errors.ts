/** Machine-readable reason of a {@link RagError}. */
export type RagErrorCode =
  | 'INVALID_OPTIONS'
  | 'UNSUPPORTED_FORMAT'
  | 'LOAD_FAILED'
  | 'MISSING_DEPENDENCY'
  | 'EMBEDDING_FAILED'
  | 'INVALID_INDEX'

/** Every failure raised by `@botmesh/rag` (loading, embedding, persistence). */
export class RagError extends Error {
  constructor(readonly code: RagErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RagError'
  }
}
