# bot-wa-baileys — monorepo

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE.md)

Framework moderno y **agnóstico de transporte** para bots de mensajería: flows declarativos para empezar en 30 segundos, un runtime de conversaciones async para control total, y un plugin de IA multi-proveedor. Dos transportes de WhatsApp —[Baileys 7](https://github.com/WhiskeySockets/Baileys) (no oficial) y la **Cloud API oficial de Meta**— detrás del mismo `IProvider`. **Monorepo pnpm** con paquetes publicables.

## Paquetes

| Paquete | Descripción |
| --- | --- |
| **Core** | |
| [`@bot-wa/core`](packages/core) | Motor agnóstico de transporte: `Bot`, `IProvider v2`, dispatcher, flows/conversaciones, hooks, plugins, store, testing kit. |
| **Transports (canales)** | |
| [`@bot-wa/baileys`](packages/baileys-provider) | WhatsApp vía Baileys 7 (no oficial, QR). |
| [`@bot-wa/meta`](packages/meta-provider) | WhatsApp Cloud API **oficial** (webhook, sin baneo, botones/listas/templates nativos). |
| [`@bot-wa/messenger`](packages/messenger-provider) | Facebook Messenger (Meta Graph, quick replies/templates). |
| [`@bot-wa/instagram`](packages/instagram-provider) | Instagram DM (Meta Graph, quick replies). |
| [`@bot-wa/telegram`](packages/telegram-provider) | Telegram Bot API (long-poll/webhook, teclados inline, polls nativos). |
| [`@bot-wa/discord`](packages/discord-provider) | Discord (gateway websocket + REST, slash/components). |
| **Stores (persistencia)** | |
| [`@bot-wa/sqlite-store`](packages/sqlite-store) | SQLite (`better-sqlite3`). |
| [`@bot-wa/redis-store`](packages/redis-store) | Redis distribuido (+ lock multi-réplica). |
| [`@bot-wa/mongo-store`](packages/mongo-store) | MongoDB. |
| [`@bot-wa/postgres-store`](packages/postgres-store) | PostgreSQL (`pg`). |
| [`@bot-wa/mysql-store`](packages/mysql-store) | MySQL (`mysql2`). |
| **Plugins & tooling** | |
| [`@bot-wa/ai`](packages/ai) | IA: Anthropic/OpenAI/Ollama/Gemini + 9 presets OpenAI-compatible (DeepSeek/Qwen/GLM/Kimi/Groq/…), autorespuesta. |
| [`@bot-wa/nlu`](packages/nlu) | Intenciones/NLU local (define/match + `whenIntent`), sin servicios externos. |
| [`@bot-wa/manager`](packages/manager) | Multi-bot orchestrator (registry, lifecycle) + HTTP API zero-dep (auth por token). |
| [`@bot-wa/graph-core`](packages/graph-core) | Helpers Meta Graph compartidos (verificación de webhook, mapeo de errores, guard de ingest) usados por meta/messenger/instagram. |
| [`create-bot-wa`](packages/create-bot-wa) | CLI scaffolder (`npm create bot-wa`), 4 templates. |

Empieza por el [README del core](packages/core/README.md) para el quickstart.

## Instalación (como usuario)

```bash
pnpm add @bot-wa/core @bot-wa/baileys        # bot WhatsApp (Baileys)
# o @bot-wa/core @bot-wa/meta                # bot WhatsApp oficial (Cloud API)
pnpm add @bot-wa/ai @anthropic-ai/sdk        # + IA (opcional; instala el SDK del proveedor que uses)
```

Requiere **Node >= 20**. Todos los paquetes son **ESM-only**.

## Desarrollo (en este repo)

```bash
pnpm install            # instala todo el workspace
pnpm build              # pnpm -r build  → compila todos los paquetes
pnpm test               # pnpm -r test   → suite completa
pnpm docs               # vitepress build docs → sitio de documentación
```

Por paquete: `pnpm --filter @bot-wa/ai test`, `pnpm --filter @bot-wa/core build`, etc.

## Documentación

- Sitio: [andresayac.github.io/bot-wa-baileys](https://andresayac.github.io/bot-wa-baileys/) (fuente en [`docs/`](docs)).
- Guía de migración v1 → v2: [`docs/MIGRATION-v1-to-v2.md`](docs/MIGRATION-v1-to-v2.md).
- Plan estratégico de producto e ingeniería: [`ROADMAP.md`](ROADMAP.md).
- Catálogo detallado de propuestas: [`FEATURES.md`](FEATURES.md).
- Política de reporte de vulnerabilidades: [`SECURITY.md`](SECURITY.md).
- Diseño y decisiones: [`docs/superpowers/specs/`](docs/superpowers/specs) y [`docs/superpowers/plans/`](docs/superpowers/plans).

## Contribuir

Ver [`CONTRIBUTING.md`](CONTRIBUTING.md). Cambios relevantes en [`CHANGELOG.md`](CHANGELOG.md).

## Licencia

MIT © Andres Aya
