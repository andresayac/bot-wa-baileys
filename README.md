# bot-wa-baileys — monorepo

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE.md)

Framework moderno para bots de WhatsApp sobre [Baileys 7](https://github.com/WhiskeySockets/Baileys): flows declarativos para empezar en 30 segundos, un runtime de conversaciones async para control total, y un plugin de IA multi-proveedor. Este repositorio es un **monorepo pnpm** con dos paquetes publicables.

## Paquetes

| Paquete | Ruta | Descripción |
| --- | --- | --- |
| [`@bot-wa/bot-wa-baileys`](packages/core) | `packages/core` | El core: `Bot`, dispatcher, flows/conversaciones, hooks, plugins, sub-APIs, store, testing kit. |
| [`@bot-wa/ai`](packages/ai) | `packages/ai` | Plugin de IA oficial: proveedores Anthropic/OpenAI/Ollama, context manager por chat, autorespuesta. |

Empieza por el [README del core](packages/core/README.md) para el quickstart.

## Instalación (como usuario)

```bash
pnpm add @bot-wa/bot-wa-baileys              # el bot
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
