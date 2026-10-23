# @botmesh/mcp

> **Private package** (`"private": true`, not published to npm). Real implementation; the API may change without notice while the alpha is out.

**MCP** (Model Context Protocol) server over stdio for botmesh: it exposes the project's pure pieces so any coding agent (Copilot, Claude Code, an editor) can write, validate, compile, draw, lint, migrate and diff **JSON flow documents without starting a bot**.

No dependencies, no network, no `eval`: the protocol (line-delimited JSON-RPC 2.0) is implemented here and every tool is a function of its arguments.

## Tools

| Tool | What it does |
| --- | --- |
| `flow_validate` | Validates against the versioned schema (draft 2020-12) and returns every problem with its JSON Pointer path. |
| `flow_analyze` | Validates, compiles, draws the graph (Mermaid or JSON) and returns the core `lintFlows` diagnostics in one call. Accepts `subflows` (id → document) for `subflow`. |
| `flow_migrate` | Chains the known migrations (no `version` is read as 0) and returns the migrated document and the applied steps. |
| `flow_diff` | Structural diff of two valid documents, with each side's digest. |
| `flow_digest` | `sha256` over canonical JSON (key order does not change the result) and the version label `publishFlow` uses. |
| `flow_schema` | The full JSON Schema, the structural limits and the accepted step types (derived from the schema, never stale). |
| `flow_example` | A canonical document that validates and lints clean. |
| `docs_search` | Searches the guides (EN and ES) and returns sections with path, heading and snippet. Only when a docs directory is configured. |
| `docs_page` | Returns the markdown of a page by its relative path. Only with `docsDir`. |

**Error convention:** an invalid document is a **successful** call with `valid: false` and the `issues` list; `isError` is reserved for the request itself (missing or mistyped arguments, non-migratable version, path outside the docs directory).

## Usage

```bash
pnpm build                                   # packages resolve through lib/

# With the guides (adds docs_search / docs_page):
node packages/mcp/lib/bin.js --docs docs

# Flow tools only:
node packages/mcp/lib/bin.js
```

`--docs <dir>` or the `BOTWA_DOCS_DIR` variable. **stdout is the protocol channel**: diagnostics go to stderr.

### VS Code

The repo ships `.vscode/mcp.json`; after `pnpm build`, MCP → *botmesh* → Start.

### Programmatic

```ts
import { createMcpServer, serveStream } from '@botmesh/mcp'

const server = createMcpServer({ docsDir: 'docs' })
await serveStream(process.stdin, { server, write: (line) => process.stdout.write(`${line}\n`) })
```

## Design

- **No dependencies.** The transport is a hand-written `LineDecoder` + `JSON-RPC` (same as `@botmesh/server` and `@botmesh/manager`), with `ping`, `initialize`, `tools/list` and `tools/call`; `resources/*` and `prompts/*` answer `-32601` because they are not advertised as capabilities.
- **Only what already exists.** `flow_*` wraps `@botmesh/flow-schema` and `lintFlows`/`describeFlows` from `@botmesh/core`; it reimplements no validation and adds no second schema.
- **`initialize` carries the rules that are expensive to get wrong**: the v1 API does not exist, documents are data, `void runtime.enter(...)` and identity is resolved by the provider.
- **Deterministic search ranking**: no ranking model or fuzzy matching; IDF + presence + heading bonus, with EN/ES stopwords. A rare identifier (`appendLog`) beats a word that appears on every page.

## Tests

`pnpm --filter @botmesh/mcp test` — 49 cases: framing with split chunks, envelopes, every tool (valid/invalid/migration/diff/subflow), the schema against the 14 step types, bilingual search over a temporary tree (including rejecting `../`), and version synchronization with `package.json`.
