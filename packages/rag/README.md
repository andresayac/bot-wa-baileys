# @botmesh/rag

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`).

Retrieval Augmented Generation for [`@botmesh/ai`](../ai): it loads your documents, chunks them, computes embeddings and answers with the most relevant passages **with citations**. No vector database: an in-memory index with cosine similarity and optional persistence to a JSON file.

- **Loaders:** Markdown (split by heading sections), text, JSON (one document per array element) and PDF (with the optional `pdf-parse` peer, loaded on demand). Recursive directories.
- **Chunking:** paragraphs → sentences → words, with overlap (`chunkSize`, `chunkOverlap`).
- **Interchangeable embeddings:** OpenAI-compatible (through secure `fetch`, no SDK), Ollama and a deterministic local hashing embedder (tests, offline, small FAQs).
- **Index:** in-memory cosine, `topK`, `minScore`, filters; saved to JSON and, on restart, **only chunks that changed are re-embedded**.

## Usage with `aiPlugin`

```ts
import { aiPlugin } from '@botmesh/ai'
import { createRag } from '@botmesh/rag'

const rag = createRag({
  documents: ['./docs/faq.md', './docs/products.pdf', './docs/catalog.json'],
  embeddings: 'openai',          // 'local' | 'openai' | 'ollama' | { provider, ... } | custom Embedder
  chunkSize: 1000,
  topK: 3,
  persistPath: './data/rag-index.json',
})

bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',                            // openai has no default model
  rag: { retriever: rag, appendSources: true },   // or simply `rag`
}))
// User: "how long does shipping take?"
// Bot:  "It takes 3 business days [1].\n\nSources: [1] docs/faq.md › Shipping"
```

`createRag()` is synchronous: documents are loaded and embedded on the first `retrieve()`; `aiPlugin` calls `warmup()` on install (an error is logged, it does not crash the process).

## Direct usage

```ts
const hits = await rag.retrieve('payment methods', { topK: 2 })
// [{ text, score, source: 'docs/faq.md', section: 'Payments', citation: 'docs/faq.md › Payments', id, docId, index }]

import { formatContext } from '@botmesh/rag'
const answer = await ctx.tools.ai.ask(`Context:\n${formatContext(hits)}\n\nQuestion: ${ctx.body}`)

await rag.addText('We are open on Sundays from 10 to 14.', { source: 'hours' })
await rag.addFiles(['./docs/new'])
await rag.removeDocument('hours')
await rag.save()
```

## Embeddings

| Config | Detail |
| --- | --- |
| `'local'` (default) | `HashEmbedder` (512 dims): lexical, deterministic, no network. |
| `'openai'` / `{ provider: 'openai', apiKey, model, baseUrl, dimensions, batchSize }` | `POST {baseUrl}/embeddings`. `text-embedding-3-small` and `OPENAI_API_KEY` by default. Any compatible API works. |
| `'ollama'` / `{ provider: 'ollama', model, baseUrl }` | `POST {baseUrl}/api/embed`, `nomic-embed-text` on `http://localhost:11434` by default. |
| Custom `Embedder` | `{ id, embed(texts) }`. |

Requests go through [`@botmesh/http`](../http)'s `secureFetch` (anti-SSRF): HTTPS and public hosts by default. Ollama allows `http` and private hosts by default; for other internal endpoints use `http: { allowHttp: true, allowPrivateHosts: true }`.

## Persistence

With `persistPath`, the index is saved (atomic write) after every change. On startup, vectors are reused for chunks whose text did not change and that were computed with the same embedder (`Embedder.id`); if you change the model, it is rebuilt. Without `documents`, the saved index is served as-is (a precompiled index).

Documents added at runtime (`addText`, `addDocuments`, `addFiles`) survive restarts; if one shares an id with a configured document, the configured one wins. If the file is corrupt and `documents` is set, it is moved aside as `<persistPath>.corrupt`, `onError` is notified and the index is rebuilt; without `documents` there is nothing to rebuild from and `ready()` fails with `INVALID_INDEX`.

If ingestion fails, `retrieve()` rejects immediately with the same error for `retryDelayMs` (30 s by default) instead of recomputing the embeddings of the whole corpus on every query; `ready()`/`warmup()` always retry. `retrieve(query, { signal })` stops waiting for ingestion as soon as the signal aborts.

## PDF

```bash
pnpm add pdf-parse
```

Without the package, loading a PDF fails with `RagError('MISSING_DEPENDENCY')`. You can also pass your own extractor: `createRag({ pdf: async (bytes) => text })`.

## Errors

Everything fails with `RagError` and a `code`: `INVALID_OPTIONS`, `UNSUPPORTED_FORMAT`, `LOAD_FAILED`, `MISSING_DEPENDENCY`, `EMBEDDING_FAILED`, `INVALID_INDEX`. Messages never include the embedding provider's response body.

## Limits

Brute-force index: intended for thousands of chunks (FAQ, catalog, manual). For millions, implement your own `retrieve()` over a vector database; `aiPlugin` only needs `{ retrieve(query, { topK }) }`.
