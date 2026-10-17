# @bot-wa/rag

> **Experimental — aún no publicado en npm.** Implementación real y probada, pero el paquete es `private`: no forma parte de la primera alpha y su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Retrieval Augmented Generation para [`@bot-wa/ai`](../ai): carga tus documentos, los trocea, calcula embeddings y responde con los pasajes más relevantes **con citas**. Sin base de datos vectorial: índice en memoria con similitud coseno y persistencia opcional en un archivo JSON.

- **Loaders:** Markdown (por secciones de encabezados), texto, JSON (un documento por elemento de un array) y PDF (con el peer opcional `pdf-parse`, cargado bajo demanda). Directorios recursivos.
- **Chunking:** párrafos → frases → palabras, con solapamiento (`chunkSize`, `chunkOverlap`).
- **Embeddings intercambiables:** OpenAI-compatible (vía `fetch` seguro, sin SDK), Ollama y un embedder local determinista por hashing (tests, offline, FAQs pequeñas).
- **Índice:** coseno en memoria, `topK`, `minScore`, filtros; guarda en JSON y, al reiniciar, **solo re-embebe los fragmentos que cambiaron**.

## Uso con `aiPlugin`

```ts
import { aiPlugin } from '@bot-wa/ai'
import { createRag } from '@bot-wa/rag'

const rag = createRag({
  documents: ['./docs/faq.md', './docs/productos.pdf', './docs/catalogo.json'],
  embeddings: 'openai',          // 'local' | 'openai' | 'ollama' | { provider, ... } | Embedder propio
  chunkSize: 1000,
  topK: 3,
  persistPath: './data/rag-index.json',
})

bot.plug(aiPlugin({
  provider: 'openai',
  rag: { retriever: rag, appendSources: true },   // o simplemente `rag`
}))
// Usuario: "¿cuánto tarda el envío?"
// Bot:     "Tardan 3 días hábiles [1].\n\nFuentes: docs/faq.md › Envíos"
```

`createRag()` es síncrono: los documentos se cargan y embeben en el primer `retrieve()`; `aiPlugin` llama a `warmup()` al instalarse (un error se registra en el log, no tumba el proceso).

## Uso directo

```ts
const hits = await rag.retrieve('medios de pago', { topK: 2 })
// [{ text, score, source: 'docs/faq.md', section: 'Pagos', citation: 'docs/faq.md › Pagos', id, docId, index }]

import { formatContext } from '@bot-wa/rag'
const answer = await ctx.tools.ai.ask(`Contexto:\n${formatContext(hits)}\n\nPregunta: ${ctx.body}`)

await rag.addText('Abrimos los domingos de 10 a 14.', { source: 'horario' })
await rag.addFiles(['./docs/nuevos'])
await rag.removeDocument('horario')
await rag.save()
```

## Embeddings

| Config | Detalle |
| --- | --- |
| `'local'` (por defecto) | `HashEmbedder` (512 dims): léxico, determinista, sin red. |
| `'openai'` / `{ provider: 'openai', apiKey, model, baseUrl, dimensions, batchSize }` | `POST {baseUrl}/embeddings`. Por defecto `text-embedding-3-small` y `OPENAI_API_KEY`. Sirve cualquier API compatible. |
| `'ollama'` / `{ provider: 'ollama', model, baseUrl }` | `POST {baseUrl}/api/embed`, por defecto `nomic-embed-text` en `http://localhost:11434`. |
| `Embedder` propio | `{ id, embed(texts) }`. |

Las peticiones salen por `secureFetch` de `@bot-wa/http` (anti-SSRF): HTTPS y hosts públicos por defecto. Ollama permite `http` y hosts privados por defecto; para otros endpoints internos usa `http: { allowHttp: true, allowPrivateHosts: true }`.

## Persistencia

Con `persistPath`, el índice se guarda (escritura atómica) tras cada cambio. Al arrancar se reutilizan los vectores de los fragmentos cuyo texto no cambió y que se calcularon con el mismo embedder (`Embedder.id`); si cambias de modelo, se reconstruye. Sin `documents`, se sirve el índice guardado tal cual (índice precompilado).

## PDF

```bash
pnpm add pdf-parse
```

Sin el paquete, cargar un PDF falla con `RagError('MISSING_DEPENDENCY')`. También puedes pasar tu extractor: `createRag({ pdf: async (bytes) => texto })`.

## Errores

Todo falla con `RagError` y un `code`: `INVALID_OPTIONS`, `UNSUPPORTED_FORMAT`, `LOAD_FAILED`, `MISSING_DEPENDENCY`, `EMBEDDING_FAILED`, `INVALID_INDEX`. Los mensajes nunca incluyen el cuerpo de la respuesta del proveedor de embeddings.

## Límites

Índice de fuerza bruta: pensado para miles de fragmentos (FAQ, catálogo, manual). Para millones, implementa tu propio `retrieve()` sobre una base vectorial; `aiPlugin` solo necesita `{ retrieve(query, { topK }) }`.
