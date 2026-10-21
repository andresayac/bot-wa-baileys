# botmesh — monorepo

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE.md)

A modern, **transport-agnostic** framework for messaging bots: declarative flows to get going in 30 seconds, an async conversation runtime when you need full control, and a multi-provider AI plugin. Two WhatsApp transports —[Baileys 7](https://github.com/WhiskeySockets/Baileys) (unofficial) and the **official Meta Cloud API**— behind the same `IProvider`, plus Telegram and experimental channels (Messenger, Instagram, Discord, TikTok, email, and WhatsApp through Evolution API, WPPConnect, Twilio or Gupshup). **pnpm monorepo** in **alpha**: the packages are on npm under the `alpha` dist-tag (`pnpm add @botmesh/core@alpha`).

## Packages

The monorepo has **44 packages**: 10 **Alpha** (publishable), 26 **Experimental** and 8 **Product** and infrastructure ones. They are not all equally mature, and the **Status** column says so plainly:

- **Alpha**: published on npm under the **`alpha` dist-tag** (install with `@alpha`; there is no `latest` yet).
- **Experimental**: real, tested implementation, but the package is `private`. Not published yet and its API may change.
- **Product / internal**: real, persistent implementation (`private`) over any core `DurableKv`. Per-tenant isolation and compare-and-set in the backend; the API may change until the alpha ships.

| Package | Status | Description |
| --- | --- | --- |
| **Core** | | |
| [`@botmesh/core`](packages/core) | Alpha | Transport-agnostic engine: `Bot`, `IProvider v2`, dispatcher, flows/conversations, hooks, plugins, store, testing kit. |
| **Transports (channels)** | | |
| [`@botmesh/baileys`](packages/baileys-provider) | Alpha | WhatsApp through Baileys 7 (unofficial, QR or pairing code). |
| [`@botmesh/meta`](packages/meta-provider) | Alpha | **Official** WhatsApp Cloud API (webhook, no ban risk, native buttons/lists/templates). |
| [`@botmesh/telegram`](packages/telegram-provider) | Alpha | Telegram Bot API (long-poll/webhook, inline keyboards, native polls). |
| [`@botmesh/messenger`](packages/messenger-provider) | Experimental | Facebook Messenger (Meta Graph, quick replies/templates). |
| [`@botmesh/instagram`](packages/instagram-provider) | Experimental | Instagram DM (Meta Graph, quick replies). |
| [`@botmesh/discord`](packages/discord-provider) | Experimental | Discord (gateway websocket + REST, slash/components). |
| [`@botmesh/evolution`](packages/evolution-provider) | Experimental | WhatsApp through [Evolution API](https://github.com/EvolutionAPI/evolution-api) (self-hosted REST gateway, signed webhook). |
| [`@botmesh/wppconnect`](packages/wppconnect-provider) | Experimental | WhatsApp through WPPConnect Server (REST + token webhook). |
| [`@botmesh/twilio`](packages/twilio-provider) | Experimental | WhatsApp and SMS through Twilio Programmable Messaging (`X-Twilio-Signature` webhooks). |
| [`@botmesh/gupshup`](packages/gupshup-provider) | Experimental | WhatsApp through Gupshup (API v1 + v2 callbacks). |
| [`@botmesh/gohighlevel`](packages/gohighlevel-provider) | Experimental | GoHighLevel / LeadConnector (Conversations API + signed `InboundMessage` webhooks). |
| [`@botmesh/email`](packages/email-provider) | Experimental | Email: inbound IMAP IDLE + outbound SMTP, threading, loop and bounce protection. |
| [`@botmesh/tiktok`](packages/tiktok-provider) | Experimental | TikTok API for Business: DMs (Business Messaging) and replies to comments on your own videos. |
| **Stores (persistence)** | | |
| [`@botmesh/sqlite-store`](packages/sqlite-store) | Alpha | SQLite (`better-sqlite3`, WAL). |
| [`@botmesh/redis-store`](packages/redis-store) | Alpha | Distributed Redis (+ multi-replica lock). |
| [`@botmesh/mongo-store`](packages/mongo-store) | Experimental | MongoDB. |
| [`@botmesh/postgres-store`](packages/postgres-store) | Experimental | PostgreSQL (`pg`). |
| [`@botmesh/mysql-store`](packages/mysql-store) | Experimental | MySQL/MariaDB (`mysql2`). |
| **Plugins** | | |
| [`@botmesh/ai`](packages/ai) | Alpha | AI: Anthropic/OpenAI/Ollama/Gemini + 9 OpenAI-compatible presets (DeepSeek/Qwen/GLM/Kimi/Groq/…), auto-reply, tool calling with confirmation, per-user long-term memory and RAG. See the [WhatsApp AI policy](docs/guide/ai.md#whatsapp-ai-policy-since-2026-01-15). |
| [`@botmesh/nlu`](packages/nlu) | Experimental | Local intents/NLU (define/match + `whenIntent`), no external services. |
| [`@botmesh/manager`](packages/manager) | Experimental | Multi-bot orchestrator (registry, lifecycle) + dependency-free HTTP API (control plane `/v1` with API keys). |
| [`@botmesh/otel`](packages/otel) | Experimental | OpenTelemetry: bot traces (inbound, dispatch, conversations, sends, AI) and `bot.metrics()` as OTel metrics. `@opentelemetry/api` as an optional peer. |
| [`@botmesh/events`](packages/events) | Experimental | Versioned envelopes, idempotent journal, retries and DLQ for asynchronous processes. |
| [`@botmesh/rag`](packages/rag) | Experimental | RAG for `@botmesh/ai`: loaders, chunking, pluggable embeddings (OpenAI-compatible, Ollama, local hashing) and an in-memory vector index with optional JSON persistence. |
| [`@botmesh/voice`](packages/voice) | Experimental | Voice: voice-note transcription (OpenAI-compatible, Deepgram) and spoken replies (OpenAI, ElevenLabs). |
| [`@botmesh/chatwoot`](packages/chatwoot) | Experimental | Chatwoot bridge: two-way sync and human handoff driven by Chatwoot agents. |
| [`@botmesh/tickets`](packages/tickets) | Experimental | Support tickets and queues (`ctx.tools.tickets`): queue position, business hours and store persistence. |
| [`@botmesh/moderation`](packages/moderation) | Experimental | Group moderation: anti-spam, word/regex and invite-link filters, warn/mute/kick/delete actions. |
| [`@botmesh/dialogflow`](packages/dialogflow) | Experimental | Dialogflow ES/CX: `detectIntent` over REST (service-account JWT, no Google SDK) and intent routing to flows. |
| **Shared infrastructure** (dependencies of the Alpha packages) | | |
| [`@botmesh/http`](packages/http) | Alpha | Safe HTTP client: anti-SSRF, redirect validation, timeouts and download limits. |
| [`@botmesh/graph-core`](packages/graph-core) | Alpha | Shared Meta Graph helpers (webhook verification, error mapping, ingest guard) used by meta/messenger/instagram. |
| [`@botmesh/wa-gateway-kit`](packages/wa-gateway-kit) | Internal | Code shared by the WhatsApp REST gateways (`evolution`, `wppconnect`): REST client over `secureFetch`, outbound media resolution and LID/PN identity reconciliation. Private; not installed directly. |
| [`@botmesh/server`](packages/server) | Experimental | Webhook ingress for the providers: raw body, size limits, timeouts, concurrency and health endpoints for `node:http`, Express, Fastify and Hono (no dependencies). |
| **Product / operations** (private, persistent) | | |
| [`@botmesh/inbox`](packages/inbox) | Product | Persistent omni-channel inbox: CAS assignment, handoff, notes, unread, SLA and ledger projection (`attachInbox`). |
| [`@botmesh/crm`](packages/crm) | Product | Contacts, tags, attributes, consent (lossless CAS) and per-tenant segments. |
| [`@botmesh/hub`](packages/hub) | Product | Per-tenant plugin registry: validated manifests and permission-gated enabling. It does not run or sandbox code. |
| [`@botmesh/campaigns`](packages/campaigns) | Product | Consent-aware campaigns: durable per-recipient reservations (TTL), atomic settlement and `sendCampaign()` over `bot.broadcast()`. |
| [`@botmesh/deployments`](packages/deployments) | Product | Immutable versions, active version, gate reservations, rollback and audited gate runs (including the golden-transcript gate). |
| [`@botmesh/tenant-kv`](packages/tenant-kv) | Internal | Per-tenant JSON documents with compare-and-set over any `DurableKv`: the base of the product packages. |
| [`@botmesh/flow-schema`](packages/flow-schema) | Internal | Versioned JSON schema for code-free flows, safe expressions, compilation to `CompiledFlow`, reverse export, migrations and deployment helpers. |
| **Tooling** | | |
| [`create-botmesh`](packages/create-botmesh) | Alpha | CLI scaffolder (`npm create botmesh`), 10 templates: `baileys`, `meta`, `telegram`, `ai` and the use-case ones `games`, `support`, `store`, `restaurant`, `clinic`, `ai-full`. Every project ships an `AGENTS.md` for coding agents. |
| [`eslint-plugin-botmesh`](packages/eslint-plugin) | Experimental | ESLint rules for bots: v1 API leftovers, blocking `runtime.enter`, async `install`, empty triggers, `ask` without timeout and per-user global state. |
| [`@botmesh/mcp`](packages/mcp) | Experimental | Stdio MCP server (no dependencies) for agents: validates, compiles, renders, lints, migrates and diffs JSON flow documents without starting a bot; with `--docs` it searches these guides. |

Start with the [core README](packages/core/README.md) for the quickstart.

## Installation (as a user)

> **Alpha — published under the `alpha` dist-tag.** The packages below are on npm, but `changeset publish` does not create a `latest` tag, so the commands use `@alpha`. Only the **Alpha** packages in the table above are published; the rest are private.

```bash
pnpm add @botmesh/core@alpha @botmesh/baileys@alpha   # WhatsApp bot (Baileys)
# or @botmesh/core@alpha @botmesh/meta@alpha          # official WhatsApp bot (Cloud API)
pnpm add @botmesh/ai@alpha @anthropic-ai/sdk         # + AI (optional; install the SDK of the provider you use)
```

The **`@alpha` tag is mandatory** while the alpha is the only published series: `changeset publish` in
prerelease mode creates the `alpha` dist-tag, not `latest`, so `pnpm add @botmesh/core` without a tag will not
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

Per package: `pnpm --filter @botmesh/ai test`, `pnpm --filter @botmesh/core build`, and so on.

## Examples

| Example | What it shows |
| --- | --- |
| [`examples/bakery-ai`](examples/bakery-ai) | AI ordering assistant for a bakery (in English) on WhatsApp, through Baileys (QR) or Twilio (webhook with `@botmesh/server`). Tools with confirmation, totals computed in code, `dedupe`, an access list, typed configuration and tests with no network. |

They build and test with the rest of the workspace (`pnpm build`, `pnpm test`). Each example ships its own README with the commands to run it.

## Documentation

- Guides: [`docs/`](docs) (English in `docs/guide/`, Spanish in `docs/es/guide/`). There is no published site; to read them as a website locally: `pnpm docs:dev`.
- Migration guide v1 → v2: [`docs/MIGRATION-v1-to-v2.md`](docs/MIGRATION-v1-to-v2.md).
- Product and engineering roadmap: [`ROADMAP.md`](ROADMAP.md).
- Detailed catalogue of proposals: [`FEATURES.md`](FEATURES.md).
- Vulnerability reporting policy: [`SECURITY.md`](SECURITY.md).
- Design and decisions: [`docs/superpowers/specs/`](docs/superpowers/specs) and [`docs/superpowers/plans/`](docs/superpowers/plans).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Relevant changes go in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT © Andres Aya
