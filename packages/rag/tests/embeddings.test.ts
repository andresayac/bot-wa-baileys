import { describe, it, expect } from 'vitest'
import { HashEmbedder, tokenize } from '../src/embeddings/hash.js'
import { OpenAIEmbedder } from '../src/embeddings/openai.js'
import { OllamaEmbedder } from '../src/embeddings/ollama.js'
import { resolveEmbedder } from '../src/embeddings/resolve.js'
import { cosine } from '../src/VectorIndex.js'
import { RagError } from '../src/errors.js'

const publicResolver = async () => ['93.184.216.34']

interface Call { url: string; init: RequestInit; body: Record<string, unknown> }
function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = []
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init, body: JSON.parse(String(init.body)) as Record<string, unknown> }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

describe('HashEmbedder', () => {
  it('tokenizes without case or diacritics', () => {
    expect(tokenize('¿Cuánto tarda el ENVÍO?')).toEqual(['cuanto', 'tarda', 'el', 'envio'])
  })

  it('is deterministic, normalised and ranks lexical overlap', async () => {
    const e = new HashEmbedder({ dimensions: 256 })
    expect(e.id).toBe('hash:256')
    const [a, b, c, a2] = await e.embed(['envíos a domicilio', 'Los envíos a domicilio tardan 3 días', 'pagos con tarjeta', 'envíos a domicilio'])
    expect(a).toEqual(a2)
    expect(a).toHaveLength(256)
    expect(Math.hypot(...a!)).toBeCloseTo(1, 6)
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!))
  })

  it('returns a zero vector for empty text and validates dimensions', async () => {
    const [v] = await new HashEmbedder({ dimensions: 16 }).embed(['  '])
    expect(v!.every((x) => x === 0)).toBe(true)
    expect(() => new HashEmbedder({ dimensions: 2 })).toThrow(RagError)
  })
})

describe('OpenAIEmbedder', () => {
  it('posts batches to /embeddings through secureFetch and orders by index', async () => {
    const { fetch, calls } = fakeFetch(({ body }) => {
      const input = body.input as string[]
      // answer out of order on purpose
      return json({ data: input.map((t, i) => ({ index: i, embedding: [t.length, i] })).reverse() })
    })
    const e = new OpenAIEmbedder({ apiKey: 'sk-test', baseUrl: 'https://llm.example.com/v1/', batchSize: 2, dimensions: 2, http: { fetch, resolver: publicResolver } })
    expect(e.id).toBe('openai:text-embedding-3-small:2')
    const vectors = await e.embed(['a', 'bb', 'ccc'])
    expect(vectors).toEqual([[1, 0], [2, 1], [3, 0]])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://llm.example.com/v1/embeddings')
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer sk-test')
    expect(calls[0]!.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'bb'], dimensions: 2 })
  })

  it('maps HTTP errors and malformed payloads to RagError(EMBEDDING_FAILED)', async () => {
    const bad = fakeFetch(() => json({ error: { message: 'secret echo' } }, 401))
    const e = new OpenAIEmbedder({ apiKey: 'k', http: { fetch: bad.fetch, resolver: publicResolver } })
    const err = await e.embed(['x']).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(RagError)
    expect((err as RagError).code).toBe('EMBEDDING_FAILED')
    expect((err as RagError).message).not.toContain('secret echo')
    const malformed = fakeFetch(() => json({ data: [{ index: 0, embedding: ['nope'] }] }))
    const e2 = new OpenAIEmbedder({ apiKey: 'k', http: { fetch: malformed.fetch, resolver: publicResolver } })
    await expect(e2.embed(['x'])).rejects.toMatchObject({ code: 'EMBEDDING_FAILED' })
  })

  it('refuses private hosts and plain http by default (anti-SSRF)', async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: [] }))
    const e = new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8080/v1', http: { fetch } })
    await expect(e.embed(['x'])).rejects.toMatchObject({ code: 'EMBEDDING_FAILED' })
    expect(calls).toHaveLength(0)
  })

  it('requires an api key', async () => {
    const prev = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      await expect(new OpenAIEmbedder().embed(['x'])).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev
    }
  })
})

describe('OllamaEmbedder', () => {
  it('posts to /api/embed on localhost (http + private allowed by default)', async () => {
    const { fetch, calls } = fakeFetch(({ body }) => json({ embeddings: (body.input as string[]).map(() => [0.1, 0.2]) }))
    const e = new OllamaEmbedder({ model: 'mxbai-embed-large', http: { fetch, resolver: async () => ['127.0.0.1'] } })
    expect(e.id).toBe('ollama:mxbai-embed-large')
    expect(await e.embed(['a', 'b'])).toEqual([[0.1, 0.2], [0.1, 0.2]])
    expect(calls[0]!.url).toBe('http://localhost:11434/api/embed')
    expect(calls[0]!.body).toEqual({ model: 'mxbai-embed-large', input: ['a', 'b'] })
    expect(await e.embed([])).toEqual([])
  })

  it('rejects a wrong number of vectors', async () => {
    const { fetch } = fakeFetch(() => json({ embeddings: [[1]] }))
    const e = new OllamaEmbedder({ http: { fetch, resolver: async () => ['127.0.0.1'] } })
    await expect(e.embed(['a', 'b'])).rejects.toMatchObject({ code: 'EMBEDDING_FAILED' })
  })
})

describe('resolveEmbedder', () => {
  it('resolves shorthands, configs and instances', () => {
    expect(resolveEmbedder().id).toBe('hash:512')
    expect(resolveEmbedder('local')).toBeInstanceOf(HashEmbedder)
    expect(resolveEmbedder('openai')).toBeInstanceOf(OpenAIEmbedder)
    expect(resolveEmbedder('ollama')).toBeInstanceOf(OllamaEmbedder)
    expect(resolveEmbedder({ provider: 'local', dimensions: 64 }).id).toBe('hash:64')
    expect(resolveEmbedder({ provider: 'ollama', model: 'm' }).id).toBe('ollama:m')
    const custom = { id: 'x', embed: async () => [] }
    expect(resolveEmbedder(custom)).toBe(custom)
    expect(() => resolveEmbedder('nope' as 'local')).toThrow(RagError)
  })
})
