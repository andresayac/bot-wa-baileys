# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/). Versionado por paquete.

## [Unreleased]

### Repositorio
- Convertido a **monorepo pnpm** (`packages/core` + `packages/ai`). El core (`@bot-wa/bot-wa-baileys`) se movió a `packages/core` sin cambios de API.
- CI en GitHub Actions: `build` + `test` en Node 20 y 22 por PR.
- Pipeline de docs re-cableado desde la raíz: `pnpm docs` (TypeDoc + VitePress), `pnpm docs:dev`. Limpieza de artefactos huérfanos (`lib/` raíz, `.npmignore`).
- `CONTRIBUTING.md` y este `CHANGELOG.md`.

---

## @bot-wa/ai

### [0.1.0] — Unreleased
- Plugin de IA oficial. `aiPlugin({ provider, model, persona, ... })` autorespuesta a mensajes no-manejados + `ctx.tools.ai` (`ask`/`generate`/`stream`) para flows y conversaciones.
- Proveedores: **Anthropic** (`@anthropic-ai/sdk`, default `claude-opus-4-8`), **OpenAI**, **Ollama** — tras la interfaz `AIProvider`, SDKs como peer deps opcionales con carga lazy.
- `ContextManager` por chat respaldado por el `IStore` del core, ventana acotada (default 20 mensajes).
- `MockAIProvider` para tests sin red. Resolución de proveedor perezosa (`install` síncrono; una mala config se loguea al arranque, no crashea).

---

## @bot-wa/bot-wa-baileys

### [2.0.0-alpha.1] — Unreleased
Rewrite del core sobre Baileys 7 (ver [guía de migración](docs/MIGRATION-v1-to-v2.md)).

**Añadido**
- `Bot` con dispatcher por prioridad (comandos → conversación activa → matchers por especificidad → catch-all), consumo-por-defecto con `ctx.pass()`, cola FIFO por chat.
- Runtime de conversaciones async (`bot.conversation`, `c.ask/waitText/waitMedia/choose`) + DSL `flow()` que compila a él (`say/ask/do/choose/media/timeout/persistent`).
- Persistencia de flows `.persistent()` vía checkpoints en el store.
- Sistema de hooks (`before/after/onError`, evento `send`), plugins con `unplug`, DI (`bot.provide`), scheduler, sub-APIs (groups/profile/privacy/chats/presence).
- Capa de identidad LID/PN (Baileys 7), login por pairing code, testing kit (`createTestBot`, `MockProvider`).
- Migración a **ESM-only** (Node >= 20), `@whiskeysockets/baileys` fijado en `7.0.0-rc13`.
- **Rate limiter anti-ban** (`config.rateLimit`): token bucket por chat y global, cola FIFO (no descarta mensajes), jitter human-like opcional. Integrado en `sendThrough()` — cada mensaje saliente pasa por el limiter automáticamente.
- **SQLiteStore** (`better-sqlite3`): store persistente con WAL mode, migraciones automáticas, índices. Implementa todo `IStore` (mensajes, chats, contactos, flow states, checkpoints, conversaciones AI). `new Bot({ store: new SQLiteStore({ file: './bot.db' }) })`.
- **Validación de config en runtime** (`validateConfig`): el constructor de `Bot` valida tipos y valores, lanza `ConfigValidationError` con mensaje claro (campo + tipo esperado).
- **Group mode** (`config.groupMode`): `'all'` (default), `'mentions'` (solo si mencionan al bot), `'commands'` (solo comandos con prefijo). Detecta el JID del bot automáticamente al conectar.
- **Graceful shutdown con drain** (`bot.stop({ drain: true, timeout: 15_000 })`): espera a que los envíos en vuelo terminen antes de cerrar; limpia el rate limiter.

**Cambios de comportamiento vs v1**
- Matching por defecto = `equals` normalizado (no `contains`).
- El evento `message` dispara para todo mensaje procesado; `onMessage()` es el catch-all.
- Conversaciones por-participante en grupos (`conversationScope: 'chat'` para modo v1).
- Sin botones/listas nativos (muertos en el protocolo WhatsApp Web) → `choose()` o `poll()`.

**Corregido**
- Reconexión: `conflict/replaced` (440) y `forbidden` (403) ya no reconectan en loop; backoff exponencial con tope para cierres transitorios.
- Sin crashes por errores no controlados en el pipeline; conversaciones canceladas se cierran en silencio.
