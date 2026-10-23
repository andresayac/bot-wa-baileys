# @botmesh/nlu

> **Experimental — not yet published on npm.** A real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`); the `pnpm add` below will work once it is published.

Lightweight, **fully-local** intent matching for [`@botmesh/core`](../core). Define intents
with training phrases (utterances) and match incoming message text against them — no
network calls, no ML models, no external services. Zero runtime dependencies beyond
`@botmesh/core`.

```bash
pnpm add @botmesh/nlu
```

> **Scope note** — this is a deterministic keyword/token-overlap matcher, not a full ML
> NLU (no embeddings, no stemming, no multilingual models). It's great for command-like
> intents ("mi pedido", "cancelar", "hablar con un agente"). For open-ended language
> understanding, use the LLM-based [`@botmesh/ai`](../ai) plugin instead (or alongside).

## Quick start

```ts
import { IntentEngine } from '@botmesh/nlu'

const nlu = new IntentEngine() // default threshold: 0.5
nlu.define('greeting', ['hola', 'buenas', 'buenos días'])
nlu.define('order.status', ['mi pedido {id}', 'estado de mi pedido', 'quiero ver el estado de mi pedido'])
nlu.define('cancel', ['cancelar', 'cancelar mi pedido'])

nlu.match('¡HOLA!')          // → { intent: 'greeting', confidence: 1 }
nlu.match('mi pedido 12345') // → { intent: 'order.status', confidence: 1, entities: { id: '12345' } }
nlu.match('estado de mi pedido por favor') // → { intent: 'order.status', confidence: 0.9… }
nlu.match('zzz qqq')         // → null (nothing crosses the threshold)
```

## API

### `new IntentEngine(options?)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `threshold` | `number` | `0.5` | Minimum confidence for `match()` to return a result. Must be in `[0, 1]`. |

### `engine.define(intent, utterances)`

Add training phrases to an intent (chainable). Calling `define` again for an existing
intent **appends** utterances. Throws on empty intent names or empty utterance lists.

### `engine.match(text, threshold?) → IntentMatch | null`

Returns the best intent at or above the threshold (per-call override optional):

```ts
interface IntentMatch {
  intent: string                    // the matched intent name
  confidence: number                // score in [0, 1]
  entities?: Record<string, string> // captured {slot} values, when applicable
}
```

### `engine.rank(text) → IntentMatch[]`

Scores **every** intent against the text and returns all positive scores sorted by
confidence (descending). Useful for debugging and disambiguation UIs.

### `engine.intents() → string[]` and `engine.threshold`

Registered intent names (definition order) and the configured threshold.

### `{slot}` entities (minimal)

Utterances may contain `{name}` placeholders. A slot captures a **single
whitespace-delimited token** from the fully-normalized input (lowercased, diacritics
stripped). When the anchored slot pattern matches the whole input, confidence is `1`
and `entities` carries the captured values:

```ts
nlu.define('travel', ['vuelo de {origen} a {destino}'])
nlu.match('vuelo de Bogotá a Lima')
// → { intent: 'travel', confidence: 1, entities: { origen: 'bogota', destino: 'lima' } }
```

Limits (by design): slots are single-token and the pattern is anchored to the whole
message. If the input doesn't line up with the pattern (extra words, different order),
the utterance still participates in normal token-overlap scoring — it just won't
extract entities.

## How matching works

1. **Normalize** both utterances and input: NFD-decompose and strip diacritics,
   lowercase, replace every non-alphanumeric character with a space, collapse
   whitespace (`¡HOLA, SEÑOR!` → `hola senor`).
2. **Score each utterance** against the input:
   - Exact normalized equality → `1`.
   - Slot utterance whose anchored regex matches the whole input → `1` (captures entities).
   - Otherwise a weighted blend of three signals:

     ```
     score = 0.3 × jaccard + 0.5 × coverage + 0.2 × contains
     ```

     - `jaccard` = `|input ∩ utterance| / |input ∪ utterance|` (bag-of-tokens overlap),
     - `coverage` = fraction of the utterance's tokens present in the input,
     - `contains` = `1` when the whole normalized utterance appears as a substring of
       the input, else `0`.
3. **Best utterance wins** per intent; best intent wins overall. Results below
   `threshold` yield `null`. Matching is fully deterministic — confidence ties resolve
   to the earliest-defined intent.

Tips for good accuracy: provide several short utterances per intent using the words
your users actually type; avoid intents that share most of their vocabulary.

## Bot integration

### `nluPlugin(config?)`

Installs an engine on the Bot and exposes it as `ctx.tools.nlu` (typed automatically —
the package augments `@botmesh/core`'s `DefaultTools`).

```ts
import { nluPlugin } from '@botmesh/nlu'

bot.plug(nluPlugin, {
  threshold: 0.5, // optional
  intents: {      // optional seed data
    greeting: ['hola', 'buenas'],
    'order.status': ['mi pedido {id}'],
  },
})

// Retrieve the engine:
const nlu = bot.injectTools.nlu // IntentEngine
// …or inside any handler:
bot.onMessage(async (ctx) => {
  const best = ctx.tools.nlu?.rank(ctx.body)[0]
  await ctx.reply(best ? `Creo que dices: ${best.intent}` : 'No entendí 🤔')
})
```

### `whenIntent(bot, engine, intent, handler)`

Sugar over `bot.when` with a predicate trigger: the handler runs **only** when the
incoming text's *best* match is `intent` (above the engine threshold). The handler
receives `(ctx, match)` so you can read `match.confidence` and `match.entities`.
Messages that don't match — or whose best match is a different intent — fall through to
other matchers and, eventually, `onMessage`. Returns an unsubscribe function.

```ts
import { nluPlugin, whenIntent, IntentEngine } from '@botmesh/nlu'

bot.plug(nluPlugin, {
  intents: {
    greeting: ['hola', 'buenas'],
    'order.status': ['mi pedido {id}', 'estado de mi pedido'],
  },
})
const nlu = bot.injectTools.nlu as IntentEngine

whenIntent(bot, nlu, 'greeting', async (ctx) => {
  await ctx.reply('¡Hola! 👋 ¿En qué te ayudo?')
})

whenIntent(bot, nlu, 'order.status', async (ctx, match) => {
  const id = match.entities?.id
  await ctx.reply(id ? `Buscando el pedido ${id}…` : '¿Cuál es tu número de pedido?')
})

// Anything no intent matched:
bot.onMessage(async (ctx) => {
  await ctx.reply('No entendí 🤔 (para IA de verdad, usa @botmesh/ai)')
})
```

## Development

```bash
pnpm --filter @botmesh/nlu build
pnpm --filter @botmesh/nlu test
```

## License

MIT
