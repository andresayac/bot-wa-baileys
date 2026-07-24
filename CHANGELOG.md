# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/). Versionado por paquete. Todo el trabajo actual es **pre-release** (nada publicado en npm todavía).

## [Unreleased]

### Repositorio
- **Reorganizado a monorepo pnpm transporte-agnóstico.** El core dejó de ser específico de WhatsApp: `@bot-wa/bot-wa-baileys` pasó a **`@bot-wa/core`** (motor con `IProvider v2`, cero concepto de transporte). WhatsApp/Baileys vive ahora en `@bot-wa/baileys`.
- **17 paquetes**: core; transportes (`baileys`, `meta`, `messenger`, `instagram`, `telegram`, `discord`); stores (`sqlite-store`, `redis-store`, `mongo-store`, `postgres-store`, `mysql-store`); helpers compartidos (`graph-core`); tooling (`ai`, `nlu`, `manager`, `create-bot-wa`).
- **`@bot-wa/graph-core`**: helpers Meta Graph compartidos (verificación de webhook, mapeo de errores, guard de ingest) usados por meta/messenger/instagram — elimina la triplicación previa.
- CI en GitHub Actions: `build` + `test` en Node 22 y 24 por PR.
- Docs VitePress + TypeDoc desde la raíz (`pnpm docs`). Paquetes compilados con TypeScript 7 (native port); TypeDoc corre con TS 5.9 en la raíz.

### Seguridad (endurecimiento 2026-07-23)
- **`@bot-wa/manager`**: la API HTTP admite autenticación por token (`createManagerApi(m, { auth: { token } })`) con comparación timing-safe; sin token, avisa que el plano de control queda sin autenticar.
- **`@bot-wa/telegram`**: modo webhook verifica el header `X-Telegram-Bot-Api-Secret-Token` (`webhookSecret`); rechaza updates forjados con 401.
- **Graph (meta/messenger/instagram)**: aviso en construcción cuando falta `appSecret` (webhook sin verificar); guard del footgun de re-serialización (la firma debe computarse sobre los bytes crudos).

### Robustez / correctness (2026-07-23)
- **Baileys**: una reconexión cuyo `start()` falla (p. ej. blip de red en `fetchLatestBaileysVersion`) ahora reprograma con backoff en vez de morir para siempre; `send()` mapea errores a `ProviderError` tipados.
- **`@bot-wa/ai`**: timeout por llamada (`timeoutMs`, default 60s) + `AbortSignal` cableado de verdad en OpenAI/Anthropic/Gemini — un proveedor colgado ya no bloquea la cola FIFO del chat.
- **Messenger**: descarta los ecos propios (`is_echo`), consistente con Instagram.
- **Telegram**: backoff exponencial con tope en el long-poll.
- **Stores**: `deleteChat` purga el log de mensajes en todos los stores (consistente con `MemoryStore`); `saveMessage`/`deleteMessage`/`deleteChat` de Redis son atómicos (MULTI); `upsertChat`/`upsertContact` hacen merge superficial en todos; `maxMessagesPerChat` opt-in en los stores persistentes; `MemoryStore.persist` es atómico (tmp+rename) y serializado.
- Suite de conformidad de `IStore` compartida (mismas aserciones contra los 6 stores).
- `ConversationRuntime`: un `wait()` con filtro ahora escanea el inbox (no pierde un mensaje ya encolado que cumple el filtro).

---

## @bot-wa/ai

### [0.1.0] — Unreleased
- Plugin de IA oficial. `aiPlugin({ provider, model, persona, ... })`: autorespuesta a mensajes no-manejados + `ctx.tools.ai` (`ask`/`generate`/`stream`).
- Proveedores nativos: **Anthropic** (default `claude-opus-4-8`), **OpenAI**, **Ollama**, **Gemini** (`@google/generative-ai`) — tras la interfaz `AIProvider`, SDKs como peer deps opcionales con carga lazy.
- **9 presets OpenAI-compatibles** (DeepSeek, Qwen, GLM, Kimi, Groq, OpenRouter, Mistral, Grok, Together) vía el SDK `openai` apuntado al endpoint de cada vendor — sin dependencias extra.
- `ContextManager` por chat respaldado por el `IStore` del core, ventana acotada (default 20). `MockAIProvider` para tests sin red. Resolución de proveedor perezosa (`install` síncrono; una mala config se loguea al arranque, no crashea). Timeout + aborto por llamada.

---

## @bot-wa/core

### [2.0.0-alpha.1] — Unreleased
Rewrite del core, ahora transporte-agnóstico (ver [guía de migración](docs/MIGRATION-v1-to-v2.md)).

**Añadido**
- `Bot` con dispatcher por prioridad (comandos → conversación activa → matchers por especificidad → catch-all), consumo-por-defecto con `ctx.pass()`, cola FIFO por chat.
- Runtime de conversaciones async (`bot.conversation`, `c.ask/waitText/waitMedia/choose`) + DSL `flow()` que compila a él (`say/ask/do/choose/media/timeout/persistent`).
- Contrato `IProvider v2` transporte-agnóstico: identidad opaca, errores tipados de dominio (`RateLimitedError`, `OutsideSessionWindowError`, …), media lazy, `ingest()` para transportes push (webhook).
- Persistencia de flows `.persistent()` vía checkpoints en el store. `IStore` genérico + `MemoryStore` (con dump/load a JSON, mensajes no persistidos).
- Sistema de hooks (`before/after/onError`, evento `send`), plugins con `unplug`, DI (`bot.provide`), scheduler, validación de config en runtime, group mode, graceful shutdown con drain.
- Testing kit (`createTestBot`, `MockProvider`) en `@bot-wa/core/testing`.

**Cambios de comportamiento vs v1**
- Matching por defecto = `equals` normalizado (no `contains`).
- El evento `message` dispara para todo mensaje procesado; `onMessage()` es el catch-all.
- Conversaciones por-participante en grupos (`conversationScope: 'chat'` para modo v1).
- Conceptos de WhatsApp (JID/LID/PN, QR, sub-APIs de grupos/perfil) movidos fuera del core al provider correspondiente.

---

## @bot-wa/baileys

### [0.1.0] — Unreleased
- Transporte WhatsApp sobre Baileys 7 (`@whiskeysockets/baileys` fijado en `7.0.0-rc13`). Implementa `IProvider v2`.
- Capa de identidad LID/PN (Baileys 7), render de QR (terminal + PNG), login por pairing code.
- **Rate limiter anti-ban**: token bucket por chat y global, cola FIFO (no descarta mensajes), jitter human-like opcional.
- Política de reconexión: `conflict/replaced` (440) y `forbidden` (403) no reconectan en loop; `restartRequired` (515) reconecta ya; resto con backoff exponencial con tope; un `start()` fallido durante reconexión reprograma con backoff.
