# bot-wa-baileys — monorepo

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE.md)

Framework moderno y **agnóstico de transporte** para bots de mensajería: flows declarativos para empezar en 30 segundos, un runtime de conversaciones async para control total, y un plugin de IA multi-proveedor. Dos transportes de WhatsApp —[Baileys 7](https://github.com/WhiskeySockets/Baileys) (no oficial) y la **Cloud API oficial de Meta**— detrás del mismo `IProvider`, más Telegram y canales experimentales (Messenger, Instagram, Discord, TikTok, email, y WhatsApp vía Evolution API, WPPConnect, Twilio o Gupshup). **Monorepo pnpm** en **alpha**: la primera publicación en npm está en preparación.

## Paquetes

El monorepo tiene **40 paquetes**: 10 **Alpha** (publicables), 25 **Experimentales** y 5 **Prototipos**. No todos están al mismo nivel de madurez, y la columna **Estado** lo dice sin rodeos:

- **Alpha**: forma parte de la primera alpha publicable. **Todavía no está en npm**; la primera publicación se está preparando.
- **Experimental**: implementación real y con tests, pero el paquete es `private`. No se publica todavía y su API puede cambiar.
- **Prototipo**: esqueleto mínimo en memoria (`private`) para explorar el diseño. No sirve para producción: no persiste nada ni escala más allá de un proceso.

| Paquete | Estado | Descripción |
| --- | --- | --- |
| **Core** | | |
| [`@bot-wa/core`](packages/core) | Alpha | Motor agnóstico de transporte: `Bot`, `IProvider v2`, dispatcher, flows/conversaciones, hooks, plugins, store, testing kit. |
| **Transportes (canales)** | | |
| [`@bot-wa/baileys`](packages/baileys-provider) | Alpha | WhatsApp vía Baileys 7 (no oficial, QR o pairing code). |
| [`@bot-wa/meta`](packages/meta-provider) | Alpha | WhatsApp Cloud API **oficial** (webhook, sin baneo, botones/listas/templates nativos). |
| [`@bot-wa/telegram`](packages/telegram-provider) | Alpha | Telegram Bot API (long-poll/webhook, teclados inline, polls nativos). |
| [`@bot-wa/messenger`](packages/messenger-provider) | Experimental | Facebook Messenger (Meta Graph, quick replies/templates). |
| [`@bot-wa/instagram`](packages/instagram-provider) | Experimental | Instagram DM (Meta Graph, quick replies). |
| [`@bot-wa/discord`](packages/discord-provider) | Experimental | Discord (gateway websocket + REST, slash/components). |
| [`@bot-wa/evolution`](packages/evolution-provider) | Experimental | WhatsApp vía [Evolution API](https://github.com/EvolutionAPI/evolution-api) (gateway REST autoalojado, webhook firmado). |
| [`@bot-wa/wppconnect`](packages/wppconnect-provider) | Experimental | WhatsApp vía WPPConnect Server (REST + webhook con token). |
| [`@bot-wa/twilio`](packages/twilio-provider) | Experimental | WhatsApp y SMS vía Twilio Programmable Messaging (webhooks `X-Twilio-Signature`). |
| [`@bot-wa/gupshup`](packages/gupshup-provider) | Experimental | WhatsApp vía Gupshup (API v1 + callbacks v2). |
| [`@bot-wa/gohighlevel`](packages/gohighlevel-provider) | Experimental | GoHighLevel / LeadConnector (Conversations API + webhooks `InboundMessage` firmados). |
| [`@bot-wa/email`](packages/email-provider) | Experimental | Email: IMAP IDLE de entrada + SMTP de salida, hilos, protección contra bucles y rebotes. |
| [`@bot-wa/tiktok`](packages/tiktok-provider) | Experimental | TikTok API for Business: DMs (Business Messaging) y respuestas a comentarios de vídeos propios. |
| **Stores (persistencia)** | | |
| [`@bot-wa/sqlite-store`](packages/sqlite-store) | Alpha | SQLite (`better-sqlite3`, WAL). |
| [`@bot-wa/redis-store`](packages/redis-store) | Alpha | Redis distribuido (+ lock multi-réplica). |
| [`@bot-wa/mongo-store`](packages/mongo-store) | Experimental | MongoDB. |
| [`@bot-wa/postgres-store`](packages/postgres-store) | Experimental | PostgreSQL (`pg`). |
| [`@bot-wa/mysql-store`](packages/mysql-store) | Experimental | MySQL/MariaDB (`mysql2`). |
| **Plugins** | | |
| [`@bot-wa/ai`](packages/ai) | Alpha | IA: Anthropic/OpenAI/Ollama/Gemini + 9 presets OpenAI-compatible (DeepSeek/Qwen/GLM/Kimi/Groq/…), autorespuesta, tool calling con confirmación, memoria a largo plazo por usuario y RAG. Ver la [política de IA de WhatsApp](packages/ai/README.md#política-de-ia-de-whatsapp-desde-el-15-01-2026). |
| [`@bot-wa/nlu`](packages/nlu) | Experimental | Intenciones/NLU local (define/match + `whenIntent`), sin servicios externos. |
| [`@bot-wa/manager`](packages/manager) | Experimental | Orquestador multi-bot (registro, ciclo de vida) + API HTTP sin dependencias (control plane `/v1` con API keys). |
| [`@bot-wa/otel`](packages/otel) | Experimental | OpenTelemetry: trazas del bot (entrada, dispatch, conversaciones, envíos, IA) y `bot.metrics()` como métricas OTel. `@opentelemetry/api` como peer opcional. |
| [`@bot-wa/events`](packages/events) | Experimental | Envelopes versionados, journal idempotente, reintentos y DLQ para procesos asíncronos. |
| [`@bot-wa/rag`](packages/rag) | Experimental | RAG para `@bot-wa/ai`: loaders, chunking, embeddings enchufables (OpenAI-compatible, Ollama, hashing local) e índice vectorial en memoria con persistencia JSON opcional. |
| [`@bot-wa/voice`](packages/voice) | Experimental | Voz: transcripción de notas de voz (OpenAI-compatible, Deepgram) y respuestas habladas (OpenAI, ElevenLabs). |
| [`@bot-wa/chatwoot`](packages/chatwoot) | Experimental | Puente con Chatwoot: sincronización bidireccional y handoff humano llevado por los agentes de Chatwoot. |
| [`@bot-wa/tickets`](packages/tickets) | Experimental | Tickets y colas de soporte (`ctx.tools.tickets`): posición en cola, horario de atención y persistencia en el store. |
| [`@bot-wa/moderation`](packages/moderation) | Experimental | Moderación de grupos: anti-spam, filtros de palabras/regex y de enlaces de invitación, acciones warn/mute/kick/delete. |
| [`@bot-wa/dialogflow`](packages/dialogflow) | Experimental | Dialogflow ES/CX: `detectIntent` por REST (JWT de cuenta de servicio, sin SDK de Google) y enrutado de intents a flows. |
| **Infra compartida** (dependencias de los paquetes Alpha) | | |
| [`@bot-wa/http`](packages/http) | Alpha | Cliente HTTP seguro: anti-SSRF, validación de redirecciones, timeout y límites de descarga. |
| [`@bot-wa/graph-core`](packages/graph-core) | Alpha | Helpers Meta Graph compartidos (verificación de webhook, mapeo de errores, guard de ingest) usados por meta/messenger/instagram. |
| [`@bot-wa/wa-gateway-kit`](packages/wa-gateway-kit) | Interno | Código compartido por los gateways REST de WhatsApp (`evolution`, `wppconnect`): cliente REST sobre `secureFetch`, resolución de media saliente y reconciliación de identidad LID/PN. Privado; no se instala directamente. |
| [`@bot-wa/server`](packages/server) | Experimental | Ingress de webhooks para los providers: body crudo, límites de tamaño, timeouts, concurrencia y endpoints de salud para `node:http`, Express, Fastify y Hono (sin dependencias). |
| **Producto / operación** | | |
| [`@bot-wa/inbox`](packages/inbox) | Prototipo | Inbox omnicanal en memoria: asignación, handoff, notas, unread, SLA y CAS por conversación. |
| [`@bot-wa/crm`](packages/crm) | Prototipo | Contactos, tags, atributos, consentimiento y segmentos por tenant, en memoria. |
| [`@bot-wa/hub`](packages/hub) | Prototipo | Manifiestos de plugins, permisos declarados y compatibilidad por tenant. No ejecuta ni aísla código. |
| [`@bot-wa/campaigns`](packages/campaigns) | Prototipo | Planificador de campañas (consentimiento, segmentos, deduplicación). No envía mensajes. |
| [`@bot-wa/deployments`](packages/deployments) | Prototipo | Registro en memoria de versiones de despliegue, publicación y rollback lógico por tenant. |
| **Tooling** | | |
| [`create-bot-wa`](packages/create-bot-wa) | Alpha | CLI scaffolder (`npm create bot-wa`), 10 templates: `baileys`, `meta`, `telegram`, `ai` y los de caso de uso `games`, `support`, `store`, `restaurant`, `clinic`, `ai-full`. Cada proyecto incluye un `AGENTS.md` para agentes de código. |
| [`eslint-plugin-bot-wa`](packages/eslint-plugin) | Experimental | Reglas de ESLint para bots: restos de la API v1, `runtime.enter` bloqueante, `install` async, triggers vacíos, `ask` sin timeout y estado global por usuario. |

Empieza por el [README del core](packages/core/README.md) para el quickstart.

## Instalación (como usuario)

> **Alpha, primera publicación en npm pendiente.** Ningún paquete `@bot-wa/*` está en npm todavía. Los comandos de abajo son los que funcionarán cuando salga la primera alpha; mientras tanto, clona el repo y usa los paquetes desde el workspace (ver [Desarrollo](#desarrollo-en-este-repo)). Solo los paquetes **Alpha** de la tabla se van a publicar en esa primera tanda.

```bash
pnpm add @bot-wa/core @bot-wa/baileys        # bot WhatsApp (Baileys)
# o @bot-wa/core @bot-wa/meta                # bot WhatsApp oficial (Cloud API)
pnpm add @bot-wa/ai @anthropic-ai/sdk        # + IA (opcional; instala el SDK del proveedor que uses)
```

Requiere **Node >= 22**. Todos los paquetes son **ESM-only**.

> **IA en WhatsApp:** desde el 15-01-2026 los términos de la WhatsApp Business Platform prohíben los asistentes de IA de propósito general (chatbots abiertos estilo ChatGPT). Se permite la IA al servicio del negocio (soporte, ventas, reservas). Detalles en el [README de `@bot-wa/ai`](packages/ai/README.md#política-de-ia-de-whatsapp-desde-el-15-01-2026).

## Desarrollo (en este repo)

```bash
pnpm install            # instala todo el workspace
pnpm build              # pnpm -r build  → compila todos los paquetes
pnpm test               # pnpm -r test   → suite completa
pnpm run docs           # TypeDoc + VitePress → sitio de documentación
```

Por paquete: `pnpm --filter @bot-wa/ai test`, `pnpm --filter @bot-wa/core build`, etc.

## Ejemplos

| Ejemplo | Qué muestra |
| --- | --- |
| [`examples/bakery-ai`](examples/bakery-ai) | Asistente de pedidos con IA para una panadería (en inglés) en WhatsApp, vía Baileys (QR) o Twilio (webhook con `@bot-wa/server`). Herramientas con confirmación, totales calculados en código, `dedupe`, lista de acceso, configuración tipada y tests sin red. |

Se compilan y prueban con el resto del workspace (`pnpm build`, `pnpm test`). Cada ejemplo trae su README con los comandos para ejecutarlo.

## Documentación

- Guías: [`docs/`](docs) (inglés en `docs/guide/`, español en `docs/es/guide/`). No hay sitio publicado; para verlas como web en local: `pnpm docs:dev`.
- Guía de migración v1 → v2: [`docs/MIGRATION-v1-to-v2.md`](docs/MIGRATION-v1-to-v2.md).
- Plan estratégico de producto e ingeniería: [`ROADMAP.md`](ROADMAP.md).
- Catálogo detallado de propuestas: [`FEATURES.md`](FEATURES.md).
- Política de reporte de vulnerabilidades: [`SECURITY.md`](SECURITY.md).
- Diseño y decisiones: [`docs/superpowers/specs/`](docs/superpowers/specs) y [`docs/superpowers/plans/`](docs/superpowers/plans).

## Contribuir

Ver [`CONTRIBUTING.md`](CONTRIBUTING.md). Cambios relevantes en [`CHANGELOG.md`](CHANGELOG.md).

## Licencia

MIT © Andres Aya
