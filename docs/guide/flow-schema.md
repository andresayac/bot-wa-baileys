# JSON flow schema

`@bot-wa/flow-schema` (private, monorepo only) defines **versioned, code-free flow documents**: JSON that the manager stores and hot-swaps, that the deployment gate validates, and that compiles to a core `CompiledFlow`.

A document is **data only**. It never carries functions, `eval`, module imports or arbitrary expressions: the only computation is a safe expression language and `{{ path }}` templates.

```ts
import { compileFlowDocument, validateFlowDocument } from '@bot-wa/flow-schema'

const document = {
  version: 1 as const,
  id: 'checkout',
  trigger: { keywords: ['comprar', 'pedido'], match: 'contains' },
  timeout: '5m',
  steps: [
    { kind: 'ask' as const, text: '¿Tu nombre?', stateKey: 'name' },
    { kind: 'condition' as const, if: 'len(name) > 2', then: [{ kind: 'say' as const, text: 'Hola {{name}}' }] },
    { kind: 'handoff' as const, reason: 'checkout' },
  ],
}

if (validateFlowDocument(document).length === 0) bot.registerFlow(compileFlowDocument(document))
```

## Document

| Field | Notes |
| --- | --- |
| `version` | Must be `1`. Use `migrateFlowDocument()` for older shapes. |
| `id` | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`; the flow's name on the bot. |
| `trigger` | A keyword, an array, or `{ keywords, match: 'equals' \| 'contains' \| 'startsWith' \| 'endsWith', scope: 'dm' \| 'group' \| 'all' }`. |
| `timeout` | Flow timeout (ms or `'30s'`, `'5m'`, `'1h'`; at most 7 days). |
| `persistent` | Survive a restart (requires a persistent store). |
| `steps` | At least one step; at most 500 in total (nested steps included), 8 levels deep. |

## Steps

| Kind | What it does |
| --- | --- |
| `say` | Sends text (templates allowed). |
| `ask` | Sends text, waits for an answer and stores it in `c.state[stateKey]`; optional `timeout`, `retries` and `validate: { expr, message }` (`$answer` holds the raw answer). |
| `choose` | Numbered menu (`options: [{ key, label, steps? }]`), stores the picked key. |
| `condition` | `if` expression plus `then`/`else` nested steps. |
| `delay` | Pauses (`'500ms'`… at most 5 minutes). |
| `goto` | Jumps to another registered flow. |
| `end` | Ends the conversation, with an optional farewell. |
| `media` | Sends `image`, `video`, `audio`, `voice`, `document`, `sticker` or `location`. File media needs `source: { url }` (http/https) or `{ stateKey }` (a URL stored in state); location needs `latitude`/`longitude`. |
| `form` | Native form (or degraded question-by-question) with typed fields; see [Forms](./forms.md). |
| `guard` | `if` expression; when false it sends `message` and ends, or `message` + `redirect` to another flow. |
| `subflow` | Runs another document inline (same state), resolved by `resolveSubflow`. |
| `http` | Declarative HTTP request through `@bot-wa/http` (anti-SSRF, redirects, timeout and size limits). Stores the JSON/text body in `stateKey`. |
| `handoff` | Hands the chat to a human (`ctx.handoff`), with an optional message. |
| `ai` | One AI turn through `ctx.tools.ai.replyInChat`, optionally restricted to tool ids (`tools: ['lookup']`); stores the answer in `stateKey`. |

Media URLs must use http(s). Local paths, buffers and streams are deliberately **not** representable: a stored document cannot read the server's filesystem.

## Safe expressions

`condition.if`, `guard.if` and `ask.validate.expr` use a tiny recursive-descent language:

- literals (`1`, `'text'`, `true`, `false`, `null`), state paths (`user.city`), `== != < <= > >= && || ! + -` and parentheses;
- functions: `len`, `lower`, `upper`, `trim`, `number`, `string`, `contains`, `startsWith`, `endsWith`, `empty`, `oneOf`.

No `eval`, no `Function`, no regexes, no indexing, no assignment, no prototype access (`__proto__`, `prototype`, `constructor` are rejected). Limits: 1000 characters, 256 tokens, 32 levels.

Templates (`{{ path }}`) only read own properties of `c.state` plus `$body`, `$from`, `$sender` and `$isGroup`; a missing value renders as an empty string.

## Validation errors

`validateFlowDocument()` returns JSON-pointer paths:

```ts
validateFlowDocument({ version: 1, id: 'x', trigger: 'x', steps: [{ kind: 'ask', text: '', stateKey: 'bad key' }] })
// [{ path: '/steps/0/text', message: '...' }, { path: '/steps/0/stateKey', message: '...' }]
```

`compileFlowDocument()` throws `FlowDocumentError` with the same issues. The JSON Schema (`FLOW_DOCUMENT_SCHEMA`, draft 2020-12) is served by the manager at `GET /v1/flows/schema` for editors and code generation.

## Subflows

```ts
bot.registerFlow(compileFlowDocument(parent, {
  resolveSubflow: (id) => documents.get(id),
}))
```

A subflow's steps run inline (same `c.state`, no second trigger). A missing document or a cycle (`a → b → a`) is a compile error.

## Migrations

```ts
import { migrateFlowDocument } from '@bot-wa/flow-schema'

const { document, from, applied } = migrateFlowDocument(storedDraft)
```

Version 0 (no `version`, the pre-versioned shape) becomes version 1. A version newer than the package is rejected; migrations can be extended and chained (`migrateFlowDocument(input, migrations, target)`).

## Reverse export

```ts
import { exportFlowDocument } from '@bot-wa/flow-schema'

const document = exportFlowDocument(compiledFlow)
```

Flows compiled from a document round-trip exactly (the original JSON is kept as step metadata). Flows built with the DSL export their declarative steps (`say`, `ask`, `choose`, `goto`, `delay`, `media`, `form`, `use`); an opaque `do` or a function-based guard raises `FlowExportError` with the step paths instead of being dropped.

## Drafts and deployments

```ts
import { diffFlowDocuments, flowDigest, publishFlow } from '@bot-wa/flow-schema'

const changes = diffFlowDocuments(draft, published)   // metadata, added/removed/changed steps with paths
const digest = flowDigest(draft)                      // sha256 of canonical JSON, stable across key order
await publishFlow(registry, 'acme', 'support', draft) // DeploymentRegistry gate + audited gate run
```

`publishFlow()` uses the document JSON as the artifact and a `flowDocumentGate()` that parses, validates and compiles the candidate; `options.gate` can chain another gate (e.g. golden transcripts). `@bot-wa/deployments` owns the storage; this package only provides the pure helpers.

## Manager REST

The manager's `POST`/`PUT` flow endpoints accept exactly these documents. `GET /v1/flows/schema` serves the JSON Schema and `GET/PUT/DELETE /v1/bots/{botId}/flows/{flowId}` store and hot-swap them without changing the REST contract. `subflow` steps resolve against the bot's other stored flows.
