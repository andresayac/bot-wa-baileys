# @botmesh/flow-schema

> **Paquete privado** (`"private": true`, no se publica en npm). Implementación real; la API puede cambiar sin aviso mientras la alpha no salga.

Documentos de flujo **versionados y sin código**: validación con errores precisos, expresiones seguras, compilación a `CompiledFlow`, exportación inversa, migraciones y helpers de borrador/publicación para `@botmesh/deployments`.

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

## Qué incluye

- **Esquema JSON** (draft 2020-12, `FLOW_DOCUMENT_SCHEMA`) y validador sin dependencias, con rutas JSON Pointer.
- **Lenguaje de expresiones seguro** (`condition.if`, `guard.if`, `ask.validate.expr`): sin `eval`, `Function`, regexes, índices ni acceso al prototipo.
- **Pasos**: `say`, `ask`, `choose`, `condition`, `delay`, `goto`, `end`, `media`, `form`, `guard`, `subflow`, `http`, `handoff` y `ai` (con herramientas por id).
- **Compilación** a `CompiledFlow` del core; los pasos declarativos se compilan 1:1 para que `describe()`/`lint()` y los checkpoints funcionen por paso.
- **Exportación inversa** de flujos introspectables (`exportFlowDocument`); un `do` opaco lanza `FlowExportError` en vez de perderse.
- **Migraciones** (`migrateFlowDocument`) y helpers puros de despliegue: `flowDigest`, `diffFlowDocuments`, `flowDocumentGate`, `publishFlow`.
- **Subflujos** resueltos con `resolveSubflow` (error si faltan o hay ciclos).

## Seguridad

Un documento guardado no puede ejecutar código, leer archivos locales ni salirse de su alcance: las expresiones leen solo propiedades propias, las plantillas solo rutas, las URLs deben ser http(s), las peticiones `http` pasan por `@botmesh/http` (anti-SSRF, redirecciones, timeout y tamaño) y el paso `ai` solo puede restringir herramientas ya configuradas, no añadir nuevas.

## Integración

- `@botmesh/manager` consume este paquete para `GET /v1/flows/schema` y para compilar los flujos de su API REST (el contrato no cambia).
- `@botmesh/deployments` es el dueño del almacenamiento; este paquete solo aporta `publishFlow`/`flowDocumentGate`.

Guía: [`docs/guide/flow-schema.md`](../../docs/guide/flow-schema.md) (EN) y [`docs/es/guide/flow-schema.md`](../../docs/es/guide/flow-schema.md) (ES).
