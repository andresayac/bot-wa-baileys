# Esquema JSON de flujos

`@botmesh/flow-schema` (privado, solo en el monorepo) define **documentos de flujo versionados y sin código**: JSON que el manager guarda y reemplaza en caliente, que el gate de despliegues valida y que compila a un `CompiledFlow` del core.

Un documento es **solo datos**. Nunca lleva funciones, `eval`, imports ni expresiones arbitrarias: el único cálculo es un lenguaje de expresiones seguro y plantillas `{{ path }}`.

```ts
import { compileFlowDocument, validateFlowDocument } from '@botmesh/flow-schema'

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

## Documento

| Campo | Notas |
| --- | --- |
| `version` | Debe ser `1`. Usa `migrateFlowDocument()` para formas antiguas. |
| `id` | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`; es el nombre del flujo en el bot. |
| `trigger` | Una keyword, un array, o `{ keywords, match: 'equals' \| 'contains' \| 'startsWith' \| 'endsWith', scope: 'dm' \| 'group' \| 'all' }`. |
| `timeout` | Timeout del flujo (ms o `'30s'`, `'5m'`, `'1h'`; como máximo 7 días). |
| `persistent` | Sobrevive a un reinicio (requiere un store persistente). |
| `steps` | Al menos uno; como máximo 500 en total (anidados incluidos), 8 niveles de profundidad. |

## Pasos

| Tipo | Qué hace |
| --- | --- |
| `say` | Envía texto (admite plantillas). |
| `ask` | Envía texto, espera una respuesta y la guarda en `c.state[stateKey]`; admite `timeout`, `retries` y `validate: { expr, message }` (`$answer` es la respuesta cruda). |
| `choose` | Menú numerado (`options: [{ key, label, steps? }]`), guarda la clave elegida. |
| `condition` | Expresión `if` con pasos anidados en `then`/`else`. |
| `delay` | Pausa (`'500ms'`… como máximo 5 minutos). |
| `goto` | Salta a otro flujo registrado. |
| `end` | Termina la conversación, con despedida opcional. |
| `media` | Envía `image`, `video`, `audio`, `voice`, `document`, `sticker` o `location`. Los archivos necesitan `source: { url }` (http/https) o `{ stateKey }` (una URL guardada en el estado); la ubicación necesita `latitude`/`longitude`. |
| `form` | Formulario nativo (o pregunta a pregunta) con campos tipados; ver [Formularios](./formularios.md). |
| `guard` | Expresión `if`; si es falsa envía `message` y termina, o `message` + `redirect` a otro flujo. |
| `subflow` | Ejecuta otro documento en línea (mismo estado), resuelto con `resolveSubflow`. |
| `http` | Petición HTTP declarativa a través de `@botmesh/http` (anti-SSRF, redirecciones, timeout y límites de tamaño). Guarda el cuerpo JSON/texto en `stateKey`. |
| `handoff` | Pasa el chat a una persona (`ctx.handoff`), con mensaje opcional. |
| `ai` | Un turno de IA con `ctx.tools.ai.replyInChat`, opcionalmente restringido a ids de herramientas (`tools: ['lookup']`); guarda la respuesta en `stateKey`. |

Las URLs de media deben ser http(s). Rutas locales, buffers y streams **no** se pueden representar a propósito: un documento guardado no puede leer el sistema de archivos del servidor.

## Expresiones seguras

`condition.if`, `guard.if` y `ask.validate.expr` usan un lenguaje recursivo mínimo:

- literales (`1`, `'texto'`, `true`, `false`, `null`), rutas de estado (`user.city`), `== != < <= > >= && || ! + -` y paréntesis;
- funciones: `len`, `lower`, `upper`, `trim`, `number`, `string`, `contains`, `startsWith`, `endsWith`, `empty`, `oneOf`.

Sin `eval`, sin `Function`, sin regexes, sin índices, sin asignación y sin acceso al prototipo (`__proto__`, `prototype` y `constructor` se rechazan). Límites: 1000 caracteres, 256 tokens, 32 niveles.

Las plantillas (`{{ path }}`) solo leen propiedades propias de `c.state` más `$body`, `$from`, `$sender` y `$isGroup`; un valor ausente se pinta como cadena vacía.

## Errores de validación

`validateFlowDocument()` devuelve rutas tipo JSON Pointer:

```ts
validateFlowDocument({ version: 1, id: 'x', trigger: 'x', steps: [{ kind: 'ask', text: '', stateKey: 'bad key' }] })
// [{ path: '/steps/0/text', message: '...' }, { path: '/steps/0/stateKey', message: '...' }]
```

`compileFlowDocument()` lanza `FlowDocumentError` con los mismos problemas. El JSON Schema (`FLOW_DOCUMENT_SCHEMA`, draft 2020-12) lo sirve el manager en `GET /v1/flows/schema` para editores y generación de código.

## Subflujos

```ts
bot.registerFlow(compileFlowDocument(parent, {
  resolveSubflow: (id) => documents.get(id),
}))
```

Los pasos del subflujo corren en línea (mismo `c.state`, sin un segundo trigger). Un documento que falta o un ciclo (`a → b → a`) es un error de compilación.

## Migraciones

```ts
import { migrateFlowDocument } from '@botmesh/flow-schema'

const { document, from, applied } = migrateFlowDocument(storedDraft)
```

La versión 0 (sin `version`, la forma anterior a la versionada) pasa a la 1. Una versión más nueva que el paquete se rechaza; las migraciones se pueden ampliar y encadenar (`migrateFlowDocument(input, migrations, target)`).

## Exportación inversa

```ts
import { exportFlowDocument } from '@botmesh/flow-schema'

const document = exportFlowDocument(compiledFlow)
```

Los flujos compilados desde un documento hacen round-trip exacto (el JSON original se guarda como metadato del paso). Los flujos escritos con el DSL exportan sus pasos declarativos (`say`, `ask`, `choose`, `goto`, `delay`, `media`, `form`, `use`); un `do` opaco o un guard con función lanzan `FlowExportError` con las rutas de los pasos en vez de descartarlos en silencio.

## Borradores y despliegues

```ts
import { diffFlowDocuments, flowDigest, publishFlow } from '@botmesh/flow-schema'

const changes = diffFlowDocuments(draft, published)   // metadatos, pasos añadidos/quitados/cambiados con rutas
const digest = flowDigest(draft)                      // sha256 del JSON canónico, estable ante el orden de claves
await publishFlow(registry, 'acme', 'support', draft) // gate de DeploymentRegistry + gate run auditado
```

`publishFlow()` usa el JSON del documento como artefacto y un `flowDocumentGate()` que parsea, valida y compila el candidato; `options.gate` puede encadenar otro gate (p. ej. transcripciones doradas). El almacenamiento es de `@botmesh/deployments`; este paquete solo aporta los helpers puros.

## REST del manager

Los endpoints de flujos del manager (`POST`/`PUT`) aceptan exactamente estos documentos. `GET /v1/flows/schema` sirve el JSON Schema y `GET/PUT/DELETE /v1/bots/{botId}/flows/{flowId}` los guardan y reemplazan en caliente sin cambiar el contrato REST. Los pasos `subflow` se resuelven contra los demás flujos guardados del bot.
