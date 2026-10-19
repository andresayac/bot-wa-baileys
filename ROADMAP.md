# Roadmap estratégico — BotWA

> Estado: propuesta de dirección y secuencia de trabajo  
> Auditoría base: 2026-07-23  
> Baseline revisado: rama `reorg/transport-agnostic`, commit `bf12046`, más los cambios locales existentes  
> Horizonte: convertir el framework actual en una plataforma omnicanal, extensible, self-hosted y opcionalmente gestionada

## Propósito y fuentes de verdad

Este documento define la dirección del producto, el orden de implementación, las dependencias y los criterios de salida. No sustituye los diseños ni los planes TDD de cada iniciativa.

- [`ROADMAP.md`](ROADMAP.md): prioridades, fases, gates y alcance de producto.
- [`FEATURES.md`](FEATURES.md): catálogo técnico detallado de ideas para el runtime, providers, plugins y DX.
- [`docs/superpowers/specs/`](docs/superpowers/specs): decisiones y diseños técnicos aprobados.
- [`docs/superpowers/plans/`](docs/superpowers/plans): planes ejecutables por iniciativa.
- [`CHANGELOG.md`](CHANGELOG.md): capacidades realmente entregadas.
- [`SECURITY.md`](SECURITY.md): política pública de reporte de vulnerabilidades.

Si dos documentos se contradicen, el código y las pruebas describen el comportamiento actual; este roadmap define el orden futuro. Antes de iniciar cada fase se debe crear o aprobar su diseño técnico.

## Resumen ejecutivo

El repositorio ya no es un bot pequeño. Es un SDK omnicanal en fase alfa con:

- 24 paquetes publicables.
- Core agnóstico de transporte, runtime conversacional, flows, hooks, plugins, scheduler y testing kit.
- Baileys, WhatsApp Cloud API, Messenger, Instagram, Telegram y Discord.
- Stores para memoria, SQLite, Redis, MongoDB, PostgreSQL y MySQL.
- IA, NLU, manager multi-bot, helpers Graph y CLI.
- Documentación bilingüe.
- 730 pruebas verdes y build correcto de los 24 paquetes durante la implementación de F2/F4/F5.

La brecha principal no es cantidad de funcionalidades. Es convertir esta superficie técnica en un sistema seguro, durable, observable y fácil de operar.

La estrategia recomendada es preservar `@bot-wa/core` como motor ligero y construir la ambición de plataforma en aplicaciones y contratos separados:

- **BotWA Core:** framework y SDK open source.
- **BotWA Studio:** panel, simulador, flow builder e inbox self-hosted.
- **BotWA Cloud:** control plane gestionado, multi-tenant y escalable.
- **BotWA Hub:** plugins, skills, plantillas e integraciones.

## Principios de producto e ingeniería

1. **Seguridad antes que expansión.** No se abre una nueva superficie sin cerrar los bloqueantes de sesión, webhooks, lifecycle y aislamiento.
2. **Core ligero.** CRM, campañas, billing y frontend viven fuera del runtime.
3. **Contract-first.** Eventos, API, flows, plugins y stores tienen esquemas versionados antes de sus interfaces visuales.
4. **Multi-tenant desde el modelo.** `tenantId`, `botId`, provider y conexión no pueden quedar escondidos en `meta`.
5. **Durabilidad antes de tiempo real.** Primero se persiste y deduplica; después se emite SSE o WebSocket.
6. **No-code sin lock-in.** Todo flow visual debe poder exportarse, versionarse, probarse y compilarse.
7. **UI guiada por capacidades.** Studio solo ofrece funciones nativas o degradables para el canal seleccionado.
8. **Oficial primero en Cloud.** Los canales oficiales son la ruta recomendada para un servicio gestionado; conectores comunitarios quedan identificados por nivel de confianza.
9. **Privacidad por defecto.** Minimización, retención, exportación, borrado y redacción de secretos forman parte del diseño.
10. **Cada feature es operable.** Código, seguridad, métricas, documentación, migración y pruebas se entregan juntos.

## Diagnóstico de la base actual

| Área | Activos existentes | Brecha para producción |
| --- | --- | --- |
| Core | `Bot`, dispatcher, conversaciones, flows, hooks y testing | Lifecycle transaccional, drenaje y errores asíncronos |
| Providers | Seis canales y `ProviderCapabilities` | Conformidad desigual, seguridad de media y eventos faltantes |
| Persistencia | Cinco backends externos más memoria | Ledger incompleto, namespaces, migraciones, CAS y retención |
| Manager | Registry y endpoints de start/stop | Persistencia, reconciliación, RBAC, OpenAPI, auditoría y jobs |
| IA/NLU | Varios modelos, historial, tools básicas y tokens | Permisos, RAG, memoria, presupuestos, evaluaciones y privacidad |
| Plugins | Contrato inicial | Dependencias, permisos, ownership, rollback, firma y aislamiento |
| Frontend | Documentación VitePress | No existen Studio, inbox, flow builder ni analytics |
| CLI | Cuatro templates | Scaffolds de provider/store/plugin y soluciones verticales |
| Release | Build y test en CI | Lint, cobertura, servicios reales, releases, SBOM y provenance |

Notas de mantenimiento detectadas:

- `pnpm run docs` es el comando de documentación compatible con la versión actual de pnpm; `pnpm docs` entra en conflicto con un comando incorporado.
- La generación de documentación termina, pero mantiene advertencias de símbolos referenciados sin documentación.
- Las resoluciones de TypeScript no son uniformes entre paquetes; conviene consolidarlas en una fase de mantenimiento.
- El worktree auditado ya contenía muchos cambios. Debe estabilizarse en unidades pequeñas antes de iniciar una fase nueva.

## Arquitectura objetivo

### Modelo de producto

```text
Workspace
├── Environments
│   └── Bots
│       ├── Channel connections
│       ├── Flow drafts / versions / deployments
│       ├── Simulator
│       └── Logs / health
├── Inbox
├── Contacts / identities / segments
├── Campaigns
├── Knowledge / AI
├── Analytics
├── Integrations / plugins / skills
└── Members / API keys / usage / billing
```

### Estructura de monorepo propuesta

```text
apps/
├── studio/             # panel web y flow builder
├── control-plane/      # API, auth, reconciliación y auditoría
└── worker/             # ejecución durable, jobs, media y campañas

packages/
├── core/               # runtime actual, sin dependencias de producto
├── api-contract/       # OpenAPI, schemas y tipos
├── client/             # SDK generado para el control plane
├── events/             # envelopes, inbox/outbox y deduplicación
├── flow-schema/        # documento serializable y compilador
├── plugin-sdk/         # manifest, permisos, lifecycle y UI extensions
└── ui/                 # design system accesible
```

### Flujo de eventos

```text
Provider
   │
   ▼
Ingress autenticado
   │
   ├── deduplicación / idempotencia
   ▼
Inbox durable ──► cola particionada por conversación ──► Bot runtime
                                                        │
                                                        ▼
                                                  Outbox durable
                                                        │
                           ┌────────────────────────────┼───────────────┐
                           ▼                            ▼               ▼
                       Provider                    Message ledger   Events/SSE
```

El orden por conversación se conserva con particiones o leases. Los reintentos no deben duplicar mensajes ni acciones externas.

Estado (2026-10): los turnos por chat entre réplicas ya existen como opción (`BotConfig.coordination`, `RedisCoordinator`; guía «Varias réplicas»). Falta el inbox/outbox durable: un mensaje que espera turno en una réplica que muere se pierde.

### Contratos que desbloquean la plataforma

#### Event envelope

Debe incluir, como mínimo:

- `eventId`, `eventType`, `schemaVersion` y `occurredAt`.
- `tenantId`, `environmentId`, `botId`, `providerId` y `connectionId`.
- `chatId`, `participantId`, `correlationId` y `causationId`.
- Clave de idempotencia, payload normalizado y referencia opcional al evento nativo.

#### Message ledger

Debe registrar:

- Dirección inbound/outbound.
- Contenido y media normalizados.
- Replies, menciones, reacciones, ediciones y revocaciones.
- Estados queued/sent/delivered/read/failed.
- Identidades, conversación, asignación, unread y timestamps uniformes.
- Retención, cifrado y referencia controlada al payload nativo.

#### Flow document

El modelo actual puede contener funciones y no es serializable. `@bot-wa/flow-schema` debe ofrecer:

- JSON Schema versionado.
- Nodos seguros: trigger, message, ask, choice, condition, delay, webhook, AI, handoff y subflow.
- Acciones referenciadas por ID, no funciones arbitrarias almacenadas.
- Validación, migraciones y compilación a `CompiledFlow`.
- Draft, publish inmutable, diff y rollback.
- Escape hatch de código solo para despliegues explícitamente confiables.

#### Provider capabilities

La UI necesita distinguir:

- `native`: soporte real del canal.
- `degraded`: puede convertirse a texto, enlace u otra representación.
- `unsupported`: debe bloquearse antes de publicar.

También debe expresar límites de tamaño, cantidad, MIME, rate limit y requisitos de plantilla.

#### Plugin manifest v2

Debe declarar:

- Nombre, versión, publisher, firma y compatibilidad.
- JSON Schema de configuración.
- Secretos y permisos requeridos.
- Capacidades aportadas.
- Dependencias y conflictos.
- Install, uninstall y rollback esperables.
- Ownership de tools, hooks, rutas y recursos.
- Migraciones, health check y telemetría.
- Extensiones opcionales de Studio.
- Modelo de aislamiento para código no confiable.

## Dependencias críticas

```text
Seguridad + lifecycle
        │
        ▼
Eventos durables + message ledger ──► API / Studio ──► Inbox / campañas / analytics

Flow schema ──► registry dinámico ──► editor visual ──► templates / AI copilot

Tenancy + RBAC + secretos ──► control plane ──► marketplace / billing / enterprise

Permisos de plugins ──► Hub ──► MCP / agent skills / conectores de terceros
```

No se debe construir inbox antes del ledger, flow builder antes del schema ni marketplace antes del modelo de permisos.

## Prioridad inmediata: safety gate

Estos trabajos bloquean despliegues y expansión. Los detalles técnicos sensibles deben gestionarse mediante issues privados o GitHub Security Advisories.

| Trabajo | Resultado esperado |
| --- | --- |
| Contención de rutas de sesión | Ninguna operación de sesión puede leer o borrar fuera de su raíz |
| Separación stop/logout | Reiniciar o desplegar conserva la autenticación |
| Webhooks sobre body crudo | Firmas válidas pasan y cuerpos alterados fallan |
| Límites de ingress | Body, media y concurrencia permanecen acotados |
| Lifecycle transaccional | Start hace rollback; stop drena y no acepta trabajo nuevo |
| Errores asíncronos | Cero rechazos no manejados en listeners, hooks y providers |
| Scheduler y scopes | Tareas previas a start y scopes DM/group/all quedan probados |
| Debug reproducible | Activar debug no depende de una dependencia ausente |
| Namespaces | Dos bots o tenants no pueden colisionar en el mismo store |
| Cliente HTTP seguro | Timeout, límites, redirects y SSRF se aplican transversalmente |

Gate de salida:

- Tests regresivos para cada caso.
- Build, typecheck, tests y documentación verdes.
- Restart conserva sesiones y no duplica mensajes.
- Ningún secreto, QR o payload sensible aparece en logs.
- Threat model y checklist de release actualizados.

## Tracks de trabajo

### A. Core y experiencia de desarrollo

- `ctx.user` con namespaces, TTL y borrado.
- Retry/fallback consistente.
- Welcome y triggers normalizados.
- Guards y composición explícita de subflows.
- Handoff y modo bot/human/copilot.
- Blacklist/whitelist.
- Idle y timeout.
- Validación por schemas.
- Media completa, typing automático, i18n y delays.
- Trigger programático.
- Métricas del runtime.
- Testing kit de conversaciones, fixtures y fake clock.
- ESLint/plugin de reglas específicas.

### B. Eventos, stores y ejecución durable

- Inbox/outbox, deduplicación y replay.
- Ledger inbound/outbound/receipts.
- Store v3 por capacidades en lugar de una interfaz monolítica.
- Namespaces obligatorios y claves estructuradas.
- Migraciones versionadas.
- CAS, transacciones y locks.
- Paginación, cursores y búsqueda.
- Retención, TTL, exportación y borrado de sujetos.
- Scheduler persistente y distribuido.
- Cola ordenada por conversación.
- DLQ, reintentos y replay administrativo.
- Testcontainers para los cinco stores reales.

### C. Control plane y API

- Desired/observed state por bot y conexión.
- Supervisor persistente y reconciliador.
- REST `/v1` con OpenAPI y SDK TypeScript generado.
- OIDC/JWT, RBAC y API keys con scopes.
- Secret manager, rotación y referencias, nunca valores en respuestas.
- Idempotencia, rate limits, request IDs y errores opacos.
- Audit log.
- Health live/ready y métricas.
- CRUD de bots, conexiones, flows, deployments, conversaciones y mensajes.
- QR/pairing, send, restart, jobs y broadcasts.
- SSE para estado, QR, logs e inbox; WebSocket solo donde aporte interacción bidireccional.

### D. BotWA Studio

- Onboarding guiado por caso de uso y canal.
- Conexiones por QR, OAuth, token o webhook con preflight.
- Dashboard de estado, fallos, reintentos y salud.
- Simulador sobre `MockProvider`, transcript y estado.
- Flow builder con canvas y vista lista accesible.
- Undo/redo, autosave, validación por nodo y capability checks.
- Drafts, diff, publish y rollback.
- Logs buscables y explicación de recuperación.
- API explorer y generador de configuración.
- Importación/exportación JSON y TypeScript.

Frontend de referencia:

- React y TypeScript.
- TanStack Query/Router/Table.
- React Flow para el canvas.
- Radix o shadcn para primitives accesibles.
- Monaco para el escape hatch de código.
- Storybook, Playwright y axe.

La selección final debe quedar documentada en un ADR antes de crear `apps/studio`.

### E. Inbox, contactos y CRM ligero

- Mensajería omnicanal en tiempo real.
- Identidad unificada por persona y múltiples canales.
- Tags, atributos, segmentos, consentimiento y opt-out.
- Unread, búsqueda y filtros.
- Asignación, colas, notas y SLA.
- Handoff sin doble respuesta.
- Modo bot, human o copilot.
- Integraciones Chatwoot, Zendesk e Intercom.

### F. Campañas y automatización

- Segmentación y audiencias.
- Templates aprobados por canal.
- Programación, quiet hours y zonas horarias.
- Rate limiting y límites por proveedor.
- Consentimiento y bajas.
- Aprobación antes de enviar.
- A/B tests.
- Métricas de entrega y conversión.
- Broadcasts como jobs cancelables y reanudables.

El posicionamiento debe ser cumplimiento y deliverability, no evasión de controles del proveedor.

### G. AI Studio

- Tool calling con schemas, scopes y aprobaciones.
- RAG con citas y conectores de conocimiento.
- Memoria corta y larga con consentimiento y TTL.
- Model routing, fallback, cache y presupuestos.
- Versiones de prompts.
- Datasets, evaluaciones, regresiones y red-team.
- Redacción de PII y políticas de residencia.
- Moderación.
- Multimodal: STT, TTS y OCR.
- Aprobación humana para acciones sensibles.
- Costos y tokens por tenant, bot, conversación y feature.
- Streaming mediante edición cuando el provider lo permita.

### H. Plugins, Hub, MCP y skills

#### Integraciones posibles

| Familia | Ejemplos |
| --- | --- |
| Soporte | Chatwoot, Zendesk, Intercom, Freshdesk |
| CRM | HubSpot, Salesforce, Pipedrive |
| Comercio | Shopify, WooCommerce, catálogos Meta |
| Pagos | Stripe, Mercado Pago |
| Agenda | Google Calendar, Outlook, Cal.com |
| Automatización | n8n, Zapier, Make |
| Datos | S3, Sheets, warehouses y vector stores |
| Observabilidad | OpenTelemetry, Prometheus, Grafana, Sentry |
| Comunicación | email, SMS, RCS, web chat y voz/SIP |

#### Skills de runtime

Cada skill ejecutable debe tener:

- Esquema de entrada y salida.
- Scopes y permisos.
- Confirmación para acciones sensibles.
- Timeout, idempotencia y presupuesto.
- Auditoría y métricas.

#### Soluciones verticales

Cada solución debe incluir flow, modelo de datos, prompts, dashboard, pruebas y checklist:

- Restaurantes y reservas.
- Clínicas y citas.
- Ecommerce.
- Inmobiliarias.
- Educación.
- Cobranza.
- Delivery.
- Eventos.
- Recursos humanos.
- Soporte y mesa de ayuda.

#### Skills de mantenimiento

- `add-provider`
- `add-store`
- `add-plugin`
- `docs-bilingual`
- `release-monorepo`
- `provider-security-audit`
- `studio-e2e`
- `api-compatibility`
- `migration-generator`

MCP se evalúa después de tener permisos, secretos y auditoría; no debe abrirse como ejecución arbitraria desde el primer MVP.

### I. Providers y cobertura de canales

- Completar normalización, receipts, edit/revoke, replies, mentions y media en providers actuales.
- Auth state centralizado y cifrado para Baileys.
- Lease por sesión para evitar dos procesos propietarios. Hecho para el arranque del provider (`exclusiveSession` + `providerSession: 'leader'`); falta el fencing del auth state de Baileys.
- Matriz de capacidades y límites por canal.
- Scaffolder y suite de conformidad para terceros.
- Trust tiers: official, verified y community.
- Posibles providers: Evolution API, Twilio/SMS/RCS, WPPConnect, email, voz/SIP, TikTok, LINE, Matrix y web chat.

No se recomienda mantener todos como first-party. La plataforma debe facilitar providers comunitarios verificables.

### J. Ingeniería, release y operación

- Unificar Node soportado y versión de TypeScript.
- ESLint o Biome y formato.
- Coverage mínimo y reportes.
- Property, fuzz, load y soak tests.
- Changesets, changelog y política alpha/beta/stable.
- Smoke test de instalación y `npm pack`.
- SBOM, provenance y secret scanning.
- CodeQL y auditoría de dependencias.
- Docker Compose para desarrollo.
- Backups, restore drills y disaster recovery.
- Helm, chaos testing y multi-region solo cuando la carga lo justifique.
- SLO, alertas y runbooks.

### K. Enterprise y negocio

- Usage metering, cuotas y billing.
- Planes por mensajes, bots, agentes, almacenamiento y tokens.
- Entornos dev/staging/prod.
- Aprobaciones y colaboración.
- White-label y agencias.
- SSO, SCIM y políticas organizacionales.
- BYOK/KMS.
- Data residency.
- Exportaciones y auditoría avanzada.
- PWA para operación móvil.

## Fases de entrega

Las duraciones son orientativas para un equipo de dos a cuatro personas y deben recalibrarse después de estabilizar el worktree.

### F0 — Seguridad y corrección

Duración orientativa: 1 semana.

Entregables:

- Safety gate completo.
- Regresiones para sesiones, webhooks, lifecycle, scheduler, scopes y debug.
- Errores asíncronos capturados.
- Baseline Node/TypeScript/CI decidido.
- Política de seguridad publicada.

Salida: todos los criterios del safety gate aprobados.

### F1 — Runtime productivo y datos

Duración orientativa: 2–3 semanas.

Entregables:

- Event envelope.
- Inbox/outbox y deduplicación. *(Parcial: inbox/outbox durables opt-in en el core, `BotConfig.durability`, con backends en memoria, archivo, PostgreSQL y Redis.)*
- Message ledger completo.
- Namespaces multi-tenant.
- Máquina de estados y drenaje.
- HTTP/media seguro.
- Retención, exportación y borrado.
- OpenTelemetry.
- Conformance tests contra servicios reales.

Salida:

- Dos tenants no pueden leer ni sobrescribir datos entre sí.
- Reiniciar y reproducir eventos no duplica efectos.
- El historial reconstruye inbound, outbound y receipts.
- Tests concurrentes no pierden checkpoints.

### F2 — Control plane

Duración orientativa: 4–6 semanas.

Entregables:

- Manager persistente y reconciliador.
- OpenAPI `/v1` y cliente generado.
- Auth, RBAC, secretos y audit log.
- Jobs, DLQ y replay.
- QR, logs, health y estado vía SSE.
- Scheduler durable. *Parcial:* tareas con `id` persistidas en un `ScheduleStore` (memoria, SQLite, Redis), política de ejecuciones perdidas y reclamos con lease y fencing por ejecución. Faltan backends Postgres/MySQL/Mongo (la suite de conformidad los hace mecánicos) y unificar `LeaseProvider` con el coordinador multi-réplica.

Salida:

- Dos operaciones lifecycle simultáneas producen un único resultado consistente.
- Repetir una idempotency key no duplica mensajes.
- Ningún secreto aparece en respuestas o logs.
- Pruebas negativas demuestran aislamiento de tenant.

### F3 — Studio MVP

Duración orientativa: 4–6 semanas.

Entregables:

- Workspace, bot y conexión.
- Baileys QR más al menos un provider oficial por token/webhook.
- Estado, restart, logs y envío de prueba.
- Simulador.
- `flow-schema` y editor de `say`, `ask`, `choice`, condition y `goto`.
- Publish y rollback.

Salida:

- Primer bot conectado y primera respuesta en menos de diez minutos.
- No se necesita terminal después de desplegar Studio.
- Todo flow se valida y simula antes de publicar.
- Una versión se revierte sin intervención manual en el runtime.

No entran aún: billing, campañas masivas, marketplace abierto, JavaScript arbitrario, white-label ni app móvil.

### F4 — Operación y producto

Duración orientativa: 4–6 semanas.

Entregables:

- Inbox y ledger en tiempo real.
- Handoff y operación de agentes.
- Contactos, tags, segmentos y consentimiento.
- Analytics de entrega, funnels, SLA y costos.
- AI Studio inicial.
- Primeras plantillas verticales.

Salida:

- Bot y humano nunca responden simultáneamente.
- El historial de decisiones y mensajes es auditable.
- Costos AI y acciones sensibles quedan limitados por política.

### F5 — Ecosistema y escala

Duración: continua.

Entregables:

- Plugin SDK v2 y registry firmado.
- Integration Hub y trust tiers.
- Campañas compliance-first.
- Providers y skills de terceros.
- Multi-réplica, session leases y workers de media.
- Billing y capacidades enterprise.

Salida:

- Orden por conversación comprobado bajo múltiples réplicas.
- Plugins no acceden a capacidades no declaradas.
- Artefactos tienen provenance y compatibilidad verificable.

## Primer backlog ejecutable

Orden recomendado:

1. Inventariar y estabilizar los cambios locales actuales.
2. Proteger todas las operaciones de rutas de sesión.
3. Separar cierre de conexión y logout destructivo.
4. Validar webhooks contra el body crudo e imponer límites.
5. Reparar lifecycle, errores asíncronos, scheduler, scopes y debug.
6. Versionar `@bot-wa/events`.
7. Diseñar y persistir el message ledger.
8. Introducir namespaces multi-tenant y políticas de privacidad.
9. Centralizar HTTP y media seguros.
10. Crear `@bot-wa/api-contract` y la API `/v1`.
11. Crear `@bot-wa/flow-schema`.
12. Levantar Studio con onboarding, QR, health y simulador.
13. Añadir inbox y handoff.
14. Crear Plugin SDK v2.
15. Abrir Hub, campañas y nuevas integraciones después de los gates.

Cada punto a partir del 6 requiere una spec y un plan fechado en `docs/superpowers/`.

## Estado revisado de FEATURES.md

[`FEATURES.md`](FEATURES.md) se conserva como catálogo de propuestas y APIs posibles; cada entrada lleva una línea **Estado** con la API real y su guía. Estado a 2026-10-18:

- Implementado: `#1–#37`, `#39` y `#40`. Lo que vive en paquetes nuevos sigue siendo **privado** (Experimental, sin publicar): proveedores `#17–#23` (`evolution`, `twilio`, `tiktok`, `email`, `wppconnect`, `gohighlevel`, `gupshup`), voz `#16` (`@bot-wa/voice`, como plugin y no como provider), RAG `#29` (`@bot-wa/rag`), Dialogflow `#31`, plugins `#32–#34` (`chatwoot`, `tickets`, `moderation`), manager `#24–#27` y `#40` (`eslint-plugin-bot-wa`).
- Parcial: `#38` (`createTestBot` no tiene `expectNoReply` ni `sendMedia`/`sendReaction`; el snapshot de conversación lo cubren los golden transcripts).
- Ideas del análisis fuera del catálogo, ya implementadas: kit de caos, contrato de identidad, idempotencia de entrada, describe/lint de flujos, `bot-wa dev`, ingress de webhooks (`@bot-wa/server`), ventana de 24 h y pricing de la Cloud API, `ctx.stream`, golden transcripts con gate de publicación, estado tipado en flujos, `AGENTS.md` en los proyectos generados y formularios nativos (WhatsApp Flows).

Los elementos que allí aparecen como “descartados” deben interpretarse así:

| Elemento | Ubicación correcta |
| --- | --- |
| Pagos, CRM, calendario y traducción | BotWA Hub / integrations |
| Dashboard y flow builder | BotWA Studio |
| Docker, Helm y CI | Engineering / operations |
| Marketplace | BotWA Hub / negocio |
| Skills por industria | Solutions / templates |

No pertenecen a `@bot-wa/core`, pero sí forman parte de la plataforma.

## Métricas de éxito

### Activación

- Tiempo hasta primer bot conectado.
- Tiempo hasta primera respuesta real.
- Porcentaje de conexiones completadas sin terminal.
- Porcentaje de flows que pasan simulación antes de publish.

### Confiabilidad

- Disponibilidad por provider.
- Mensajes duplicados o perdidos.
- Tiempo de recuperación de conexión.
- Profundidad y antigüedad de DLQ.
- Errores no manejados.

### Operación

- Tiempo medio de handoff y primera respuesta humana.
- SLA cumplido.
- Tasa delivered/read/failed.
- Tiempo de rollback.

### IA

- Costo por conversación y resultado.
- Latencia por modelo.
- Tool calls aprobadas, rechazadas y fallidas.
- Resultado de evals y regresiones.

### Ecosistema

- Plugins verificados.
- Tiempo para crear un provider/store/plugin.
- Compatibilidad entre releases.
- Instalaciones y fallos por integración.

## Definition of Done

Una iniciativa no está terminada hasta incluir:

- Contrato y compatibilidad documentados.
- Tests unitarios, integración y casos negativos.
- Seguridad y threat model proporcional al riesgo.
- Lifecycle completo, rollback y limpieza.
- Métricas, logs redactados y health.
- Migración de datos o configuración.
- Documentación y ejemplo.
- Entrada de changelog.
- Verificación de que no rompe providers, stores ni tenants existentes.

## Gobierno del roadmap

- Revisar este documento al terminar cada fase o ante un cambio de arquitectura.
- No usar porcentajes de progreso subjetivos; registrar entregables y gates.
- Una capacidad solo cambia a “entregada” cuando aparece en el changelog y pasa sus criterios.
- Las ideas nuevas entran primero en `FEATURES.md`; solo pasan a este roadmap cuando tienen prioridad, dependencia y gate.
- Mantener los detalles sensibles en canales privados hasta disponer de corrección y advisory coordinado.
