# AI memory & RAG

Two ways to give the [AI plugin](/guide/ai) more context than the chat
history:

- **Long-term memory** remembers short facts about each person ("prefers
  Spanish", "lives in Bogotá") across conversations and restarts, and injects
  them into the autoreply.
- **RAG** (Retrieval Augmented Generation) finds the passages of your
  documents (FAQ, catalog, manual) that answer the question and injects them,
  numbered, so the model answers from them and cites them.

Both feed the system prompt of `replyInChat()` (and so of the autoresponder);
neither one fails a reply: if they error or time out, the turn goes on without
them.

## Long-term memory

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

### Where facts live

Facts are stored in the persistent user profile, [`ctx.user`](/guide/user-data),
under the namespace `'ai.memory'` (key `facts`), keyed by the canonical sender
id (`ctx.sender`). So:

- The same person keeps one memory across their DM and the groups they write
  in, and across restarts when the store is persistent (`MemoryStore` lives in
  RAM).
- It needs a store with user-data support (all the bundled stores have it).
- `bot.deleteSubject(userId)` erases it together with the rest of the profile.
- `/reset` clears the chat's AI context, **not** the long-term memory.

### What gets injected

With `memory` on, the user's facts are added to the system prompt of every
autoreply turn, as data, not instructions. **Groups are excluded by default**:
every member reads a group reply, so facts learned in private could leak
there. Turn `injectInGroups: true` on only if that is acceptable.

### Automatic extraction

With `autoExtract`, after each turn the plugin asks the model, **in the
background** (it never blocks the chat's queue), for durable facts about the
user. The answer must be exactly `{"facts": string[]}`: anything else (extra
keys, prose, non-string items) is discarded whole, so a confused or
prompt-injected model cannot write arbitrary data into the profile. The prompt
also tells the model to skip secrets and sensitive data (passwords, card or
account numbers, government ids, health data).

If the user's data is erased (`bot.deleteSubject()` or `forget(userId)`) while
an extraction is running, its facts are dropped: erased data never comes back.

`autoExtract` accepts `true` or an object:

| Field | Default | Description |
|---|---|---|
| `model` | the plugin's `model` | Model for the extraction call. |
| `maxTokens` | `300` | Token budget of the extraction call. |
| `maxFactsPerTurn` | `5` | Max new facts accepted per turn. |
| `instructions` | — | Extra guidance appended to the extraction prompt. |
| `filter` | — | `(fact) => boolean`: return `false` to drop a candidate (e.g. a PII filter). |

### `memory` options

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `'per-user'` | `'per-user'` | Only per-user memory exists (keyed by `ctx.sender`). |
| `maxFacts` | `number` | `50` | Facts kept per user; the oldest are dropped first. |
| `ttl` | `string \| number` | permanent | Lifetime of each fact (`'30d'`, `'12h'`, ms). Re-stating a fact renews it. |
| `maxFactLength` | `number` | `300` | Longer facts are rejected. |
| `inject` | `boolean` | `true` | Inject the facts into the system prompt. |
| `injectInGroups` | `boolean` | `false` | Also inject them when the user writes in a group. |
| `autoExtract` | `boolean \| object` | `false` | Background extraction (see above). |
| `namespace` | `string` | `'ai.memory'` | Profile namespace. |

`memory: true` uses the defaults.

### Reading and writing memory

`ctx.tools.ai` exposes the memory API. It works even without the `memory`
option (then nothing is injected or extracted automatically, but your code can
still read and write facts).

```ts
bot.when('what do you know about me', async (ctx) => {
  const facts = await ctx.tools.ai.memory(ctx.sender)
  // ['Prefers Spanish', 'Lives in Bogotá']
  await ctx.reply(facts.join('\n') || 'Nothing yet')
})

const ai = bot.injectTools.ai
await ai.remember(userId, 'VIP customer')              // resolves with the facts that were new
await ai.remember(userId, ['Vegan', 'Allergic to nuts'], { ttl: '30d' })
await ai.forget(userId, 'VIP customer')                // one fact: true if it existed
await ai.forget(userId)                                // every fact
await bot.deleteSubject(userId)                        // right to erasure: memory included
```

| Method | Description |
|---|---|
| `memory(userId)` | Live facts, oldest first (`string[]`). |
| `memoryFacts(userId)` | The same with `createdAt`, `updatedAt`, `expiresAt` and `source` (`'auto'` or `'manual'`). |
| `remember(userId, facts, { ttl?, source? })` | Store one or more facts. Duplicates (case and punctuation ignored) renew the existing fact. |
| `forget(userId, fact?)` | Forget one fact, or everything without `fact`. |
| `extractMemory(userId, userText, assistantText)` | Run one extraction by hand; resolves with the facts added. |
| `idle()` | Resolves once background extraction has settled (tests, graceful shutdown). |

## RAG

`rag` accepts any **retriever**, an object with
`retrieve(query, { topK?, minScore?, signal? })` that resolves passages
`{ text, source?, citation?, score? }`. The
[`@bot-wa/rag`](#bot-wa-rag) package below provides one with loaders,
chunking, embeddings and an index; a vector database or a search API works
just as well.

```ts
import { aiPlugin } from '@bot-wa/ai'
import { createRag } from '@bot-wa/rag'

bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  rag: {
    retriever: createRag({ documents: ['./docs/faq.md', './docs/products.pdf'], embeddings: 'openai' }),
    appendSources: true, // adds "Fuentes: docs/faq.md › Shipping" to the reply
  },
}))
// User: "how long does shipping take?"
// Bot:  "It takes 3 business days [1].\n\nFuentes: docs/faq.md › Shipping"
```

On every turn the plugin retrieves passages for the user's message and
injects them into the system prompt as a numbered block (`[1] (label) text`),
with instructions to use them when relevant, cite them as `[n]`, say it does
not know when the context has no answer, and treat the context as data, not
instructions.

| Field | Default | Description |
|---|---|---|
| `retriever` | — | The retriever (required in the object form). |
| `topK` | the retriever's default | Passages per question. |
| `minScore` | the retriever's default | Minimum score. |
| `appendSources` | `false` | `true` appends `"\n\nFuentes: a, b"` with the passages the model cited as `[n]` (all of them when it cited none); a function `(citations) => string` renders the line yourself. |
| `instructions` | built-in | Replaces the instructions that precede the context block. |
| `timeoutMs` | `10000` | Max wait for retrieval, including a first-time index build. Past it the retriever is aborted and the reply goes on without context. `0` disables. |

`rag: retriever` (the bare retriever) is the same as `rag: { retriever }`. The
default `appendSources` line is the localized `ai.rag.sources` message
(`Fuentes: {sources}` in Spanish, `Sources: {sources}` when `ctx.lang` is `en`);
override it with `bot.locale()` or pass a function. At install the plugin calls the retriever's optional `warmup()`
(non-fatal: a failure is logged), so the index is built at startup instead of
on the first question.

### Citations and facts of a turn

`replyInChatDetailed()` returns what the turn used:

```ts
import { chatKeyOf } from '@bot-wa/ai'

bot.when('help', async (ctx) => {
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

`replyInChat(key, text, { userId, isGroup })` returns only the text. Pass
`userId` to enable memory for the turn, and `isGroup` so facts stay out of
group replies.

With [streaming](/guide/streaming#with-bot-wa-ai), memory and RAG apply the
same way; with `appendSources` the sources line arrives as the last piece.

### `@bot-wa/rag`

::: warning Experimental — not on npm
`@bot-wa/rag` is a working, tested package, but it is **private**: it is not
part of the first alpha and its API may change. Use it from the monorepo
(`workspace:*`).
:::

`createRag(options)` builds a retriever without a vector database: an
in-memory cosine index with optional JSON persistence.

- **Loaders**: Markdown (split by heading sections), text, JSON (one document
  per array element) and PDF (with the optional `pdf-parse` peer, or your own
  `pdf` parser). Directories are read recursively.
- **Chunking**: paragraphs, then sentences, then words, with overlap.
- **Embeddings**: `'local'` (default; deterministic hashing, offline, lexical
  only, good for tests and small FAQs), `'openai'` (any OpenAI-compatible
  `/embeddings` endpoint, `text-embedding-3-small` and `OPENAI_API_KEY` by
  default), `'ollama'` (`nomic-embed-text` on `http://localhost:11434` by
  default), a `{ provider, ... }` object, or your own `Embedder`
  (`{ id, embed(texts) }`). Requests go through `secureFetch` from
  `@bot-wa/http`.
- **Index**: `topK`, `minScore` and filters. With `persistPath` it is saved as
  JSON after each change and, on restart, only the chunks whose text changed
  are embedded again.

| Option | Default | Description |
|---|---|---|
| `documents` | — | Paths (files or directories) and/or `{ id, text, source }` documents. Loaded lazily on first use. |
| `embeddings` | `'local'` | See above. |
| `chunkSize` | `1000` | Target characters per chunk. |
| `chunkOverlap` | `150` (at most `chunkSize / 4`) | Characters carried over from the previous chunk. |
| `topK` | `3` | Chunks returned by `retrieve()`. |
| `minScore` | `0` | Minimum cosine score. |
| `persistPath` | — | JSON file for the index. |
| `cwd` | `process.cwd()` | Base directory for relative paths. |
| `maxFileBytes` | 20 MiB | Max bytes per loaded file. |
| `retryDelayMs` | `30000` | After a failed ingest, `retrieve()` rejects at once with the same error for this long. |
| `onError` | — | Non-fatal problems (e.g. a corrupt persisted index set aside and rebuilt). |

`createRag()` is synchronous and cheap, so it fits in a synchronous plugin
install. You can also use it directly:

```ts
import { createRag, formatContext } from '@bot-wa/rag'

const rag = createRag({ documents: ['./docs'], embeddings: 'ollama' })

const hits = await rag.retrieve('payment methods', { topK: 2 })
// [{ text, score, source, section, citation: 'docs/faq.md › Payments', id, docId, index }]
const answer = await ctx.tools.ai.ask(`Context:\n${formatContext(hits)}\n\nQuestion: ${ctx.body}`)

await rag.addText('We open on Sundays from 10 to 14.', { source: 'hours' })
await rag.addFiles(['./docs/new'])
await rag.removeDocument('hours')
await rag.save()
```

Every failure is a `RagError` with a `code`: `INVALID_OPTIONS`,
`UNSUPPORTED_FORMAT`, `LOAD_FAILED`, `MISSING_DEPENDENCY`, `EMBEDDING_FAILED`
or `INVALID_INDEX`. The index is brute force, meant for thousands of chunks;
for millions, write your own retriever over a vector database. Details in the
[`@bot-wa/rag` README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/rag).

## Testing

`MockAIProvider` needs no network. To test memory, give the `AIClient` a
`MemoryManager` over the bot's profiles; to test RAG, any object with
`retrieve()` will do:

```ts
import { AIClient, ContextManager, MemoryManager, MockAIProvider } from '@bot-wa/ai'
import { createTestBot } from '@bot-wa/core/testing'

const { bot } = await createTestBot()
const mock = new MockAIProvider({ reply: 'It takes 3 days [1].' })
const ai = new AIClient(mock, new ContextManager(bot.getStore()), {
  memory: new MemoryManager((id) => bot.user(id)),
  rag: { retriever: { retrieve: async () => [{ text: 'Shipping takes 3 days.', citation: 'faq' }] }, appendSources: true },
})

await ai.remember('user-1', 'Prefers Spanish')
const r = await ai.replyInChatDetailed('chat-1', 'shipping?', { userId: 'user-1' })
r.text  // 'It takes 3 days [1].\n\nFuentes: faq'
r.facts // ['Prefers Spanish']
mock.calls[0]?.system // contains the facts and the numbered context
```

## Next steps

- [AI plugin](/guide/ai) — providers and the full `aiPlugin` reference
- [AI tool calling](/guide/ai-tools) — let the model call your bot's functions
- [Persistent user data](/guide/user-data) — the `ctx.user` profile memory lives in
