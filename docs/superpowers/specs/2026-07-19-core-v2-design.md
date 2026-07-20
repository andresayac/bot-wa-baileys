# Spec — Core v2: Dispatcher + ConversationRuntime

- **Fecha:** 2026-07-19
- **Paquete:** `@bot-wa/bot-wa-baileys` v2.0.0 (breaking, sin capa legacy)
- **Estado:** borrador para revisión
- **Decisiones tomadas con el usuario:**
  - Alcance: core sólido primero (nada de dashboard/AI/i18n en este ciclo).
  - Paradigma de flujos: híbrido — motor async/await único; el DSL encadenado compila a él.
  - Compatibilidad: v2 limpio; v1.x queda congelado en npm con guía de migración.
  - Enfoque: fix-forward selectivo (conservar provider/store/APIs; reescribir dispatch y flows). Reescritura desde cero permitida donde haga falta.
  - Persistencia: solo flows del DSL son checkpointeables; conversaciones async puras son en-memoria.

---

## 1. Problema

Evidencia de pruebas reales (transcript 2026-07-18):

1. **Captura rota**: `FlowEngine.processStep` nunca setea `waitingForCapture = true` → el mismo paso se re-ejecuta infinitamente ("¿Cuál es tu nombre?" en loop).
2. **Respuestas dobles**: `hola` dispara `when('hola')` **y** el catch-all "No reconocí ese comando". No hay semántica de consumo de mensaje.
3. **Sin escape**: una conversación atascada se traga todo, incluido `/reset`.
4. **Matching `contains` por defecto**: `/hola` dispara `when('hola')`; falsos positivos por diseño.
5. **Features declaradas pero muertas**: `goto` es no-op, `timeout` no envía su mensaje, `fallback` y `maxRetries` nunca se ejecutan, `persistent()` nunca guarda, `choose()` con sub-flow reemplaza al padre sin retorno.
6. **Cero tests**: nada de esto se detectó antes de probar contra WhatsApp real.

Causa raíz: el motor de "steps array + flags" es frágil y el router no define un pipeline con prioridades y consumo.

## 2. Objetivos

- API usable por tres públicos: principiante (DSL encadenado), avanzado (async/await), IA generadora de código (tipos exhaustivos, naming predecible, un solo import, JSDoc con `@example`).
- Un solo runtime de conversación. Los bugs de sincronización de pasos deben ser imposibles por construcción.
- Pipeline de dispatch determinista: primer consumidor gana, nunca dos respuestas.
- Testeable sin WhatsApp: MockProvider + test kit + suite vitest.

**No-objetivos (este ciclo):** dashboard web, plugin AI, i18n, NLU, stores SQL/Redis, editor visual, multi-sesión first-class, servidor HTTP integrado (estilo BuilderBot `httpServer`) — roadmap v2.1+.

**Empaquetado (decisión tras investigación):** v2 es **ESM-only, Node ≥ 20** — Baileys 7 es ESM-only y exige Node ≥ 20; publicar CJS significaría pelear contra el sustrato. Usuarios CJS en Node ≥ 22.12 pueden hacer `require()` de ESM nativamente. `exports` map + `./testing` subpath.

## 3. Arquitectura

```
Bot (facade: config, lifecycle, registro, eventos públicos)
 ├─ Dispatcher            ← NUEVO (reemplaza MessageRouter)
 ├─ ConversationRuntime   ← NUEVO (reemplaza FlowEngine)
 │    └─ FlowBuilder DSL  ← REESCRITO: compila a conversación
 ├─ HookSystem            ← conservar (ajustes menores)
 ├─ BaileysProvider       ← conservar (reconexión) + capa de identidad LID/PN (ver 3.1)
 ├─ MockProvider          ← NUEVO (misma interfaz de eventos)
 ├─ IStore / MemoryStore  ← conservar (+ métodos de checkpoint)
 ├─ Scheduler / MediaProcessor / sub-APIs (groups, profile, privacy, chats, presence) ← conservar
 └─ context.ts            ← conservar (inyectar MediaProcessor, quitar dynamic imports)
```

Matriz conservar/reescribir:

| Pieza | Veredicto | Nota |
|---|---|---|
| `provider/BaileysProvider.ts` | Conservar | Ya emite eventos tipados; sin conocimiento del resto |
| `core/MessageRouter.ts` | **Eliminar** | Sustituido por Dispatcher |
| `flows/FlowEngine.ts` + steps | **Eliminar** | Sustituido por ConversationRuntime |
| `flows/FlowBuilder.ts` | **Reescribir** | Misma cara pública, compila a conversación |
| `core/Bot.ts` | Adelgazar | Delegar registro al Dispatcher; quitar `console.log` |
| `hooks/HookSystem.ts` | Conservar | — |
| `store/*` | Conservar | + `getCheckpoint/setCheckpoint/clearCheckpoint` |
| `api/*`, `scheduler/*`, `media/*`, `utils/*` | Conservar | context.ts recibe media inyectado |
| `plugins/slashCommands.ts` | **Reescribir** | Sobre la nueva ruta de comandos; sin responder a mensajes no-slash |

### 3.1 Capa de identidad LID/PN (obligatoria con Baileys 7)

WhatsApp completó la migración a LIDs; sesiones nuevas usan LID por defecto y "PNs are WAY LESS RELIABLE" (guía oficial de migración v7). Reglas:

- La API pública **nunca** expone la dualidad cruda: `ctx.from`/`ctx.sender` son IDs normalizados (PN-preferido vía `remoteJidAlt`/`participantAlt`, fallback LID) — la lógica actual del router se formaliza en `utils/jid.ts`.
- El provider envuelve `sock.signalRepository.lidMapping` (`getLIDForPN/getPNForLID`) y escucha `lid-mapping.update` para mantener cache.
- `ctx.sender` incluye `{ id, phoneNumber?, lid? }` para quien necesite detalle.
- Auth-store custom (futuro) debe soportar claves v7: `lid-mapping`, `device-list`, `tctoken` (`useMultiFileAuthState` ya lo hace).

### 3.2 Sin botones ni listas nativas (principio)

Meta deprecó botones/listas interactivas en el protocolo Web MD (Baileys issue #2465: se envían sin error, no se muestran). v2 **no promete botones**: `c.choose()`/`flow().choose()` generan menús numerados de texto con re-pregunta automática, y polls quedan como alternativa nativa. Forks que "reviven" botones = riesgo de ban; fuera.

## 4. Dispatcher

Pipeline por mensaje entrante, en orden estricto. **El primer paso que consume termina el pipeline** (salvo hooks, que siempre corren).

```
0. before-hooks ('message')          — pueden abortar (ctx.abort())
1. Ruta de comandos (prefijo '/')    — SIEMPRE, incluso con conversación activa
2. Conversación activa               — entrega el mensaje al wait() pendiente
3. Matchers registrados              — when(), conversaciones/flows por trigger,
                                       onImage/onAudio/... (por tipo)
4. Catch-all (onMessage)
5. after-hooks ('message') + emit('message')
```

Reglas:

- **Consumo por defecto.** Un handler que corre consume el mensaje. Para dejar pasar: `ctx.pass()`.
- **Orden dentro del paso 3:** especificidad primero — `command` > `equals` > `startsWith` > `regex` > `contains` > tipo (`onImage`...) — y a igual especificidad, orden de registro.
- **Serialización por chat:** cola FIFO por chat-key; nunca dos handlers procesando mensajes del mismo chat en paralelo (elimina razas de captura).
- Filtros previos (fromMe, broadcast, newsletter, status) se mantienen del router actual.
- Logs vía `logger.debug`, jamás `console.log`.

### Matching (nuevo default)

- String → **`equals` normalizado**: trim, lowercase, colapso de espacios, sin diacríticos (NFD). `"Hóla "` ≡ `"hola"`.
- Opt-in explícito: `{ match: 'contains' | 'startsWith' | 'endsWith' }`, `RegExp`, o función `(ctx) => boolean`.
- `scope`: `'dm' | 'group' | 'all'` (default `'all'`).

### Ruta de comandos

- `bot.command('reset', handler)` — prefijo configurable (default `/`), parsea args.
- Corre **antes** que la conversación activa: `/reset` siempre escapa (bug del transcript).
- Comando desconocido con prefijo → hook `command:unknown` (el plugin de slash decide si responde). Mensajes sin prefijo jamás tocan esta ruta.

## 5. ConversationRuntime

### Modelo

- Una conversación activa por **chat-key**: DM → jid del chat; grupo → `chatJid + ':' + senderJid` (cada participante tiene su propia conversación; sin cross-talk).
- Implementación por **promesa suspendida**: la función de conversación corre como async normal; `c.wait*()` registra un resolver en el runtime y suspende. El Dispatcher (paso 2) resuelve con el contexto entrante.
- Si llega mensaje mientras la conversación procesa (no está en `wait`), se encola en un inbox por conversación (cap 10, descarta más viejos) y se entrega al siguiente `wait`.
- Al terminar la función (return, `c.end()`, error o timeout) el runtime limpia estado, timers e inbox.

### API

```ts
bot.conversation('registrar', async (c, ctx) => {
  await ctx.reply('📝 Vamos a registrarte')
  const name = await c.ask('¿Tu nombre?')
  const email = await c.ask('¿Tu email?', {
    validate: (b) => /\S+@\S+\.\S+/.test(b) || '❌ Email inválido, intenta de nuevo',
    retries: 3,
    timeout: '2m',
  })
  await ctx.reply(`✅ ${name} <${email}>`)
})
// registro: bot.conversation(trigger, fn) — trigger acepta lo mismo que when()
```

Primitivas de `c` (ConversationControls):

| Método | Semántica |
|---|---|
| `c.ask(text, opts?)` | Envía `text`, espera respuesta de texto, devuelve `string` |
| `c.waitText(opts?)` | Espera texto sin enviar nada |
| `c.waitMedia(types?, opts?)` | Espera imagen/audio/video/documento; devuelve ctx con helpers de descarga |
| `c.waitAny(opts?)` | Espera cualquier mensaje; devuelve `MessageContext` |
| `c.choose(prompt, options, opts?)` | Menú: envía prompt, re-pregunta ante entrada inválida, devuelve la clave elegida o ejecuta el handler/sub-conversación asociada y **retorna al llamador** |
| `c.say(...)` | Alias de `ctx.reply` |
| `c.state` | Objeto persistible de la conversación (`Record<string, unknown>`) |
| `c.end(message?)` | Termina la conversación inmediatamente |
| `c.goto(name, args?)` | Transfiere a otra conversación registrada (reemplaza, no retorna) |

Opciones de `wait/ask` (`WaitOptions`):

- `timeout`: `'90s' | '2m' | ms` — al vencer: envía `timeoutMessage` (config global con default sensato) y termina. Default global: 5 min.
- `validate: (body, ctx) => true | string` — string = mensaje de error y re-espera.
- `retries`: intentos de validación fallidos antes de terminar con `retriesExceededMessage`. Default 3.
- `filter: (ctx) => boolean` — mensaje que no pasa el filtro **no** es consumido por la conversación: sigue el pipeline normal (matchers/catch-all) y no gasta intento ni resetea el timeout.

Comportamiento con triggers a mitad de conversación: si el usuario escribe algo que matchearía otro trigger (`comprar` durante `registrar`), el mensaje va a la conversación activa (paso 2 consume antes que el paso 3). Escape explícito: `/reset` (ruta de comandos, paso 1) o `c.end()`. Se documenta con ejemplo.

### Errores y cancelación

- Clases: `ConversationTimeout`, `ConversationCancelled`, `RetriesExceeded` — el runtime las lanza dentro de la función en el `await` pendiente; la función puede `try/catch` para despedirse; si no las captura, el runtime las maneja (mensaje default + fin limpio).
- `bot.abortConversation(chatKey)` / comando `/reset` → `ConversationCancelled`.
- Excepción no controlada → error-hooks + `emit('error')` + mensaje configurable (`onConversationError`) + fin limpio. Nunca deja la conversación zombie.

## 6. FlowBuilder DSL (compila al runtime)

Misma experiencia encadenada, cero motor propio:

```ts
const registrar = flow('registrar')
  .say('📝 Vamos a registrarte')
  .ask('¿Tu nombre?', 'name')                              // guarda en c.state.name
  .ask('¿Tu email?', 'email', { validate: isEmail })
  .do(async (ctx, c) => api.save(c.state))                  // acción sin mensaje
  .say((ctx, c) => `✅ ${c.state.name} <${c.state.email}>`)

bot.use(registrar)
```

- `flow(trigger, opts?)` → builder. Métodos: `.say()`, `.ask(text, stateKey, opts?)`, `.do(fn)`, `.media(src, caption?)`, `.choose(prompt, { clave: subFlow | fn })`, `.goto(flowOrName)`, `.timeout(ms, msg?)` (default del flow), `.scope('dm'|'group'|'all')`, `.persistent()`.
- **Compilación:** el builder produce una lista declarativa de pasos que un intérprete genérico ejecuta usando exactamente las primitivas de `c` (`ask`, `say`, `choose`...). Un solo runtime que testear.
- `.choose()` con sub-flows: ejecuta el sub-flow y **continúa con los pasos restantes del padre** (stack real). `.goto()`: transfiere sin retorno.
- Alias de compatibilidad conceptual: `addKeyword = flow`, `.addAnswer ≈ .say/.ask`, `.addAction = .do` (documentados en la guía de migración, mismos nombres exportados).

### Persistencia (checkpoint)

- Solo flows del DSL marcados `.persistent()` (o `config.persistentFlows: true`).
- Tras completar cada paso: `store.setCheckpoint(chatKey, { flowId, step, state })`.
- Al arrancar el bot: checkpoints existentes se rehidratan; el intérprete salta a `step` con `state` restaurado. Al siguiente mensaje del usuario, continúa donde iba.
- Conversaciones async puras: en-memoria; documentado con claridad ("si necesitas sobrevivir reinicios, usa el DSL o divide en conversaciones cortas").

## 7. Hooks y plugins

- HookSystem se conserva: `before/after/error` × evento (`message`, `send`, `connection`, `reaction`, `poll`, `call`, `group`, `presence`, `command:unknown`), con prioridad numérica.
- `before('send')` nuevo: todo envío pasa por ahí (habilita typing humanizado, rate-limit, censura).
- Plugins: `definePlugin` se conserva; se añade `uninstall` — `bot.plug()` devuelve función de desinstalación que revierte handlers/hook registrados por el plugin (disposables por plugin).
- `slashCommandsPlugin` reescrito sobre `bot.command()`: `/help /reset /id /ping`; responde a comandos desconocidos **solo** si empiezan con el prefijo.

## 8. Testing (requisito de primera clase)

- **MockProvider**: implementa la interfaz de eventos de `BaileysProvider` sin red; `send()` acumula salidas.
- **Test kit exportado** (`@bot-wa/bot-wa-baileys/testing`):

```ts
const { bot, chat } = await createTestBot({ flows: [registrar] })
await chat.send('registrar')
await chat.expectReply(/vamos a registrarte/i)
await chat.send('Andres')
await chat.expectReply(/tu email/i)
```

- Suite vitest (~40+ casos): normalización/matching, orden y consumo del Dispatcher, ruta de comandos dentro de conversación activa, runtime (ask/validate/retries/timeout con fake timers), choose con retorno al padre, goto, checkpoint/rehidratación, inbox overflow, serialización por chat, plugin uninstall.
- CI: `pnpm test` + `pnpm build` verdes antes de cualquier release.

## 9. DX para humanos e IAs

- Un import: `import { Bot, flow, conversation } from '@bot-wa/bot-wa-baileys'`.
- Cero `any` en la API pública; triggers y opciones tipados con uniones literales.
- JSDoc `@example` en todo símbolo exportado (estilo ya presente).
- `docs/llms.txt` + página "API en una página" generada de typedoc — pensada para pegar en contexto de un LLM.
- Errores con mensajes accionables ("Bot not connected — await bot.start() first").

## 10. Migración v1 → v2 (guía, no código)

| v1 | v2 |
|---|---|
| `new BaileysClass(opts)` | `new Bot(config)` + `await bot.start()` |
| `bot.on('message')` global | `bot.onMessage()` (catch-all) o `bot.when()` |
| `addKeyword().addAnswer(txt, {capture})` | `flow().say()` / `.ask()` |
| `sendText/sendImage/...` | `bot.send*` conservados + `ctx.reply/photo/...` |
| Eventos `qr/ready/pairing_code` | Iguales |
| `sendButtons` (deprecated en v1) | Eliminado — usar `choose()` (menú numerado) o `sendPoll` |

## 11. Riesgos

| Riesgo | Mitigación |
|---|---|
| Baileys 7 rc — API inestable | Provider aísla; pin de versión exacta en v2.0.0 |
| Promesa suspendida + reinicio = conversación perdida | Documentado; DSL checkpointeable cubre el caso crítico |
| Grupos: chat-key por participante cambia semántica v1 | Documentar; config `conversationScope: 'chat'` para volver al modo v1 |
| Doble público (DSL + async) = doble docs | Docs por nivel: "Empieza" (DSL) / "Avanzado" (async); misma terminología |

## 12. Análisis competitivo (investigación 2026-07-19)

Datos npm del 2026-07-19 (descargas/semana): Baileys ~696k · whatsapp-web.js ~94k · grammY ~3.3M · Telegraf ~293k (sin release desde 2024-02) · @builderbot/bot ~1.7k · venom-bot ~945 (moribunda) · wppconnect ~5.8k.

### Hallazgos que sustentan el diseño

| Hallazgo | Fuente | Efecto en este spec |
|---|---|---|
| Async/await ganó a step-arrays: grammY diseñó conversations contra scenes/wizards ("equivale a GOTO") | github.com/grammyjs/grammY/issues/136 · grammy.dev/plugins/conversations | Valida ConversationRuntime como motor único (§5) |
| Los bugs top de BuilderBot son de `gotoFlow` (no respeta delay #877, anidados rompen #910, exige `return` o falla silencioso) — fallo estructural del modelo de saltos | github.com/codigoencasa/builderbot/issues/877 | Valida DSL-compila-a-runtime; `goto` explícito sin retorno (§6) |
| Telegraf estancada 2.5 años; wizard-por-array parte conversaciones en N callbacks + `selectStep` mágicos | grammy.dev/resources/comparison | Anti-patrón confirmado |
| El piso de entrada de BuilderBot (bot útil en 10 líneas, `capture`/`fallBack` nombrados como piensa el dev de negocio) es su mayor virtud | builderbot.app/en/methods | El DSL conserva ese piso; alias `addKeyword` documentado |
| whatsapp-web.js se percibe "fácil" por objetos ricos (`msg.reply()`, `chat.send()`), no por su runtime (Puppeteer come 8-20 GB, issue #3459) | wwebjs.dev · github issue #3459 | Valida `MessageContext` con helpers colgados |
| grammY: `otherwise:` en waits, filtros string tipados (`"message:text"`), context flavors | grammy.dev | `validate` que retorna string ≈ `otherwise`; filtros tipados → backlog DX |
| Replay engine de grammY = fuente nº1 de bugs de usuarios (`external()`, serialización) | github.com/grammyjs/conversations/issues | Valida promesa suspendida + checkpoint DSL en vez de replay (§5-6) |
| Hono/Fastify: middleware tipado que acumula tipos por la cadena; plugins encapsulados con hooks nombrados | hono.dev · fastify.dev | Patrón para `provide()` tipado y plugin disposables (§7) |
| Sapphire: guards declarativos nombrados (preconditions) | sapphirejs.dev | `scope`/`filter` hoy; guards nombrados → roadmap |
| llms.txt: grammy.dev/hono.dev/fastify.dev responden 200; builderbot/baileys.wiki/wwebjs → 404 | verificación HTTP 2026-07-19 | Diferenciador confirmado: llms.txt día uno (§9) |
| Baileys 7: ESM-only, Node ≥20, LID default, auth keys nuevas (`lid-mapping`, `device-list`, `tctoken`), sin ACKs de entrega (anti-ban), botones/listas muertos en Web MD | baileys.wiki/docs/migration/to-v7.0.0 · issue #2465 | §2 (ESM), §3.1 (identidad), §3.2 (sin botones), pin rc13 |
| Hueco de mercado: no existe "grammY de WhatsApp" mantenido; BuilderBot es lo más cercano (DSL rígido, provider desfasado de v7); baileys-bottle muerto; wa-multi-session cubre solo multi-sesión | npm registry | Posicionamiento de v2; multi-sesión y httpServer → roadmap v2.1 |

### Síntesis

La combinación que ningún competidor tiene: runtime async/await sin replay + DSL azucarado encima + objetos ricos estilo wwebjs + identidad LID/PN resuelta + test kit + llms.txt. Cada pieza tiene evidencia de demanda y ningún paquete WhatsApp mantenido las junta.

## 13. Criterios de éxito

1. El transcript del 2026-07-18 completo pasa como test de integración sin un solo comportamiento erróneo.
2. `hola` produce exactamente UNA respuesta.
3. `/reset` escapa de cualquier conversación en cualquier estado.
4. Flow `registrar` completo (nombre → email con validación) funciona por MockProvider y por WhatsApp real.
5. Reinicio del bot a mitad de un flow `.persistent()` retoma en el paso correcto.
6. `pnpm test` verde; cero `console.log` en `src/`.
