# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/). Versionado por paquete. Todo el trabajo actual es **pre-release** (nada publicado en npm todavía).

## [Unreleased]

### Repositorio
- **Reorganizado a monorepo pnpm transporte-agnóstico.** El core dejó de ser específico de WhatsApp: `@bot-wa/bot-wa-baileys` pasó a **`@bot-wa/core`** (motor con `IProvider v2`, cero concepto de transporte). WhatsApp/Baileys vive ahora en `@bot-wa/baileys`.
- **24 paquetes**: core; transportes (`baileys`, `meta`, `telegram`, `messenger`, `instagram`, `discord`); stores (`sqlite-store`, `redis-store`, `mongo-store`, `postgres-store`, `mysql-store`); infra compartida (`http`, `graph-core`); plugins (`ai`, `nlu`, `manager`, `events`); producto/operación (`inbox`, `crm`, `hub`, `campaigns`, `deployments`); tooling (`create-bot-wa`).
  - **Primera alpha** (publicables, aún sin publicar en npm): `core`, `baileys`, `meta`, `telegram`, `sqlite-store`, `redis-store`, `ai`, `create-bot-wa`, más sus dependencias `http` y `graph-core`.
  - **Experimentales** (`private`, implementación real, sin publicar): `discord`, `messenger`, `instagram`, `mongo-store`, `postgres-store`, `mysql-store`, `nlu`, `manager`, `events`.
  - **Prototipos** (`private`, mínimos y en memoria): `inbox`, `crm`, `hub`, `campaigns`, `deployments`.
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

### Repositorio, tooling y publicación (2026-10)
- **Solo 10 paquetes públicos**: `core`, `baileys`, `meta`, `telegram`, `sqlite-store`, `redis-store`, `ai`, `http`, `graph-core` y `create-bot-wa`. Los demás (`discord`, `messenger`, `instagram`, `mongo-store`, `postgres-store`, `mysql-store`, `nlu`, `manager`, `events` y los prototipos `inbox`, `crm`, `hub`, `campaigns`, `deployments`) llevan `"private": true` hasta que se promuevan.
- **Changesets v3** (`@changesets/cli`): scripts raíz `pnpm changeset`, `pnpm version-packages` y `pnpm release`; `publishConfig.access: public` en los paquetes publicables. Flujo de publicación **manual**, sin workflow de release (detalles en `CONTRIBUTING.md` y `.changeset/README.md`).
- **Typecheck de tests**: cada paquete tiene `tsconfig.test.json` y un script `typecheck` (`tsc -p tsconfig.test.json`, src + tests); `pnpm typecheck` en la raíz. Tipados los tests de `ai`, `telegram`, `discord`, `messenger` y la suite compartida de stores. No corre en CI: ejecútalo en local.
- **Tests de integración de stores contra servidores reales** (`tests/integration.test.ts` en mongo/postgres/mysql/redis), opt-in con `BOTWA_TEST_MONGO_URL`, `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_MYSQL_URL` y `BOTWA_TEST_REDIS_URL` (Docker en local; CI no los ejecuta).
- Segunda suite compartida para stores, `test-utils/user-data-conformance.ts` (`runUserDataConformance`), para los métodos de `ctx.user`.
- Prototipos (`inbox`, `crm`, `hub`, `campaigns`, `deployments`) reformateados para que se puedan leer y etiquetados como privados. Sin cambios de comportamiento ni de API exportada.
- `AGENTS.md` (guía para agentes de código) y `FEATURES.md` (catálogo de propuestas con su estado).
- **Docs**: guías nuevas en inglés y español de triggers especiales, `ctx.user`, handoff y listas de acceso, `bot-wa dev`, testing (kit de caos) y `describe`/`lint`; el pipeline de entrada completo en Conceptos; votos de encuestas y BSUID en Mensajes; READMEs nuevos o reescritos de `baileys`, `graph-core`, `sqlite-store` y otros paquetes; política de IA de WhatsApp en la guía de IA.

### @bot-wa/core (2026-10)

**Añadido**
- **`ctx.user`, perfil persistente por usuario** (FEATURES #1): `get`/`set`/`update`/`delete`/`all`/`clear` con paths con puntos (`'address.city'`), namespaces (`ctx.user.ns('game')`) y TTL por clave de primer nivel (`{ ttl: '30m' }`, modelo Redis). Indexado por el remitente canónico (`ctx.sender`) y dentro del namespace de store del bot. `bot.user(userId)` fuera de handlers, `userOf(ctx)` en pasos de flujo, `bot.purgeExpiredUserData()`. Escrituras serializadas por usuario en el proceso; `update()` valida todo el lote antes de escribir. Exporta `UserDataService`, `userOf`, `supportsUserData`, `DEFAULT_USER_NAMESPACE`, `UserDataError` (códigos `INVALID_PATH`, `INVALID_NAMESPACE`, `INVALID_VALUE`, `INVALID_TTL`, `INVALID_USER`, `UNSUPPORTED_STORE`, `UNAVAILABLE`) y los tipos `UserData`, `UserSetOptions`, `UserDataEntry`.
- `IStore` gana los métodos **opcionales** `getUserData`, `setUserData`, `deleteUserData`, `listUserData` y `purgeExpiredUserData` (también en `NamespacedStore` cuando el store interno los tiene). `MemoryStore` los implementa y su archivo JSON suma `userData` (los archivos antiguos siguen cargando).
- `bot.exportSubject()` devuelve `userData` y `bot.deleteSubject()` cuenta las entradas borradas en `userData`; el borrado espera a las escrituras en curso del usuario.
- **Handoff humano** (FEATURES #5): `ctx.handoff({ reason, meta })`, `bot.handoff/resume/isHandedOff/getHandoff/listHandoffs` y `bot.sendTo(chatId, string | content)`. Mientras un chat está en handoff los mensajes se persisten, corren los hooks y se emite `'message'`, pero no se enruta nada salvo `BotConfig.handoff.allowCommands`. Al empezar se cancelan en silencio las conversaciones del chat y sus checkpoints dormidos. Eventos `'handoff'` y `'resume'`. Estado persistido en `StoredChat.handoff` y en un índice bajo `HANDOFF_INDEX_KEY`, restaurado en `start()` (`handoff.persist: false` lo deja en memoria). Exporta `validateHandoffConfig` y los tipos `HandoffConfig`, `HandoffOptions`, `ResumeOptions`, `HandoffState`, `HandoffEvent`, `ResumeEvent`, `StoredHandoff`.
- **Blacklist / whitelist dinámicas** (FEATURES #7): `bot.blacklist` y `bot.whitelist` (`AccessList`, `Whitelist`) comparan con igualdad exacta contra `senderId` y `chatId`; gana la blacklist; la whitelist está deshabilitada por defecto. Un mensaje o interacción bloqueado se descarta antes de persistir (sin hooks ni `'message'`, log de debug sin el cuerpo). Persistencia a cargo del host con `onChange()`, `bot.exportAccessLists()` y `bot.loadAccessLists()`. Exporta también `checkAccess`.
- **Triggers especiales** (FEATURES #3): `WELCOME` (primer contacto, por DM y por participante en grupos, persistido con hashes en los cursores del store), `MEDIA`, `IMAGE`, `VIDEO`, `AUDIO`, `VOICE_NOTE`, `DOCUMENT`, `STICKER`, `LOCATION`, `CONTACT`, `POLL`, `CALL`, `typeTrigger(...)`, `isTypeTrigger`, `isWelcomeTrigger`. `bot.resetWelcome(chatId, userId?)` rearma la bienvenida. `CALL` proyecta cada llamada (una vez por id) a un contexto `type: 'call'` con `ctx.call`, por un camino aparte que solo ejecuta triggers de tipo. `MessageType` gana `'call'`; `MockProvider.call()` en `@bot-wa/core/testing`.
- `CallEvent` gana los campos opcionales `chatId`, `isGroup`, `isVideo` y `offline`. Las llamadas de grupo se proyectan al grupo (respuesta al grupo, conversación por participante, se aplican `scope` y `groupMode`).
- **Conversaciones** (FEATURES #2, #8, #15): `c.retry(message?)` repite la última espera (en un `.do()` de un flujo rebobina hasta el `ask`/`choose` anterior; cuenta para `retries`); `c.idle(duration, cb)` / `c.idleClear()` para inactividad dentro de una conversación; `bot.onIdle(duration, handler)` / `bot.clearIdle(chatId?)` para inactividad por chat (se suspende durante un handoff). Nuevos `ConversationRetry`, `RetryUnavailableError`, `ConcurrentWaitError` y los tipos `ConversationHandler`, `IdleCallback`, `IdleHandler`, `IdleEvent`, `ConversationObserver`; `ConversationRuntime.observe/interrupt/reportError`.
- El `ctx` de `bot.conversation(name, async (c, ctx) => ...)` es un `MessageContext` completo tipado por `DefaultTools` (`ConversationHandler<TTools>`); los handlers tipados con `ConversationFn` siguen compilando.
- **Dedupe de entrada**: `BotConfig.dedupe` (`{ size?, ttl? } | false`, activado por defecto con un LRU de 1000) descarta re-entregas con el mismo `chatId` + `ref.id` / `interactionId`. Una edición con otro cuerpo sí se procesa; se guarda solo un hash. Exporta `InboundDeduper`, `createInboundDeduper`, `inboundDedupeKey` y `DEFAULT_DEDUPE_SIZE`. El contrato de ids de entrada queda documentado en `IProvider`.
- **Kit de caos** en `@bot-wa/core/testing`: `ChaosProvider` / `withChaos` (duplicados, reordenación, latencia, fallos de envío tipados, desconexiones con replay, alias de identidad; determinista por `seed`), `ChaosDisconnectedError`, `createSeededRandom`, `cloneInboundEvent` y la sobrecarga `createTestBot(config, { chaos })`.
- **Contrato de identidad** en `@bot-wa/core/testing`: `assertStableIdentity`, `checkIdentityContract`, `recordEvents` e `IdentityContractError`.
- **Introspección de flujos**: `bot.describe()` (Mermaid o `{ format: 'json' }`), `bot.lint()` con 13 reglas (`goto-target-missing`, `unreachable-step`, `duplicate-trigger`, `persistent-memory-store`...), `bot.flowInventory()`, y las funciones `describeFlows`, `lintFlows`, `describeTrigger`. `ConversationRuntime.listRegistrations()` y `MemoryStore#durable`.
- **DSL de flujos** (FEATURES #4, #9, #10, #11, #14): `.use(subFlow)` ejecuta un flujo en línea y vuelve al padre con el estado compartido; las opciones de `choose()` aceptan un flujo en `then` y `goto` para salir a otra conversación (p. ej. volver al menú); `.guard(predicado, mensaje | { redirect, message })`; `schema` compatible con zod (cualquier objeto con `safeParse()`, sin dependencia de zod) en `.ask()`, `c.ask()` y `c.waitText()`, que resuelven con el valor parseado; `.media(kind, fuente, caption?, opts?)` para `image`/`video`/`audio`/`voice`/`document`/`sticker`/`location`; `{ delay }` en say/ask/choose/media y el paso `.delay()`; estado tipado (`flow<S>()`, `FlowStateOf`, `.ask(…, 'key', { schema })` infiere `c.state.key`). `bot.describe()` y `bot.lint()` entienden los pasos nuevos (los `redirect` de `guard` y los `goto` de las opciones se revisan como `goto`). Un delay inválido o mayor de 2^31 − 1 ms lanza al construir el flujo; terminar la conversación o `bot.stop()` cancela un delay pendiente; `c.retry()` en un paso posterior a `.use()` vuelve a ejecutar el sub-flujo.
- **`bot-wa dev`**, simulador de chat en la terminal con recarga en caliente (bin `bot-wa`), soporte de TypeScript con type stripping nativo, `--env-file`, `--user`, `--name`, `--group`, `--watch`. Patrón factory con `defineBot`, `isBotFactory` e `isMainModule` (en `@bot-wa/core` y en el nuevo subpath `@bot-wa/core/dev`, que exporta además `DevSession`, `DevProvider`, `runCli` y helpers puros). `bot.inspectConversation()` y `bot.isBusy()`.

**Cambiado**
- Los errores de un handler llegan **siempre** al evento `'error'` (`{ error, ctx }`), aunque no haya un hook `onError('message')`. Antes se perdían en silencio.
- El dedupe de entrada viene activado por defecto: re-emitir el mismo `chatId` + `ref.id` con el mismo cuerpo se procesa una sola vez (`dedupe: false` para desactivarlo).
- `slashCommandsPlugin`: `/reset` también rearma `WELCOME`; `/cancel` ya no equivale a `/reset` (solo cancela).
- `bot.onType()` / `bot.onImage()`... pasan a especificidad 2 (mismo orden relativo que antes; los triggers multi-tipo quedan en 1).
- `MessageContext` gana los campos obligatorios `user` y `handoff()` y el opcional `call`; el código que construya literales de `MessageContext` a mano debe aportarlos. `SubjectDataExport.userData` y `SubjectDeletionResult.userData` son campos nuevos obligatorios.
- `bot.deleteSubject()` también olvida el handoff del chat del usuario y rearma su `WELCOME`.
- Las escrituras de chats del Bot (ledger de entrada y de salida, handoff) se serializan por chat.

**Corregido**
- Un `flow(CALL)` o `bot.conversation(..., { trigger: CALL })` ya no reemplaza una conversación activa ni borra un checkpoint persistente; los triggers `CALL` respetan las listas de acceso y el handoff; los contextos `CALL` tienen `ctx.user`.
- Handoff: `start()` borra los checkpoints dormidos de cada chat en handoff (un flujo viejo ya no se reanuda tras `resume()`); la restauración usa un índice en vez de recorrer `listChats()`, nunca hace fallar `start()` y no pisa un `resume()` hecho mientras restaura; `deleteSubject()` no deja que una escritura pendiente recree el chat borrado.
- `bot.onIdle()` respeta los handoffs restaurados del store sin evento; `bot.onIdle()` y `c.idle()` comparten parser (`'1d'`, `'10 minutes'`) y rechazan con `RangeError` periodos por encima de 2^31 − 1 ms en lugar de dispararse a 1 ms.
- `c.retry()` desde un callback de `c.idle()` solo reenvía la espera pendiente; una espera nueva iniciada con un `retry` sin `await` falla rápido con `ConcurrentWaitError` en lugar de colgarse.
- `ctx.user`: un lote inválido no escribe nada y un fallo del store no libera el lock con escrituras hermanas en vuelo; los TTL fraccionarios se redondean hacia arriba y los que desbordan `Number.MAX_SAFE_INTEGER` se rechazan.
- `lintFlows()` ya no avisa de flujos a los que el código puede entrar con `c.goto()` (baja a info).
- `bot-wa dev`: una factory que usa otro provider se detiene y nunca se vuelve a llamar; la entrada por pipe espera a que el bot termine de responder.

### @bot-wa/baileys (2026-10)

**Añadido**
- **Votos de encuestas** (issue #7): el provider descifra `pollUpdateMessage` (probando los pares LID/PN), agrega el último voto de cada persona y emite el evento `poll` con el recuento. Guarda las 500 encuestas más recientes (también las propias), exige que el voto llegue por el chat de la encuesta y nombre a su creador, y cuenta cada voto una sola vez (los ids de los últimos 5000). El voto cifrado ya no llega como mensaje `poll`.
- Las llamadas pasan por `toCallEvent()`: el que llama sale con la misma identidad canónica que sus mensajes (`callerPn`, par aprendido o `getPNForLID`), y las llamadas de grupo se emiten con `chatId`/`isGroup` (también sus actualizaciones posteriores); `isVideo` y `offline`.
- README del paquete.

**Cambiado**
- Fijado `@whiskeysockets/baileys` en **`7.0.0-rc14`** (handshake de registro nuevo).
- Identidad de navegador: por defecto ya no se fija la clave `browser`, así que aplica la identidad macOS/Chrome de Baileys; los presets anuncian Chrome y una tupla propia genera un aviso (riesgo de 428).
- `selfId` es el PN normalizado (sin sufijo de dispositivo) y las menciones entrantes son canónicas (LID → PN), así que `groupMode: 'mentions'` funciona con PN o LID.
- `RateLimiterTimeout` es un `RateLimitedError` y `send()` mapea todos los fallos a `ProviderError` tipados.

**Corregido**
- Las reacciones informan de quién reacciona (`reaction.key`), no del autor del mensaje.
- Ids canónicos (vía `IdentityStore`) en reacciones, votos, eventos de grupo, llamadas y presencia; los ids de participantes de grupo son strings.
- Se normalizan los PN con sufijo de dispositivo que devuelve `getPNForLID`.
- Los errores se registran bajo la clave `err` de pino (antes salían como `{}`); los logs de cierre llevan detalle.
- Los mensajes enviados responden a las peticiones de reenvío (retry receipts).

### @bot-wa/meta (2026-10)

**Añadido**
- **Usernames de WhatsApp / BSUID**: se leen `from_user_id`, `contacts[].user_id` y `recipient_user_id`; un id estable por persona (el teléfono si se conoce, si no el BSUID); aprendizaje de pares teléfono ↔ BSUID con `identityMap` enchufable (`MemoryIdentityMap`, `IdentityMap`); `isBsuid()`; envío a un BSUID con el campo `recipient`; `senderInfo.username` y `platformData.bsuid`/`parentBsuid`; enlace de ids en `user_id_update` y `user_changed_number`/`user_changed_user_id`.

**Corregido**
- Los eventos sin un id utilizable se descartan (y se registran) en vez de emitirse con ids `undefined`.

### @bot-wa/graph-core (2026-10)
- **Corregido**: el error de Graph `131062` (destinatario BSUID no soportado, p. ej. plantillas de autenticación) se mapea a `UnsupportedContentError`.

### @bot-wa/ai (2026-10)
- **Añadido**: `ctx.tools.ai` queda tipado como `AIClient` mediante la augmentation `DefaultTools` del core, sin casts (también dentro de `bot.conversation`).

### create-bot-wa (2026-10)
- **Cambiado**: la plantilla `ai` trae una persona de atención al cliente limitada a un negocio (`BUSINESS_NAME` en `.env`), según la política de IA de WhatsApp Business vigente desde 2026-01-15.
- **Cambiado**: los proyectos generados usan el patrón `defineBot` + `isMainModule` y un script `npm run dev` → `bot-wa dev src/bot.js --env-file .env` (`npm start` sigue arrancando el provider real). El README generado explica cómo probarlo en la terminal.

### Stores (2026-10)
- **Todos**: implementan los métodos de `ctx.user` y pasan `runUserDataConformance`. SQLite: tabla `user_data` + índice de expiración. Postgres: `{prefix}user_data` (valor `TEXT`). MySQL: `{prefix}user_data` con ids/clave `VARBINARY` y valor `MEDIUMTEXT`. Mongo: colección `{prefix}user_data`. Redis: una clave por entrada `{prefix}:ud:…` con expiración `PX`. Postgres y MySQL crean ahora siete tablas en `start()`.
- **`@bot-wa/redis-store`**: un `'error'` del cliente sin manejar ya no tumba el proceso al desconectarse; `start()`/`stop()` no se cuelgan; el recorte por `maxMessagesPerChat` no poda de más bajo concurrencia; se escapan los patrones de `KEYS`; `limit`/`ttl`/cap se normalizan o validan antes de llegar a Redis; los upserts de la misma clave se serializan en el proceso.
- **`@bot-wa/sqlite-store`**: tabla `user_data` (ver arriba).
- **`@bot-wa/postgres-store`** (privado): arranque concurrente de réplicas sobre tablas nuevas, timestamps fraccionarios, upserts concurrentes atómicos (merge JSONB) y U+0000 / surrogates sueltos (pasan a U+FFFD).
- **`@bot-wa/mysql-store`** (privado): las claves son `VARBINARY(1024)` (los ids que solo difieren en mayúsculas o acentos ya no colisionan, y se aceptan ids de más de 255 caracteres); los surrogates sueltos no rompen las escrituras JSON; índice `(chat_id, timestamp)`; InnoDB/utf8mb4 explícitos.
- **`@bot-wa/mongo-store`** (privado): `limit: 0` ya no devuelve todo el log; `undefined` no se persiste como `null`; los campos `undefined` explícitos en un upsert se eliminan; los `Buffer` ya no vuelven como BSON `Binary`.

### Canales privados (2026-10)
- **`@bot-wa/messenger`**: los eventos `referral` y `optin` usan ids únicos por evento (`referral:<timestamp>` / `optin:<timestamp>`) en vez del PSID, así que un segundo referral u opt-in del mismo usuario ya no se descarta como duplicado.
- **`@bot-wa/instagram`**: un payload sin `mid` ni timestamp ya no recibe el id compartido `ig_0` (pasa a `''`, que nunca se deduplica).
- **`@bot-wa/discord`, `@bot-wa/messenger`, `@bot-wa/instagram`**: las firmas de los métodos no-op coinciden con `IProvider`; en Discord, `typing(chatId, 'paused')` ya no inicia el indicador de escritura.

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
- `Bot` con dispatcher por prioridad (comandos → conversación activa → reanudación de checkpoint dormido → matchers por especificidad → catch-all), consumo-por-defecto con `ctx.pass()`, cola FIFO por chat.
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
- Transporte WhatsApp sobre Baileys 7 (`@whiskeysockets/baileys` fijado en `7.0.0-rc14`). Implementa `IProvider v2`.
- Capa de identidad LID/PN (Baileys 7), render de QR (terminal + PNG), login por pairing code.
- **Rate limiter anti-ban**: token bucket por chat y global, cola FIFO (no descarta mensajes), jitter human-like opcional.
- Política de reconexión: `conflict/replaced` (440) y `forbidden` (403) no reconectan en loop; `restartRequired` (515) reconecta ya; resto con backoff exponencial con tope; un `start()` fallido durante reconexión reprograma con backoff.
