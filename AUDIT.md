# 🔍 Auditoría Arquitectónica — `bot-wa-baileys` v2.0.0-alpha.0

> Análisis exhaustivo de los 21 archivos fuente en `src/` tras la refactorización a arquitectura por capas.
>
> **Objetivo:** validar que la organización es correcta, detectar problemas de diseño, duplicación, acoplamiento, y proponer mejoras concretas antes de avanzar.

- **Fecha:** 2026-07-18
- **Archivos analizados:** 21 (todos los de `src/`)
- **Líneas totales:** ~2,800
- **Build status:** ✅ Compila limpio, 42 archivos en `lib/`

---

## 📊 Mapa de dependencias (actual)

```
index.ts
  └── core/Bot.ts ──────────────── ORQUESTADOR (550 líneas)
        ├── core/types.ts          (tipos públicos)
        ├── core/context.ts        (factory de MessageContext, 290 líneas)
        ├── provider/BaileysProvider.ts  (socket + eventos, 350 líneas)
        ├── hooks/HookSystem.ts    (pipeline before/after/error, 130 líneas)
        ├── flows/FlowEngine.ts    (runtime de flows, 220 líneas)
        ├── flows/FlowBuilder.ts   (DSL builder, 230 líneas)
        ├── store/IStore.ts        (interfaz)
        ├── store/MemoryStore.ts   (implementación, 170 líneas)
        ├── scheduler/Scheduler.ts  (cron/interval/delay, 150 líneas)
        ├── api/GroupsAPI.ts       (20 métodos, 130 líneas)
        ├── api/ProfileAPI.ts      (8 métodos, 60 líneas)
        ├── api/PrivacyAPI.ts      (10 métodos, 55 líneas)
        ├── api/ChatsAPI.ts        (8 métodos, 80 líneas)
        ├── api/PresenceAPI.ts     (2 métodos, 20 líneas)
        ├── plugins/definePlugin.ts (helper + guard, 30 líneas)
        ├── plugins/slashCommands.ts (plugin built-in, 90 líneas)
        ├── media/MediaProcessor.ts (sticker/audio/image, 130 líneas)
        └── utils/jid.ts + timers.ts (helpers, 100 líneas)
```

---

## ✅ Lo que está **bien** (preservar)

### 1. Separación de responsabilidades
Cada archivo tiene un propósito claro y único:
- `BaileysProvider` → solo socket + eventos normalizados. **No** sabe de flows, plugins, ni media.
- `Bot` → orquestador que conecta todo. Es el único que conoce todas las piezas.
- `HookSystem` → pipeline puro, sin dependencias de WhatsApp.
- `FlowEngine` → runtime de flows, sin saber de WhatsApp ni sockets.
- `MemoryStore` → persistencia, sin saber de Baileys.
- Sub-APIs (`GroupsAPI`, etc.) → wrappers thin sobre el socket.

### 2. Dirección de dependencias correcta
```
Bot → Provider, Store, Hooks, Flows, Scheduler, APIs
Provider → Baileys (no conoce Bot)
Hooks → nada (puro)
Flows → types (no conoce Provider)
Store → Baileys types (no conoce Bot)
APIs → Socket getter (no conoce Bot)
```
**No hay dependencias circulares.** ✅

### 3. Identidad propia de la API
- `when()` / `plug()` / `provide()` / `say()` / `do()` / `choose()` — naming único, no copiado.
- `MessageContext` con helpers fluidos (`ctx.reply()`, `ctx.photo()`, `ctx.sticker()`).
- `definePlugin()` + `slashCommandsPlugin` — sistema de plugins real.

### 4. Tipos públicos exhaustivos
`core/types.ts` define **todo** lo que el usuario necesita: `BotConfig`, `MessageContext`, `Flow`, `Plugin`, `GroupsAPI`, etc. Cero `any` en la API pública.

### 5. Eventos normalizados
`BaileysProvider` emite eventos tipados via `TypedEmitter<ProviderEvents>`. Bot los traduce a hooks + eventos públicos. Capa limpia.

---

## 🔴 Problemas detectados (con severidad)

### 🔴 CRÍTICO — `Bot.ts` es un dios-objeto (550 líneas)

**Problema:** `Bot` hace demasiadas cosas:
- Lifecycle (start/stop)
- Declarative API (`when`, `onMessage`, `onType`)
- Hook registration (`before/after/onError`)
- Plugin management (`plug`)
- DI (`provide`)
- Scheduler proxy (`schedule/every/delay`)
- Send helpers (`send/sendText/broadcast`)
- Sub-API wiring (groups/profile/privacy/chats/presence)
- Provider event wiring (`connectProviderEvents` — 100 líneas)
- QR rendering (`renderQr`)
- Pattern handler matching
- Type handler dispatch
- Flow routing
- Error handling

**Síntoma:** 550 líneas en un solo archivo, 15+ responsabilidades.

**Fix propuesto:** Extraer `MessageRouter` (dispatch de mensajes a handlers/flows/types) y `BotLifecycle` (start/stop/ready). Bot queda como facade delgada.

---

### 🟡 MEDIO — `context.ts` usa dynamic imports

**Problema:** Los helpers de media hacen `await import('../media/MediaProcessor')` en cada llamada:
```ts
async photo(source: MediaSource, caption?: string) {
  const { toMediaUpload } = await import('../media/MediaProcessor')  // ⚠️
  ...
}
```

**Impacto:** Performance (import dinámico en cada `ctx.photo()`), código verboso, difícil de testear.

**Fix propuesto:** Inyectar `MediaProcessor` como dependencia en `BuildContextDeps`:
```ts
export interface BuildContextDeps {
  ...
  media: { toMediaUpload, makeSticker, transcodeToOpus }  // inyectado
}
```

---

### 🟡 MEDIO — `FlowBuilder` duplica `keyword` y `_keyword`

**Problema:**
```ts
readonly keyword: KeywordMatcher    // público (interface Flow)
private _keyword: KeywordMatcher     // privado (mutable)
```
Ambos se asignan en constructor y se actualizan en `when()`. Confuso y propenso a bugs.

**Fix propuesto:** Usar un getter:
```ts
private _keyword: KeywordMatcher
get keyword(): KeywordMatcher { return this._keyword }
```

---

### 🟡 MEDIO — `FlowBuilder.options` es `any`

**Problema:**
```ts
readonly options: any  // ⚠️ pierde type-safety
```
La interface `Flow` exige `options` pero el tipo es `any`.

**Fix propuesto:** Definir `FlowOptions` completo en types.ts y usarlo.

---

### 🟡 MEDIO — `FlowEngine.runStep` no maneja `timeout` ni `fallback`

**Problema:** `FlowBuilder` tiene `.timeout()` y `.fallback()` que setean `_timeoutMs` y `_fallback`, pero `FlowEngine` **nunca los lee**. Las features existen en el DSL pero no funcionan en runtime.

**Fix propuesto:** `FlowEngine` debe:
1. Leer `flow.options.timeoutMs` y armar un timer al iniciar el flow.
2. Si el timer expira, enviar `timeoutMessage` y llamar `end()`.
3. Si el usuario envía algo off-topic durante `waitingForCapture`, ejecutar `fallback`.

---

### 🟡 MEDIO — `FlowEngine` no persiste estado en el store

**Problema:** El estado de flows (`active` Map) es solo en memoria. Si el bot reinicia, todos los flows activos se pierden. `FlowBuilder.persistent()` existe pero no se usa.

**Fix propuesto:** Conectar `FlowEngine` con `IStore.getFlowState/setFlowState/clearFlowState` cuando `flow.options.persistent === true`.

---

### 🟡 MEDIO — `Bot.connectProviderEvents` no persiste chats/contacts/history

**Problema:** El provider emite `chatsUpsert`, `contactsUpsert`, `historySet`, etc., pero Bot **solo escucha `rawMessage`**. Los chats, contactos e histórico se pierden.

**Fix propuesto:** Agregar listeners que persistan en el store:
```ts
this.provider.onTyped('chatsUpsert', async (chats) => {
  for (const c of chats) await this.store.upsertChat(c)
})
this.provider.onTyped('contactsUpsert', async (contacts) => {
  for (const c of contacts) await this.store.upsertContact(c)
})
this.provider.onTyped('historySet', async (data) => {
  for (const c of data.chats) await this.store.upsertChat(c)
  for (const c of data.contacts) await this.store.upsertContact(c)
  for (const m of data.messages) await this.store.saveMessage(m)
})
```

---

### 🟡 MEDIO — `Bot.when()` registra flows pero no los arranca correctamente

**Problema:**
```ts
if (isFlowRun(handler)) {
  this.flows.register(handler)
  this.mountedPatternHandlers.push({ id, match: matchFn, handler: async (ctx) => {
    await this.flows.runFromMatch(ctx, handler)  // solo registra, no ejecuta step 0
  }})
}
```
`runFromMatch` solo hace `start()` (resetea a step 0) pero **no ejecuta el primer step**. El usuario no recibe la primera respuesta del flow hasta enviar otro mensaje.

**Fix propuesto:** Después de `runFromMatch`, ejecutar `processStep`:
```ts
handler: async (ctx) => {
  await this.flows.runFromMatch(ctx, handler)
  // Ejecutar primer step inmediatamente
  await this.flows.processStep(ctx, {
    send: async (text) => { await ctx.text(text) },
    end: () => this.flows.end(ctx.from),
  })
}
```

---

### 🟡 MEDIO — `HookSystem.runBefore` reemplaza `abort` temporalmente

**Problema:**
```ts
const originalAbort = ctxAny.abort.bind(ctxAny)
ctxAny.abort = () => { aborted = true; originalAbort() }
// ... pipeline ...
ctxAny.abort = originalAbort  // en finally
```
Mutar el método `abort` del ctx es frágil. Si hay hooks anidados o reentrancia, se rompe.

**Fix propuesto:** Usar un wrapper o un símbolo en vez de mutar el método:
```ts
const abortSymbol = Symbol('abort')
ctxAny[abortSymbol] = false
ctxAny.abort = () => { ctxAny[abortSymbol] = true }
// leer ctxAny[abortSymbol] en vez de `aborted`
```
O mejor: pasar el flag de abort por closure, no mutar el ctx.

---

### 🟢 BAJO — `slashCommands.ts` accede a `bot.flows` via `(bot as any)`

**Problema:**
```ts
const flowEngine = (bot as any).flows
flowEngine.end(ctx.from)
```
Acceso privado via `any`. Frágil si se renombra.

**Fix propuesto:** Exponer un método público `bot.abortFlow(userId)` o `bot.resetFlow(userId)`.

---

### 🟢 BAJO — `definePlugin.ts` tiene typo en doc

**Problema:** `fact88` en el comentario del archivo.

---

### 🟢 BAJO — `Scheduler` no sobrevive reinicios

**Problema:** Las tareas programadas se pierden al reiniciar el bot.

**Fix propuesto (futuro):** Persistir tareas en `IStore` y restaurarlas en `start()`.

---

### 🟢 BAJO — `MediaProcessor.makeSticker` no empaqueta EXIF

**Problema:** El comentario dice "EXIF packing omitted for now". Los stickers no tienen metadata de `pack`/`author`.

**Fix propuesto:** Implementar empaquetado EXIF con `exif` library o manual.

---

### 🟢 BAJO — `BaileysProvider` no expone `downloadMedia` en la interfaz pública

**Problema:** `downloadMedia` existe pero no está en `IBaileysProvider`. Se accede via `(ctx as any).__mediaDownloader`.

**Fix propuesto:** Tipar correctamente el downloader en `BuildContextDeps`.

---

## 📐 Mejoras estructurales propuestas

### 1. Extraer `MessageRouter` de `Bot.ts`

```
src/core/
├── Bot.ts              ← facade delgada (~200 líneas)
├── MessageRouter.ts    ← NUEVO: dispatch de mensajes a handlers/flows/types
├── context.ts          ← factory de MessageContext
└── types.ts
```

`MessageRouter` se encarga de:
- Ejecutar hooks `before`
- Rutar a flows activos
- Matchear `when()` handlers
- Dispatch a type handlers
- Ejecutar catch-all
- Ejecutar hooks `after`
- Emitir evento `message`

Bot queda como facade que delega.

### 2. Extraer `BotLifecycle`

```
src/core/
├── Bot.ts
├── BotLifecycle.ts     ← NUEVO: start/stop/ready/reconnect
```

### 3. Inyectar `MediaProcessor` en context

En vez de dynamic imports, inyectar las funciones de media en `BuildContextDeps`:
```ts
export interface BuildContextDeps {
  rawMessage: proto.IWebMessageInfo
  tools: any
  send: ...
  markRead?: ...
  presence?: ...
  deleteMessage?: ...
  media: MediaProcessorAPI  // NUEVO
}
```

### 4. Completar `FlowEngine` con timeout + fallback + persistence

### 5. Conectar store con eventos de provider (chats/contacts/history)

### 6. Exponer métodos públicos para slash commands (`bot.abortFlow`)

---

## 📋 Tabla resumen de issues

| # | Severidad | Archivo | Problema | Fix |
|---|-----------|---------|----------|-----|
| 1 | 🔴 | `Bot.ts` | Dios-objeto 550 líneas | Extraer MessageRouter + BotLifecycle |
| 2 | 🟡 | `context.ts` | Dynamic imports en cada llamada | Inyectar MediaProcessor |
| 3 | 🟡 | `FlowBuilder.ts` | Duplica keyword/_keyword | Usar getter |
| 4 | 🟡 | `FlowBuilder.ts` | options es `any` | Tipar con FlowOptions |
| 5 | 🟡 | `FlowEngine.ts` | timeout/fallback no funcionan | Implementar en runtime |
| 6 | 🟡 | `FlowEngine.ts` | No persiste estado | Conectar con IStore |
| 7 | 🟡 | `Bot.ts` | No persiste chats/contacts/history | Agregar listeners |
| 8 | 🟡 | `Bot.ts` | `when()` no ejecuta step 0 del flow | Llamar processStep tras start |
| 9 | 🟡 | `HookSystem.ts` | Mutar abort temporalmente | Usar símbolo o closure |
| 10 | 🟢 | `slashCommands.ts` | Acceso `(bot as any).flows` | Exponer bot.abortFlow() |
| 11 | 🟢 | `definePlugin.ts` | Typo en doc | Fix |
| 12 | 🟢 | `Scheduler.ts` | No sobrevive reinicios | Persistir (futuro) |
| 13 | 🟢 | `MediaProcessor.ts` | Sticker sin EXIF | Implementar |
| 14 | 🟢 | `BaileysProvider.ts` | downloadMedia no tipado en deps | Tipar en BuildContextDeps |

---

## 🎯 Veredicto

**La arquitectura base es sólida.** La separación por capas es correcta, las dependencias van en una sola dirección, no hay acoplamiento circular, y la API pública tiene identidad propia.

**Pero hay 3 issues críticos/medios que deben resolverse antes de considerar la v2 estable:**

1. **`Bot.ts` es demasiado grande** → extraer `MessageRouter`
2. **Flows no funcionan completamente** → timeout/fallback/step-0 sin implementar
3. **Store no se alimenta de eventos** → chats/contacts/history se pierden

El resto son mejoras de calidad que se pueden hacer incrementalmente.

**Recomendación:** Resolver issues #1, #5, #7, #8 antes de cualquier prueba funcional seria. Los demás se pueden batchear en una sesión de "polish".

---

*Auditoría completada el 2026-07-18. Basada en lectura completa de los 21 archivos fuente.*