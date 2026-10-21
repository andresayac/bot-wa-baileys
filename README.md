# bot-wa-baileys — monorepo

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE.md)

A modern, **transport-agnostic** framework for messaging bots: declarative flows to get going in 30 seconds, an async conversation runtime when you need full control, and a multi-provider AI plugin. Two WhatsApp transports —[Baileys 7](https://github.com/WhiskeySockets/Baileys) (unofficial) and the **official Meta Cloud API**— behind the same `IProvider`, plus Telegram and experimental channels (Messenger, Instagram, Discord, TikTok, email, and WhatsApp through Evolution API, WPPConnect, Twilio or Gupshup). **pnpm monorepo** in **alpha**: the first npm publish is being prepared.

## Packages

The monorepo has **44 packages**: 10 **Alpha** (publishable), 26 **Experimental** and 8 **Product** and infrastructure ones. They are not all equally mature, and the **Status** column says so plainly:

- **Alpha**: part of the first publishable alpha. **Not on npm yet**; the first publish is being prepared.
- **Experimental**: real, tested implementation, but the package is `private`. Not published yet and its API may change.
- **Product / internal**: real, persistent implementation (`private`) over any core `DurableKv`. Per-tenant isolation and compare-and-set in the backend; the API may change until the alpha ships.

| Package | Status | Description |
| --- | --- | --- |
| **Core** | | |
| [`@bot-wa/core`](packages/core) | Alpha | Transport-agnostic engine: `Bot`, `IProvider v2`, dispatcher, flows/conversations, hooks, plugins, store, testing kit. |
| **Transports (channels)** | | |
| [`@bot-wa/baileys`](packages/baileys-provider) | Alpha | WhatsApp through Baileys 7 (unofficial, QR or pairing code). |
| [`@bot-wa/meta`](packages/meta-provider) | Alpha | **Official** WhatsApp Cloud API (webhook, no ban risk, native buttons/lists/templates). |
| [`@bot-wa/telegram`](packages/telegram-provider) | Alpha | Telegram Bot API (long-poll/webhook, inline keyboards, native polls). |
| [`@bot-wa/messenger`](packages/messenger-provider) | Experimental | Facebook Messenger (Meta Graph, quick replies/templates). |
| [`@bot-wa/instagram`](packages/instagram-provider) | Experimental | Instagram DM (Meta Graph, quick replies). |
| [`@bot-wa/discord`](packages/discord-provider) | Experimental | Discord (gateway websocket + REST, slash/components). |
| [`@bot-wa/evolution`](packages/evolution-provider) | Experimental | WhatsApp through [Evolution API](https://github.com/EvolutionAPI/evolution-api) (self-hosted REST gateway, signed webhook). |
| [`@bot-wa/wppconnect`](packages/wppconnect-provider) | Experimental | WhatsApp through WPPConnect Server (REST + token webhook). |
| [`@bot-wa/twilio`](packages/twilio-provider) | Experimental | WhatsApp and SMS through Twilio Programmable Messaging (`X-Twilio-Signature` webhooks). |
| [`@bot-wa/gupshup`](packages/gupshup-provider) | Experimental | WhatsApp through Gupshup (API v1 + v2 callbacks). |
| [`@bot-wa/gohighlevel`](packages/gohighlevel-provider) | Experimental | GoHighLevel / LeadConnector (Conversations API + signed `InboundMessage` webhooks). |
| [`@bot-wa/email`](packages/email-provider) | Experimental | Email: inbound IMAP IDLE + outbound SMTP, threading, loop and bounce protection. |
| [`@bot-wa/tiktok`](packages/tiktok-provider) | Experimental | TikTok API for Business: DMs (Business Messaging) and replies to comments on your own videos. |
| **Stores (persistence)** | | |
| [`@bot-wa/sqlite-store`](packages/sqlite-store) | Alpha | SQLite (`better-sqlite3`, WAL). |
| [`@bot-wa/redis-store`](packages/redis-store) | Alpha | Distributed Redis (+ multi-replica lock). |
| [`@bot-wa/mongo-store`](packages/mongo-store) | Experimental | MongoDB. |
| [`@bot-wa/postgres-store`](packages/postgres-store) | Experimental | PostgreSQL (`pg`). |
| [`@bot-wa/mysql-store`](packages/mysql-store) | Experimental | MySQL/MariaDB (`mysql2`). |
| **Plugins** | | |
| [`@bot-wa/ai`](packages/ai) | Alpha | AI: Anthropic/OpenAI/Ollama/Gemini + 9 OpenAI-compatible presets (DeepSeek/Qwen/GLM/Kimi/Groq/…), auto-reply, tool calling with confirmation, per-user long-term memory and RAG. See the [WhatsApp AI policy](docs/guide/ai.md#whatsapp-ai-policy-since-2026-01-15). |
| [`@bot-wa/nlu`](packages/nlu) | Experimental | Local intents/NLU (define/match + `whenIntent`), no external services. |
| [`@bot-wa/manager`](packages/manager) | Experimental | Multi-bot orchestrator (registry, lifecycle) + dependency-free HTTP API (control plane `/v1` with API keys). |
| [`@bot-wa/otel`](packages/otel) | Experimental | OpenTelemetry: bot traces (inbound, dispatch, conversations, sends, AI) and `bot.metrics()` as OTel metrics. `@opentelemetry/api` as an optional peer. |
| [`@bot-wa/events`](packages/events) | Experimental | Versioned envelopes, idempotent journal, retries and DLQ for asynchronous processes. |
| [`@bot-wa/rag`](packages/rag) | Experimental | RAG for `@bot-wa/ai`: loaders, chunking, pluggable embeddings (OpenAI-compatible, Ollama, local hashing) and an in-memory vector index with optional JSON persistence. |
| [`@bot-wa/voice`](packages/voice) | Experimental | Voice: voice-note transcription (OpenAI-compatible, Deepgram) and spoken replies (OpenAI, ElevenLabs). |
| [`@bot-wa/chatwoot`](packages/chatwoot) | Experimental | Chatwoot bridge: two-way sync and human handoff driven by Chatwoot agents. |
| [`@bot-wa/tickets`](packages/tickets) | Experimental | Support tickets and queues (`ctx.tools.tickets`): queue position, business hours and store persistence. |
| [`@bot-wa/moderation`](packages/moderation) | Experimental | Group moderation: anti-spam, word/regex and invite-link filters, warn/mute/kick/delete actions. |
| [`@bot-wa/dialogflow`](packages/dialogflow) | Experimental | Dialogflow ES/CX: `detectIntent` over REST (service-account JWT, no Google SDK) and intent routing to flows. |
| **Shared infrastructure** (dependencies of the Alpha packages) | | |
| [`@bot-wa/http`](packages/http) | Alpha | Safe HTTP client: anti-SSRF, redirect validation, timeouts and download limits. |
| [`@bot-wa/graph-core`](packages/graph-core) | Alpha | Shared Meta Graph helpers (webhook verification, error mapping, ingest guard) used by meta/messenger/instagram. |
| [`@bot-wa/wa-gateway-kit`](packages/wa-gateway-kit) | Internal | Code shared by the WhatsApp REST gateways (`evolution`, `wppconnect`): REST client over `secureFetch`, outbound media resolution and LID/PN identity reconciliation. Private; not installed directly. |
| [`@bot-wa/server`](packages/server) | Experimental | Webhook ingress for the providers: raw body, size limits, timeouts, concurrency and health endpoints for `node:http`, Express, Fastify and Hono (no dependencies). |
| **Product / operations** (private, persistent) | | |
| [`@bot-wa/inbox`](packages/inbox) | Product | Persistent omni-channel inbox: CAS assignment, handoff, notes, unread, SLA and ledger projection (`attachInbox`). |
| [`@bot-wa/crm`](packages/crm) | Product | Contacts, tags, attributes, consent (lossless CAS) and per-tenant segments. |
| [`@bot-wa/hub`](packages/hub) | Product | Per-tenant plugin registry: validated manifests and permission-gated enabling. It does not run or sandbox code. |
| [`@bot-wa/campaigns`](packages/campaigns) | Product | Consent-aware campaigns: durable per-recipient reservations (TTL), atomic settlement and `sendCampaign()` over `bot.broadcast()`. |
| [`@bot-wa/deployments`](packages/deployments) | Product | Immutable versions, active version, gate reservations, rollback and audited gate runs (including the golden-transcript gate). |
| [`@bot-wa/tenant-kv`](packages/tenant-kv) | Internal | Per-tenant JSON documents with compare-and-set over any `DurableKv`: the base of the product packages. |
| [`@bot-wa/flow-schema`](packages/flow-schema) | Internal | Versioned JSON schema for code-free flows, safe expressions, compilation to `CompiledFlow`, reverse export, migrations and deployment helpers. |
| **Tooling** | | |
| [`create-bot-wa`](packages/create-bot-wa) | Alpha | CLI scaffolder (`npm create bot-wa`), 10 templates: `baileys`, `meta`, `telegram`, `ai` and the use-case ones `games`, `support`, `store`, `restaurant`, `clinic`, `ai-full`. Every project ships an `AGENTS.md` for coding agents. |
| [`eslint-plugin-bot-wa`](packages/eslint-plugin) | Experimental | ESLint rules for bots: v1 API leftovers, blocking `runtime.enter`, async `install`, empty triggers, `ask` without timeout and per-user global state. |
| [`@bot-wa/mcp`](packages/mcp) | Experimental | Stdio MCP server (no dependencies) for agents: validates, compiles, renders, lints, migrates and diffs JSON flow documents without starting a bot; with `--docs` it searches these guides. |

Start with the [core README](packages/core/README.md) for the quickstart.

## Installation (as a user)

> **Alpha — first npm publish pending.** No `@bot-wa/*` package is on npm yet. The commands below are the ones that will work once the first alpha ships; until then, clone the repo and use the packages from the workspace (see [Development](#development-in-this-repo)). Only the **Alpha** packages in the table above go out in that first batch.

```bash
pnpm add @bot-wa/core@alpha @bot-wa/baileys@alpha   # WhatsApp bot (Baileys)
# or @bot-wa/core@alpha @bot-wa/meta@alpha          # official WhatsApp bot (Cloud API)
pnpm add @bot-wa/ai@alpha @anthropic-ai/sdk         # + AI (optional; install the SDK of the provider you use)
```

The **`@alpha` tag is mandatory** while the alpha is the only published series: `changeset publish` in
prerelease mode creates the `alpha` dist-tag, not `latest`, so `pnpm add @bot-wa/core` without a tag will not
resolve. Once a stable version ships the tag can be dropped (see [prerelease mode](CONTRIBUTING.md#modo-prerelease-alpha)).

Requires **Node >= 22**. Every package is **ESM-only**.

> **AI on WhatsApp:** since 2026-01-15 the WhatsApp Business Platform terms forbid general-purpose AI assistants (open ChatGPT-style chatbots). AI in the service of the business (support, sales, bookings) is allowed. Details in the [AI plugin guide](docs/guide/ai.md#whatsapp-ai-policy-since-2026-01-15).

## Development (in this repo)

```bash
pnpm install            # install the whole workspace
pnpm build              # pnpm -r build  → compiles every package
pnpm test               # pnpm -r test   → full suite
pnpm run docs           # TypeDoc + VitePress → documentation site
```

Per package: `pnpm --filter @bot-wa/ai test`, `pnpm --filter @bot-wa/core build`, and so on.

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
