# MCP server

`@bot-wa/mcp` (private, monorepo only) is a **Model Context Protocol** server over stdio. It gives an AI coding agent (or an editor) the project's deterministic pieces so a flow document can be written, validated, compiled, drawn, linted, migrated and diffed **without starting a bot**: no phone, no credentials, no network.

Every tool is a function of its arguments. The server has **no dependencies** (the JSON-RPC transport is ~150 lines of `LineDecoder` + envelopes), never evaluates code and never writes to disk.

## Run it

```bash
pnpm build                                     # packages resolve through lib/

node packages/mcp/lib/bin.js --docs docs       # flow tools + docs_search / docs_page
node packages/mcp/lib/bin.js                   # flow tools only
```

`--docs <dir>` (or `BOTWA_DOCS_DIR`) points at a docs tree; without it the two docs tools are **not** advertised in `tools/list`, so a client never sees a tool that cannot work.

In VS Code the repo already ships `.vscode/mcp.json`: run `pnpm build` once, then start the *bot-wa* server from the MCP view.

### Programmatically

```ts
import { createMcpServer, serveStream } from '@bot-wa/mcp'

const server = createMcpServer({ docsDir: 'docs' })
await serveStream(process.stdin, { server, write: (line) => process.stdout.write(`${line}\n`) })
```

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `flow_validate` | `document` | `{ valid, issues: [{ path, message }], summary? }` — issues carry the JSON Pointer of the offending node. |
| `flow_analyze` | `document`, `subflows?`, `format?`, `direction?` | Validates, compiles, renders the graph (`mermaid` by default, `graph` with `format: "json"`) and returns the `lintFlows` diagnostics. |
| `flow_migrate` | `document`, `target?` | `{ document, from, to, applied, issues }`. A document without `version` is read as 0. |
| `flow_diff` | `left`, `right` | `{ changed, metadata, added, removed, changedSteps, before, after }` (the last two are digests). |
| `flow_digest` | `document` | `{ digest, version }` — `sha256` over canonical JSON, so key order and formatting never change it. |
| `flow_schema` | — | The draft 2020-12 schema, `limits` and `stepKinds` (derived from the schema itself). |
| `flow_example` | — | A canonical document that validates and lints clean. |
| `docs_search` | `query`, `limit?` | Sections with `path`, `title`, `heading`, `snippet` and `score` (only with a docs directory). |
| `docs_page` | `path` | The markdown of one page (only with a docs directory). |

`flow_analyze` runs the **same** `describeFlows()` and `lintFlows()` that `bot.describe()` and `bot.lint()` use, and `flow_*` wraps `@bot-wa/flow-schema`, so the server can never disagree with the runtime or the deployment gate.

### Valid or invalid is a result, not an error

An invalid document is a **successful** call whose payload says `valid: false` with the issues:

```json
{ "jsonrpc": "2.0", "id": 2, "result": { "content": [{ "type": "text", "text": "{\n  \"valid\": false,\n  \"issues\": [{ \"path\": \"/steps/0/text\", \"message\": \"must be string\" }]\n}" }] } }
```

`isError: true` is reserved for the **request** (missing or mistyped arguments, an unmigratable version, a path outside the docs root), so an agent can tell "my document needs work" from "my call was wrong".

## Protocol

- `initialize` answers with `capabilities: { tools: { listChanged: false } }`, the package version and an `instructions` block that states the invariants that are expensive to get wrong (the v1 API does not exist, documents are data, a handler must not `await` a conversation it starts, ids are opaque).
- Supported revisions: `2025-06-18`, `2025-03-26`, `2024-11-05`. A client asking for another one is answered with `2025-06-18` and decides what to do.
- `ping`, `tools/list` and `tools/call`; anything else (`resources/*`, `prompts/*`, `logging/setLevel`) answers `-32601`, because those capabilities are not advertised.
- **Notifications are never answered** (JSON-RPC forbids it), including `notifications/initialized`.
- One JSON object per line. A malformed line answers `-32700` and the session continues. Nothing but protocol messages is written to stdout; diagnostics go to stderr.

## Documentation search

With `--docs`, `docs_search` indexes every `.md` under the directory except generated output (`api/`, `dist/`, `.vitepress/`) and the internal design notes (`superpowers/`), and splits them into heading-delimited sections (a `#` inside a fenced code block is not a heading).

Ranking is deterministic and deliberately simple: accent- and case-insensitive terms, **inverse document frequency** so a rare identifier (`appendLog`) outranks a word that appears on every page (`durabilidad`), presence instead of raw counts, a doubled weight for heading hits, a coverage bonus and an exact-phrase bonus. English and Spanish pages are indexed together, so one query reaches both.

`docs_page` only reads `.md` files and rejects any path that escapes the docs root.

## Tests

`pnpm --filter @bot-wa/mcp test` covers the framing (messages split across chunks, `\r\n`, a last line without a newline, UTF-8 chunks), every tool with valid and invalid input, the 14 step kinds, subflow resolution, migration of a versionless document, a bilingual search over a temporary tree (including `../` rejection) and the version lockstep with `package.json`.
