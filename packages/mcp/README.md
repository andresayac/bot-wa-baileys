# @bot-wa/mcp

> **Paquete privado** (`"private": true`, no se publica en npm). Implementación real; la API puede cambiar sin aviso mientras la alpha no salga.

Servidor **MCP** (Model Context Protocol) por stdio para BotWA: expone las piezas puras del proyecto para que cualquier agente de código (Copilot, Claude Code, un editor) escriba, valide, compile, dibuje, lintee, migre y compare **documentos de flujo JSON sin arrancar un bot**.

Sin dependencias, sin red, sin `eval`: el protocolo (JSON-RPC 2.0 delimitado por líneas) está implementado aquí mismo y cada tool es una función de sus argumentos.

## Herramientas

| Tool | Qué hace |
| --- | --- |
| `flow_validate` | Valida contra el esquema versionado (draft 2020-12) y devuelve cada problema con su ruta JSON Pointer. |
| `flow_analyze` | Valida, compila, dibuja el grafo (Mermaid o JSON) y devuelve los diagnósticos de `lintFlows` de una sola vez. Acepta `subflows` (id → documento) para `subflow`. |
| `flow_migrate` | Encadena las migraciones conocidas (sin `version` se lee como 0) y devuelve el documento migrado y los pasos aplicados. |
| `flow_diff` | Diff estructural de dos documentos válidos, con el digest de cada lado. |
| `flow_digest` | `sha256` sobre JSON canónico (el orden de claves no cambia el resultado) y la etiqueta de versión que usa `publishFlow`. |
| `flow_schema` | El JSON Schema completo, los límites estructurales y los tipos de paso aceptados (derivados del esquema, nunca desfasados). |
| `flow_example` | Un documento canónico que valida y lintea limpio. |
| `docs_search` | Busca en las guías (EN y ES) y devuelve secciones con ruta, heading y snippet. Solo si se configura un directorio de docs. |
| `docs_page` | Devuelve el markdown de una página por su ruta relativa. Solo con `docsDir`. |

**Convención de errores:** un documento inválido es una llamada **correcta** con `valid: false` y la lista de `issues`; `isError` se reserva para la petición en sí (argumentos ausentes o mal tipados, versión no migrable, ruta fuera del directorio de docs).

## Uso

```bash
pnpm build                                   # los paquetes se resuelven por lib/

# Con las guías (añade docs_search / docs_page):
node packages/mcp/lib/bin.js --docs docs

# Solo las herramientas de flujo:
node packages/mcp/lib/bin.js
```

`--docs <dir>` o la variable `BOTWA_DOCS_DIR`. **stdout es el canal del protocolo**: los diagnósticos van a stderr.

### VS Code

El repo trae `.vscode/mcp.json`; tras `pnpm build`, MCP → *bot-wa* → Start.

### Programa

```ts
import { createMcpServer, serveStream } from '@bot-wa/mcp'

const server = createMcpServer({ docsDir: 'docs' })
await serveStream(process.stdin, { server, write: (line) => process.stdout.write(`${line}\n`) })
```

## Diseño

- **Sin dependencias.** El transporte es `LineDecoder` + `JSON-RPC` escrito a mano (igual que `@bot-wa/server` y `@bot-wa/manager`), con `ping`, `initialize`, `tools/list` y `tools/call`; `resources/*` y `prompts/*` contestan `-32601` porque no se anuncian como capability.
- **Solo lo que ya existe.** `flow_*` envuelve `@bot-wa/flow-schema` y `lintFlows`/`describeFlows` de `@bot-wa/core`; no reimplementa validación ni añade un segundo esquema.
- **El `initialize` lleva las reglas caras de equivocar**: la API v1 no existe, los documentos son datos, `void runtime.enter(...)` y la identidad la resuelve el provider.
- **README de búsqueda determinista**: sin modelo de ranking ni fuzzy; IDF + presencia + bonus por heading, con stopwords EN/ES. Un identificador raro (`appendLog`) gana a una palabra que aparece en todas las páginas.

## Tests

`pnpm --filter @bot-wa/mcp test` — 49 casos: framing con chunks partidos, envelopes, cada tool (válido/inválido/migración/diff/subflow), el esquema contra los 14 tipos de paso, búsqueda bilingüe sobre un árbol temporal (incluido el rechazo de `../`), y la sincronización de la versión con `package.json`.
