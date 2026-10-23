# @botmesh/flow-schema

> **Private package** (`"private": true`, not published to npm). Real implementation; the API may change without notice while the alpha is out.

**Versioned, code-free** flow documents: validation with precise errors, safe expressions, compilation to `CompiledFlow`, reverse export, migrations and draft/publish helpers for `@botmesh/deployments`.

```ts
import { compileFlowDocument, validateFlowDocument } from '@botmesh/flow-schema'

const document = {
  version: 1 as const,
  id: 'encuesta',
  trigger: 'encuesta',
  steps: [
    { kind: 'ask' as const, text: '¿Tu nombre?', stateKey: 'name' },
    { kind: 'say' as const, text: 'Gracias {{name}}' },
  ],
}
if (validateFlowDocument(document).length === 0) bot.registerFlow(compileFlowDocument(document))
```

## What it includes

- **JSON Schema** (draft 2020-12, `FLOW_DOCUMENT_SCHEMA`) and a dependency-free validator with JSON Pointer paths.
- **Safe expression language** (`condition.if`, `guard.if`, `ask.validate.expr`): no `eval`, `Function`, regexes, indexes or prototype access.
- **Steps**: `say`, `ask`, `choose`, `condition`, `delay`, `goto`, `end`, `media`, `form`, `guard`, `subflow`, `http`, `handoff` and `ai` (with tools by id).
- **Compilation** to the core `CompiledFlow`; declarative steps compile 1:1 so `describe()`/`lint()` and checkpoints work per step.
- **Reverse export** of introspectable flows (`exportFlowDocument`); an opaque `do` throws `FlowExportError` instead of being lost.
- **Migrations** (`migrateFlowDocument`) and pure deploy helpers: `flowDigest`, `diffFlowDocuments`, `flowDocumentGate`, `publishFlow`.
- **Subflows** resolved with `resolveSubflow` (error when missing or cyclic).

## Security

A stored document cannot execute code, read local files or escape its scope: expressions read own properties only, templates resolve paths only, URLs must be http(s), `http` requests go through `@botmesh/http` (anti-SSRF, redirects, timeout and size) and the `ai` step can only restrict already-configured tools, never add new ones.

## Integration

- `@botmesh/manager` consumes this package for `GET /v1/flows/schema` and to compile the flows of its REST API (the contract does not change).
- `@botmesh/deployments` owns storage; this package only provides `publishFlow`/`flowDocumentGate`.

Guía: [`docs/guide/flow-schema.md`](../../docs/guide/flow-schema.md) (EN) y [`docs/es/guide/flow-schema.md`](../../docs/es/guide/flow-schema.md) (ES).
