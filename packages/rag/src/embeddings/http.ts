import { secureFetch, type SecureFetchOptions } from '@bot-wa/http'
import { RagError } from '../errors.js'

/**
 * Transport knobs forwarded to `secureFetch` (anti-SSRF client of
 * `@bot-wa/http`): `allowHttp` / `allowPrivateHosts` for self-hosted
 * endpoints, `timeoutMs`, `maxBytes`, and `fetch` / `resolver` for tests.
 */
export type EmbeddingHttpOptions = Pick<
  SecureFetchOptions,
  'allowHttp' | 'allowPrivateHosts' | 'timeoutMs' | 'maxBytes' | 'maxRedirects' | 'fetch' | 'resolver'
>

/** POST a JSON body and parse a JSON answer; non-2xx → `RagError('EMBEDDING_FAILED')`. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  http: EmbeddingHttpOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  let result
  try {
    result = await secureFetch(url, {
      timeoutMs: 30_000,
      ...http,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  } catch (cause) {
    throw new RagError('EMBEDDING_FAILED', `embedding request failed: ${(cause as Error)?.message ?? String(cause)}`, { cause })
  }
  if (!result.response.ok) {
    // Never echo the response body: it may contain the request (and our texts).
    throw new RagError('EMBEDDING_FAILED', `embedding endpoint answered HTTP ${result.response.status}`)
  }
  try {
    return JSON.parse(result.body.toString('utf8')) as unknown
  } catch (cause) {
    throw new RagError('EMBEDDING_FAILED', 'embedding endpoint returned invalid JSON', { cause })
  }
}

/** Validate a vector list returned by a remote embedder. */
export function assertVectors(vectors: unknown, expected: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new RagError('EMBEDDING_FAILED', `expected ${expected} embeddings, got ${Array.isArray(vectors) ? vectors.length : typeof vectors}`)
  }
  let dim: number | undefined
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new RagError('EMBEDDING_FAILED', 'embedding endpoint returned a malformed vector')
    }
    if (dim !== undefined && v.length !== dim) throw new RagError('EMBEDDING_FAILED', 'embedding endpoint returned vectors of different sizes')
    dim = v.length
  }
  return vectors as number[][]
}
