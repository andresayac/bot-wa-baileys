# Servidor MCP

`@bot-wa/mcp` (privado, solo monorepo) es un servidor **MCP** (Model Context Protocol) por stdio. Le da a un agente de código (o a un editor) las piezas deterministas del proyecto para escribir, validar, compilar, dibujar, lintear, migrar y comparar un documento de flujo **sin arrancar un bot**: sin teléfono, sin credenciales, sin red.

Cada herramienta es una función de sus argumentos. El servidor **no tiene dependencias** (el transporte JSON-RPC son ~150 líneas de `LineDecoder` + envelopes), nunca evalúa código y nunca escribe en disco.

## Arrancarlo

```bash
pnpm build                                     # los paquetes se resuelven por lib/

node packages/mcp/lib/bin.js --docs docs       # herramientas de flujo + docs_search / docs_page
node packages/mcp/lib/bin.js                   # solo herramientas de flujo
```

`--docs <dir>` (o `BOTWA_DOCS_DIR`) apunta a un árbol de documentación; sin él las dos herramientas de docs **no** se anuncian en `tools/list`, así que un cliente nunca ve una herramienta que no puede funcionar.

En VS Code el repo ya trae `.vscode/mcp.json`: ejecuta `pnpm build` una vez y arranca el servidor *bot-wa* desde la vista MCP.

### Por programa

```ts
import { createMcpServer, serveStream } from '@bot-wa/mcp'

const server = createMcpServer({ docsDir: 'docs' })
await serveStream(process.stdin, { server, write: (line) => process.stdout.write(`${line}\n`) })
```

## Herramientas

| Herramienta | Entrada | Devuelve |
| --- | --- | --- |
| `flow_validate` | `document` | `{ valid, issues: [{ path, message }], summary? }` — cada issue trae el JSON Pointer del nodo que falla. |
| `flow_analyze` | `document`, `subflows?`, `format?`, `direction?` | Valida, compila, dibuja el grafo (`mermaid` por defecto, `graph` con `format: "json"`) y devuelve los diagnósticos de `lintFlows`. |
| `flow_migrate` | `document`, `target?` | `{ document, from, to, applied, issues }`. Un documento sin `version` se lee como 0. |
| `flow_diff` | `left`, `right` | `{ changed, metadata, added, removed, changedSteps, before, after }` (los dos últimos son digests). |
| `flow_digest` | `document` | `{ digest, version }` — `sha256` sobre JSON canónico, así que el orden de claves y el formato no lo cambian. |
| `flow_schema` | — | El esquema draft 2020-12, sus `limits` y `stepKinds` (derivados del propio esquema). |
| `flow_example` | — | Un documento canónico que valida y lintea limpio. |
| `docs_search` | `query`, `limit?` | Secciones con `path`, `title`, `heading`, `snippet` y `score` (solo con directorio de docs). |
| `docs_page` | `path` | El markdown de una página (solo con directorio de docs). |

`flow_analyze` ejecuta **las mismas** `describeFlows()` y `lintFlows()` que usan `bot.describe()` y `bot.lint()`, y `flow_*` envuelve `@bot-wa/flow-schema`, así que el servidor no puede contradecir al runtime ni al gate de despliegue.

### «Válido» o «inválido» es un resultado, no un error

Un documento inválido es una llamada **correcta** cuyo payload dice `valid: false` con los problemas:

```json
{ "jsonrpc": "2.0", "id": 2, "result": { "content": [{ "type": "text", "text": "{\n  \"valid\": false,\n  \"issues\": [{ \"path\": \"/steps/0/text\", \"message\": \"must be string\" }]\n}" }] } }
```

`isError: true` queda reservado para la **petición** (argumentos ausentes o mal tipados, una versión que no se puede migrar, una ruta fuera del directorio de docs), así que un agente distingue «mi documento necesita trabajo» de «mi llamada estaba mal».

## Protocolo

- `initialize` responde con `capabilities: { tools: { listChanged: false } }`, la versión del paquete y un bloque `instructions` con las reglas caras de equivocar (la API v1 no existe, los documentos son datos, un handler no debe hacer `await` de la conversación que inicia, los ids son opacos).
- Revisiones soportadas: `2025-06-18`, `2025-03-26`, `2024-11-05`. A un cliente que pide otra se le contesta `2025-06-18` y él decide qué hacer.
- `ping`, `tools/list` y `tools/call`; cualquier otra cosa (`resources/*`, `prompts/*`, `logging/setLevel`) contesta `-32601`, porque esas capabilities no se anuncian.
- **Las notificaciones nunca se contestan** (JSON-RPC lo prohíbe), incluida `notifications/initialized`.
- Un objeto JSON por línea. Una línea malformada contesta `-32700` y la sesión sigue. Por stdout solo salen mensajes del protocolo; los diagnósticos van a stderr.

## Búsqueda en la documentación

Con `--docs`, `docs_search` indexa cada `.md` del directorio salvo la salida generada (`api/`, `dist/`, `.vitepress/`) y las notas de diseño internas (`superpowers/`), y las parte en secciones por heading (un `#` dentro de un bloque de código no es un heading).

El ranking es determinista y deliberadamente simple: términos sin acentos ni mayúsculas, **frecuencia inversa de documento** para que un identificador raro (`appendLog`) gane a una palabra que aparece en todas las páginas (`durabilidad`), presencia en vez de conteos brutos, doble peso si el término está en el heading, bonus por cobertura y por frase exacta. Las páginas en inglés y en español se indexan juntas, así que una consulta alcanza a las dos.

`docs_page` solo lee archivos `.md` y rechaza cualquier ruta que se salga del directorio de docs.

## Tests

`pnpm --filter @bot-wa/mcp test` cubre el framing (mensajes partidos entre chunks, `\r\n`, una última línea sin salto, chunks en UTF-8), cada herramienta con entrada válida e inválida, los 14 tipos de paso, la resolución de subflows, la migración de un documento sin versión, una búsqueda bilingüe sobre un árbol temporal (incluido el rechazo de `../`) y la sincronización de la versión con `package.json`.
