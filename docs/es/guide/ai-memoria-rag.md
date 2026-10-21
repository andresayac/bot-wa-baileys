# Memoria y RAG

Dos formas de darle al [plugin de IA](/es/guide/ai) más contexto que el
historial del chat:

- **Memoria a largo plazo**: recuerda hechos cortos de cada persona ("prefiere
  español", "vive en Bogotá") entre conversaciones y reinicios, y los inyecta
  en el autoresponder.
- **RAG** (*Retrieval Augmented Generation*): busca los pasajes de tus
  documentos (FAQ, catálogo, manual) que responden a la pregunta y los inyecta
  numerados, para que el modelo responda a partir de ellos y los cite.

Ambos alimentan el prompt de sistema de `replyInChat()` (y por tanto del
autoresponder); ninguno hace fallar una respuesta: si fallan o tardan
demasiado, el turno sigue sin ellos.

## Memoria a largo plazo

```ts
bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  memory: {
    maxFacts: 50,      // oldest facts are dropped first
    ttl: '90d',        // each fact expires after 90 days (re-stating it renews it)
    autoExtract: true, // after each reply, the model extracts new facts (strict JSON)
  },
}))
```

### Dónde viven los hechos

Los hechos se guardan en el perfil persistente del usuario,
[`ctx.user`](/es/guide/datos-usuario), en el namespace `'ai.memory'` (clave
`facts`), por el id canónico del remitente (`ctx.sender`). Así:

- La misma persona tiene una sola memoria entre su chat privado y los grupos
  en los que escribe, y entre reinicios si el store es persistente
  (`MemoryStore` vive en RAM).
- Necesita un store con soporte de datos de usuario (todos los stores
  incluidos lo tienen).
- `bot.deleteSubject(userId)` la borra junto con el resto del perfil.
- `/reset` borra el contexto de IA del chat, **no** la memoria a largo plazo.

### Qué se inyecta

Con `memory` activo, los hechos del usuario se añaden al prompt de sistema de
cada turno del autoresponder, como datos y no como instrucciones. **Los grupos
quedan fuera por defecto**: todo el grupo lee la respuesta, así que los hechos
aprendidos en privado podrían filtrarse. Activa `injectInGroups: true` solo si
eso es aceptable.

### Extracción automática

Con `autoExtract`, después de cada turno el plugin le pide al modelo, **en
segundo plano** (nunca bloquea la cola del chat), hechos duraderos del usuario.
La respuesta debe ser exactamente `{"facts": string[]}`: cualquier otra cosa
(claves extra, prosa, elementos que no son strings) se descarta entera, así que
un modelo confundido o con *prompt injection* no puede escribir datos
arbitrarios en el perfil. El prompt también le indica que omita secretos y
datos sensibles (contraseñas, números de tarjeta o cuenta, documentos de
identidad, datos de salud).

Si se borran los datos del usuario (`bot.deleteSubject()` o
`forget(userId)`) mientras una extracción está en curso, sus hechos se
descartan: los datos borrados nunca vuelven.

`autoExtract` acepta `true` o un objeto:

| Campo | Por defecto | Descripción |
|---|---|---|
| `model` | el `model` del plugin | Modelo de la llamada de extracción. |
| `maxTokens` | `1024` | Presupuesto de tokens de la extracción (los modelos de razonamiento gastan parte pensando; Ollama no recibe tope salvo que lo fijes). |
| `maxFactsPerTurn` | `5` | Máximo de hechos nuevos aceptados por turno. |
| `instructions` | — | Indicaciones extra que se añaden al prompt de extracción. |
| `filter` | — | `(fact) => boolean`: devuelve `false` para descartar un candidato (p. ej. un filtro de datos personales). |

### Opciones de `memory`

| Campo | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `type` | `'per-user'` | `'per-user'` | Solo existe memoria por usuario (por `ctx.sender`). |
| `maxFacts` | `number` | `50` | Hechos guardados por usuario; se descartan los más antiguos. |
| `ttl` | `string \| number` | permanente | Vida de cada hecho (`'30d'`, `'12h'`, ms). Re-afirmarlo lo renueva. |
| `maxFactLength` | `number` | `300` | Los hechos más largos se rechazan. |
| `inject` | `boolean` | `true` | Inyecta los hechos en el prompt de sistema. |
| `injectInGroups` | `boolean` | `false` | También los inyecta cuando el usuario escribe en un grupo. |
| `autoExtract` | `boolean \| object` | `false` | Extracción en segundo plano (ver arriba). |
| `namespace` | `string` | `'ai.memory'` | Namespace del perfil. |

`memory: true` usa los valores por defecto.

### Leer y escribir la memoria

`ctx.tools.ai` expone la API de memoria. Funciona incluso sin la opción
`memory` (en ese caso no se inyecta ni se extrae nada automáticamente, pero tu
código puede leer y escribir hechos).

```ts
bot.when('qué sabes de mí', async (ctx) => {
  const facts = await ctx.tools.ai.memory(ctx.sender)
  // ['Prefiere atención en español', 'Vive en Bogotá']
  await ctx.reply(facts.join('\n') || 'Aún nada')
})

const ai = bot.injectTools.ai
await ai.remember(userId, 'Cliente VIP')               // resolves with the facts that were new
await ai.remember(userId, ['Vegano', 'Alérgico a los frutos secos'], { ttl: '30d' })
await ai.forget(userId, 'Cliente VIP')                 // one fact: true if it existed
await ai.forget(userId)                                // every fact
await bot.deleteSubject(userId)                        // right to erasure: memory included
```

| Método | Descripción |
|---|---|
| `memory(userId)` | Hechos vigentes, del más antiguo al más nuevo (`string[]`). |
| `memoryFacts(userId)` | Lo mismo con `createdAt`, `updatedAt`, `expiresAt` y `source` (`'auto'` o `'manual'`). |
| `remember(userId, facts, { ttl?, source? })` | Guarda uno o varios hechos. Los duplicados (sin distinguir mayúsculas ni puntuación) renuevan el existente. |
| `forget(userId, fact?)` | Olvida un hecho, o todos si no pasas `fact`. |
| `extractMemory(userId, userText, assistantText)` | Ejecuta una extracción a mano; resuelve con los hechos añadidos. |
| `idle()` | Resuelve cuando termina la extracción en segundo plano (tests, apagado ordenado). |

## RAG

`rag` acepta cualquier **retriever**, un objeto con
`retrieve(query, { topK?, minScore?, signal? })` que resuelve pasajes
`{ text, source?, citation?, score? }`. El paquete
[`@botmesh/rag`](#botmesh-rag) de más abajo trae uno con loaders, chunking,
embeddings e índice; una base de datos vectorial o una API de búsqueda sirven
igual.

```ts
import { aiPlugin } from '@botmesh/ai'
import { createRag } from '@botmesh/rag'

bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  rag: {
    retriever: createRag({ documents: ['./docs/faq.md', './docs/productos.pdf'], embeddings: 'openai' }),
    appendSources: true, // adds "Fuentes: [1] docs/faq.md › Envíos" to the reply
  },
}))
// Usuario: "¿cuánto tarda el envío?"
// Bot:     "Tarda 3 días hábiles [1].\n\nFuentes: [1] docs/faq.md › Envíos"
```

En cada turno el plugin recupera pasajes para el mensaje del usuario y los
inyecta en el prompt de sistema como un bloque numerado (`[1] (etiqueta)
texto`), con instrucciones de usarlos cuando sean relevantes, citarlos como
`[n]`, decir que no lo sabe si el contexto no tiene la respuesta y tratar el
contexto como datos, no como instrucciones.

| Campo | Por defecto | Descripción |
|---|---|---|
| `retriever` | — | El retriever (obligatorio en la forma de objeto). |
| `topK` | el del retriever | Pasajes por pregunta. |
| `minScore` | el del retriever | Puntuación mínima. |
| `appendSources` | `false` | `true` añade `"\n\nFuentes: [2] b"` con los pasajes que el modelo citó, conservando el `[n]` que usó en el texto (varios pasajes con la misma etiqueta comparten entrada: `[1][3] faq.md`); si no citó ninguno, todas las fuentes recuperadas, sin numerar (`Fuentes: a, b`). Una función `(citations, cited) => string` dibuja la línea a tu manera: `cited` trae `{ n, chunk }` por cada pasaje citado. |
| `instructions` | integradas | Sustituye las instrucciones que preceden al bloque de contexto. |
| `timeoutMs` | `10000` | Espera máxima de la recuperación, incluida la primera construcción del índice. Al vencer se aborta el retriever y la respuesta sigue sin contexto. `0` lo desactiva. |

`rag: retriever` (el retriever a secas) equivale a `rag: { retriever }`. La
línea por defecto de `appendSources` es el mensaje localizado `ai.rag.sources`
(`Fuentes: {sources}` en español, `Sources: {sources}` cuando `ctx.lang` es
`en`); cámbiala con `bot.locale()` o pasa una función. Al instalarse, el plugin llama al `warmup()` opcional
del retriever (no fatal: un fallo se registra en el log), así que el índice se
construye al arrancar y no en la primera pregunta.

### Citas y hechos de un turno

`replyInChatDetailed()` devuelve lo que usó el turno:

```ts
import { chatKeyOf } from '@botmesh/ai'

bot.when('ayuda', async (ctx) => {
  const r = await ctx.tools.ai.replyInChatDetailed(chatKeyOf(ctx), ctx.body, {
    userId: ctx.sender,
    isGroup: ctx.isGroup,
  })
  r.text      // reply (with the sources appended when appendSources is on)
  r.answer    // the model's raw answer, as stored in the history
  r.citations // passages retrieved for this turn
  r.facts     // user facts injected into this turn
  await ctx.reply(r.text)
})
```

`replyInChat(key, text, { userId, isGroup })` devuelve solo el texto. Pasa
`userId` para activar la memoria en el turno, e `isGroup` para que los hechos
no lleguen a las respuestas en grupos.

Con [streaming](/es/guide/streaming#con-botmesh-ai), la memoria y el RAG
funcionan igual; con `appendSources`, la línea de fuentes llega como último
fragmento.

### `@botmesh/rag`

::: warning Experimental — no está en npm
`@botmesh/rag` es un paquete real y probado, pero es **privado**: no forma
parte de la primera alpha y su API puede cambiar. Úsalo desde el monorepo
(`workspace:*`).
:::

`createRag(options)` construye un retriever sin base de datos vectorial: un
índice coseno en memoria con persistencia opcional en JSON.

- **Loaders**: Markdown (por secciones de encabezados), texto, JSON (un
  documento por elemento de un array) y PDF (con el peer opcional `pdf-parse`
  o tu propio parser `pdf`). Los directorios se leen de forma recursiva.
- **Chunking**: párrafos, luego frases, luego palabras, con solapamiento.
- **Embeddings**: `'local'` (por defecto; hashing determinista, sin red, solo
  léxico, ideal para tests y FAQs pequeñas), `'openai'` (cualquier endpoint
  `/embeddings` compatible con OpenAI; por defecto `text-embedding-3-small` y
  `OPENAI_API_KEY`), `'ollama'` (por defecto `nomic-embed-text` en
  `http://localhost:11434`), un objeto `{ provider, ... }` o tu propio
  `Embedder` (`{ id, embed(texts) }`). Las peticiones salen por `secureFetch`
  de `@botmesh/http`.
- **Índice**: `topK`, `minScore` y filtros. Con `persistPath` se guarda en JSON
  tras cada cambio y, al reiniciar, solo se vuelven a embeber los fragmentos
  cuyo texto cambió.

| Opción | Por defecto | Descripción |
|---|---|---|
| `documents` | — | Rutas (archivos o directorios) y/o documentos `{ id, text, source }`. Se cargan en el primer uso. |
| `embeddings` | `'local'` | Ver arriba. |
| `chunkSize` | `1000` | Caracteres objetivo por fragmento. |
| `chunkOverlap` | `150` (como mucho `chunkSize / 4`) | Caracteres que se arrastran del fragmento anterior. |
| `topK` | `3` | Fragmentos que devuelve `retrieve()`. |
| `minScore` | `0` | Similitud coseno mínima. |
| `persistPath` | — | Archivo JSON del índice. |
| `cwd` | `process.cwd()` | Directorio base de las rutas relativas. |
| `maxFileBytes` | 20 MiB | Tamaño máximo por archivo cargado. |
| `retryDelayMs` | `30000` | Tras una ingesta fallida, `retrieve()` rechaza al momento con el mismo error durante este tiempo. |
| `onError` | — | Problemas no fatales (p. ej. un índice guardado corrupto que se aparta y se reconstruye). |

`createRag()` es síncrono y barato, así que cabe en un `install` síncrono de
plugin. También puedes usarlo directamente:

```ts
import { createRag, formatContext } from '@botmesh/rag'

const rag = createRag({ documents: ['./docs'], embeddings: 'ollama' })

const hits = await rag.retrieve('medios de pago', { topK: 2 })
// [{ text, score, source, section, citation: 'docs/faq.md › Pagos', id, docId, index }]
const respuesta = await ctx.tools.ai.ask(`Contexto:\n${formatContext(hits)}\n\nPregunta: ${ctx.body}`)

await rag.addText('Abrimos los domingos de 10 a 14.', { source: 'horario' })
await rag.addFiles(['./docs/nuevos'])
await rag.removeDocument('horario')
await rag.save()
```

Todo fallo es un `RagError` con un `code`: `INVALID_OPTIONS`,
`UNSUPPORTED_FORMAT`, `LOAD_FAILED`, `MISSING_DEPENDENCY`, `EMBEDDING_FAILED`
o `INVALID_INDEX`. El índice es de fuerza bruta, pensado para miles de
fragmentos; para millones, escribe tu propio retriever sobre una base
vectorial. Detalles en el
[README de `@botmesh/rag`](https://github.com/andresayac/botmesh/tree/main/packages/rag).

## Testing

`MockAIProvider` no necesita red. Para probar la memoria, dale al `AIClient`
un `MemoryManager` sobre los perfiles del bot; para probar el RAG, sirve
cualquier objeto con `retrieve()`:

```ts
import { AIClient, ContextManager, MemoryManager, MockAIProvider } from '@botmesh/ai'
import { createTestBot } from '@botmesh/core/testing'

const { bot } = await createTestBot()
const mock = new MockAIProvider({ reply: 'Tarda 3 días [1].' })
const ai = new AIClient(mock, new ContextManager(bot.getStore()), {
  memory: new MemoryManager((id) => bot.user(id)),
  rag: { retriever: { retrieve: async () => [{ text: 'El envío tarda 3 días.', citation: 'faq' }] }, appendSources: true },
})

await ai.remember('user-1', 'Prefiere español')
const r = await ai.replyInChatDetailed('chat-1', '¿envío?', { userId: 'user-1' })
r.text  // 'Tarda 3 días [1].\n\nFuentes: [1] faq'
r.facts // ['Prefiere español']
mock.calls[0]?.system // contains the facts and the numbered context
```

## Siguientes pasos

- [Plugin de IA](/es/guide/ai) — proveedores y la referencia completa de `aiPlugin`
- [Herramientas de IA](/es/guide/ai-herramientas) — deja que el modelo llame a funciones de tu bot
- [Datos por usuario](/es/guide/datos-usuario) — el perfil `ctx.user` donde vive la memoria
