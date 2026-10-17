import { RagError } from '../errors.js'
import type { Embedder } from '../types.js'

export interface HashEmbedderOptions {
  /** Vector size. Default 512. More dimensions → fewer collisions. */
  dimensions?: number
}

/** Lowercase, strip diacritics and split into alphanumeric tokens. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
}

/** 32-bit FNV-1a. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Deterministic, dependency-free "feature hashing" embedder: word unigrams,
 * 5-char word prefixes (a poor man's stemmer: `envio`/`envios`) and word
 * bigrams are hashed into a signed bag-of-words vector, then L2-normalised.
 *
 * It captures lexical overlap, not meaning — perfect for tests, offline
 * development and small FAQ-style corpora; use a real embedding model
 * (OpenAI-compatible or Ollama) for semantic search in production.
 */
export class HashEmbedder implements Embedder {
  readonly id: string
  readonly dimensions: number

  constructor(options: HashEmbedderOptions = {}) {
    const dimensions = options.dimensions ?? 512
    if (!Number.isSafeInteger(dimensions) || dimensions < 8) {
      throw new RagError('INVALID_OPTIONS', 'HashEmbedder dimensions must be an integer >= 8')
    }
    this.dimensions = dimensions
    this.id = `hash:${dimensions}`
  }

  private add(vector: number[], feature: string, weight: number): void {
    const h = fnv1a(feature)
    const sign = (h & 0x80000000) === 0 ? 1 : -1
    const slot = h % this.dimensions
    vector[slot] = vector[slot]! + sign * weight
  }

  embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0)
    const tokens = tokenize(text)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!
      this.add(vector, `w:${t}`, 1)
      if (t.length > 5) this.add(vector, `p:${t.slice(0, 5)}`, 0.5)
      else this.add(vector, `p:${t}`, 0.5)
      if (i > 0) this.add(vector, `b:${tokens[i - 1]} ${t}`, 0.5)
    }
    let norm = 0
    for (const v of vector) norm += v * v
    norm = Math.sqrt(norm)
    return norm === 0 ? vector : vector.map((v) => v / norm)
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t))
  }
}
