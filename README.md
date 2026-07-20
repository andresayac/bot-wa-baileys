# bot-wa-baileys — monorepo

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE.md)

Framework moderno y **agnóstico de transporte** para bots de mensajería: flows declarativos para empezar en 30 segundos, un runtime de conversaciones async para control total, y un plugin de IA multi-proveedor. Dos transportes de WhatsApp —[Baileys 7](https://github.com/WhiskeySockets/Baileys) (no oficial) y la **Cloud API oficial de Meta**— detrás del mismo `IProvider`. **Monorepo pnpm** con paquetes publicables.

## Paquetes

| Paquete | Ruta | Descripción |
| --- | --- | --- |
| [`@bot-wa/core`](packages/core) | `packages/core` | Motor agnóstico de transporte: `Bot`, `IProvider v2`, dispatcher, flows/conversaciones, hooks, plugins, store, testing kit. |
| [`@bot-wa/baileys`](packages/baileys-provider) | `packages/baileys-provider` | Transporte WhatsApp vía Baileys 7 (no oficial, QR). |
| [`@bot-wa/meta`](packages/meta-provider) | `packages/meta-provider` | Transporte WhatsApp Cloud API **oficial** (webhook, sin baneo, botones/listas/templates nativos). |
| [`@bot-wa/sqlite-store`](packages/sqlite-store) | `packages/sqlite-store` | Store persistente SQLite (`better-sqlite3`). |
| [`@bot-wa/ai`](packages/ai) | `packages/ai` | Plugin de IA: Anthropic/OpenAI/Ollama/Gemini + 9 presets OpenAI-compatible (DeepSeek/Qwen/GLM/Kimi/Groq/…), autorespuesta. |

Empieza por el [README del core](packages/core/README.md) para el quickstart.

## Instalación (como usuario)

```bash
pnpm add @bot-wa/core @bot-wa/baileys        # bot WhatsApp (Baileys)
# o @bot-wa/core @bot-wa/meta                # bot WhatsApp oficial (Cloud API)
pnpm add @bot-wa/ai @anthropic-ai/sdk        # + IA (opcional; instala el SDK del proveedor que uses)
```

Requiere **Node >= 20**. Ambos paquetes son **ESM-only**.

## Desarrollo (en este repo)

```bash
pnpm install            # instala todo el workspace
pnpm build              # pnpm -r build  → compila core y ai
pnpm test               # pnpm -r test   → suite completa (core + ai)
pnpm docs               # vitepress build docs → sitio de documentación
```

Por paquete: `pnpm --filter @bot-wa/ai test`, `pnpm --filter @bot-wa/bot-wa-baileys build`, etc.

## Documentación

- Sitio: [andresayac.github.io/bot-wa-baileys](https://andresayac.github.io/bot-wa-baileys/) (fuente en [`docs/`](docs)).
- Guía de migración v1 → v2: [`docs/MIGRATION-v1-to-v2.md`](docs/MIGRATION-v1-to-v2.md).
- Diseño y decisiones: [`docs/superpowers/specs/`](docs/superpowers/specs) y [`docs/superpowers/plans/`](docs/superpowers/plans).

## Contribuir

Ver [`CONTRIBUTING.md`](CONTRIBUTING.md). Cambios relevantes en [`CHANGELOG.md`](CHANGELOG.md).

## Licencia

MIT © Andres Aya
