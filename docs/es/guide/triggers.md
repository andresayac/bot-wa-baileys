# Triggers especiales: WELCOME, tipos de mensaje y CALL

Además de los triggers de texto, regex y predicado, `@botmesh/core` exporta
constantes de trigger para el **primer contacto** de un usuario, para los
**tipos de mensaje** (imágenes, notas de voz, ubicaciones...) y para las
**llamadas entrantes**. Funcionan en cualquier sitio que acepte un trigger:
`bot.when()`, `flow()` / `addKeyword()` (incluido `.scope()`),
`bot.conversation(name, fn, { trigger })` y `bot.use()`.

```ts
import {
  Bot, flow, addKeyword, typeTrigger,
  WELCOME, MEDIA, IMAGE, VIDEO, AUDIO, VOICE_NOTE, DOCUMENT, STICKER,
  LOCATION, CONTACT, POLL, CALL,
} from '@botmesh/core'
```

## WELCOME

`WELCOME` se dispara en la **primera interacción** de un usuario con el bot:

```ts
bot.when(WELCOME, async (ctx) => {
  await ctx.reply('🙌 ¡Bienvenido! Escribe "menu" para ver las opciones.')
})

// Como flujo de onboarding (agrega .id('onboarding') si lo haces .persistent())
bot.use(addKeyword(WELCOME).ask('¿Cómo te llamas?', 'name').say((_, c) => `¡Hola ${c.state.name}!`))

// Saludar Y dejar que el mismo mensaje siga a los demás triggers
bot.when(WELCOME, async (ctx) => { await ctx.reply('¡Hola! 👋'); ctx.pass() })
```

- **Ámbito:** por chat en un DM y por participante en un grupo (cada
  miembro recibe su bienvenida), sin importar `conversationScope`. Un DM y
  un grupo cuentan como primeros contactos distintos. Para limitarlo a DMs:
  `flow(WELCOME).scope('dm')` o `{ ...WELCOME, scope: 'dm' }`.
- **Qué cuenta como primer contacto:** el primer mensaje que llega a la
  etapa de matchers. Un comando (`/help`), una conversación activa, la
  reanudación de un checkpoint, un hook `before` que aborta o el filtro
  `groupMode` no gastan la bienvenida.
- **Precedencia:** `WELCOME` va antes que cualquier otro matcher, también
  antes que los triggers de texto. Si el primer mensaje es "menu", lo
  atiende `WELCOME`; llama a `ctx.pass()` para que `bot.when('menu')`
  también lo reciba.
- **Persistencia:** se guarda en el clave/valor de cursores del store (lo
  soportan todos los stores incluidos), así que sobrevive a reinicios con un
  store persistente (`MemoryStore` con `file`, SQLite, Redis, Postgres,
  MySQL o Mongo). Las claves son hashes (`welcome:<sha256>`), sin ids ni
  teléfonos en claro. Un `IStore` propio sin cursores usa una caché en
  memoria que no sobrevive a reinicios.
- **Concurrencia:** se decide dentro de la cola FIFO por chat, así que dos
  primeros mensajes simultáneos nunca reciben dos bienvenidas. Entre varios
  procesos que comparten store es check-then-set: enruta cada chat a un
  solo proceso, como ya exigen las conversaciones.
- **Coste:** sin handler `WELCOME`, cero lecturas extra al store. Con
  handler, como máximo una lectura (dos en grupos) y una escritura por
  usuario y proceso; después responde una caché en memoria.
- Si falla la lectura del store, no se saluda (falla cerrado), el error va a
  `bot.on('error')` y el mensaje sigue su camino normal.

### Rearmar la bienvenida

```ts
await bot.resetWelcome(dmChatId)          // el usuario de ese DM
await bot.resetWelcome(groupId, userId)   // un participante del grupo
await bot.resetWelcome(groupId)           // todos los participantes del grupo
```

`slashCommandsPlugin` llama a `resetWelcome` en `/reset` (el DM, o el
participante que lo envía). `/cancel` solo cancela la conversación; la
bienvenida sigue gastada. `bot.deleteSubject(userId)` también rearma la
bienvenida del usuario borrado. `exportSubject` no incluye este dato.

## Triggers por tipo de mensaje

```ts
bot.when(MEDIA, (ctx) => ctx.reply('Recibí tu archivo'))     // image, video, audio, voice, document, sticker
bot.when(IMAGE, (ctx) => ctx.reply('Linda foto'))             // siempre gana a MEDIA
bot.when(VOICE_NOTE, (ctx) => ctx.reply('Recibí tu audio'))
bot.when(LOCATION, (ctx) => ctx.reply('Recibí tu ubicación'))
bot.use(flow(DOCUMENT).ask('¿Para qué es el documento?', 'motivo'))
bot.when(typeTrigger('image', 'video'), (ctx) => ctx.reply('¡Qué buena toma!'))  // combinación propia
bot.when({ ...IMAGE, scope: 'dm' }, (ctx) => ctx.reply('Solo en DM'))
```

| Constante | `ctx.type` |
| --- | --- |
| `MEDIA` | `image`, `video`, `audio`, `voice`, `document`, `sticker` |
| `IMAGE` / `VIDEO` / `DOCUMENT` / `STICKER` | el tipo correspondiente |
| `AUDIO` | solo `audio` (un archivo de audio, como `bot.onAudio`) |
| `VOICE_NOTE` | `voice` (nota de voz); para ambos usa `typeTrigger('audio', 'voice')` |
| `LOCATION` / `CONTACT` | `location` / `contact` |
| `POLL` | `poll`: alguien **creó** una encuesta. Los votos llegan por `bot.on('poll')` |
| `CALL` | `call`, ver [más abajo](#call) |

### Precedencia

Los matchers corren por especificidad (mayor primero; con empate gana el
registrado primero):

`WELCOME` (100) > igualdad / string (40) > `startsWith` (30) > `endsWith`
(25) > RegExp (20) > `contains` (10) > función predicado (5) > un tipo
(`IMAGE`..., `bot.onType`, `bot.onImage`) (2) > multi-tipo (`MEDIA`,
`typeTrigger(a, b)`) (1) > catch-all (`bot.onMessage`).

Un trigger de texto nunca queda tapado por uno de tipo: una imagen con el
caption "hola" la atiende `bot.when('hola')`. `bot.onImage()` y
`bot.when(IMAGE)` están en el mismo nivel.

## CALL

`CALL` reacciona a una llamada entrante de voz o video:

```ts
bot.when(CALL, (ctx) => ctx.reply('📵 No atiendo llamadas, escríbeme por aquí.'))
bot.use(flow(CALL).ask('Vi tu llamada, ¿en qué te ayudo?', 'need'))  // la conversación sigue en el chat
bot.when(CALL, (ctx) => { ctx.call?.status; ctx.call?.isVideo })      // CallEvent tipado
```

- Se dispara **una vez por id de llamada** (WhatsApp emite offer y luego
  ringing, reject, timeout o terminate). Para ver cada actualización,
  escucha `bot.on('call', (ev) => ...)`.
- El contexto tiene `type === 'call'`, `body === ''` y `ctx.call` (el
  `CallEvent`: `id`, `from`, `status` y, opcionales, `chatId`, `isGroup`,
  `isVideo` y `offline`). `ctx.reply()` le responde a quien llama.
  `react`/`quote`/`markRead`/`delete` no tienen sentido aquí.
- Una llamada 1:1 se trata como el DM de quien llama. Una **llamada de
  grupo** se proyecta en el grupo: las respuestas van al grupo,
  `ctx.sender` es quien llama, la conversación es por participante y se
  aplican `scope` y `groupMode`.
- Corre después de los hooks `before`/`after('call')` y del evento
  `'call'`. Un `before('call', (ev) => ev.abort())` lo suprime (junto con los
  hooks `after('call')` y el evento `'call'`). La blacklist, la whitelist y
  el gate de handoff se aplican **antes** de los hooks: una llamada
  bloqueada tampoco corre hooks `'call'` ni emite el evento `'call'`.
- Las llamadas nunca llegan a comandos, triggers de texto o de función,
  `onMessage` ni al evento `'message'`, y no se guardan como mensajes. Con
  el bot detenido se ignoran.
- Un trigger `CALL` que **inicia una conversación** nunca reemplaza una en
  curso: si quien llama ya tiene una conversación activa o un checkpoint
  dormido, corre el siguiente handler `CALL`. Los handlers simples
  `bot.when(CALL, fn)` sí corren a mitad de un flujo.
- `bot.onType('call', handler)` equivale a `bot.when(CALL, handler)`.
- Testing: `provider.call({ id: 'c1', from: 'user-1', status: 'offer' })` en
  `MockProvider` (`@botmesh/core/testing`).

Los flujos creados con `flow(WELCOME)` o con un trigger de tipo reciben un
id anónimo, así que `.persistent()` necesita un `.id('...')` explícito.

## Siguientes pasos

- [Conceptos básicos](./conceptos#el-pipeline-de-entrada): dónde corre cada trigger
- [Handoff y listas de acceso](./handoff)
- [Datos persistentes por usuario](./datos-usuario)
- [Iniciar un flujo desde código](./mensajes#iniciar-un-flujo-desde-codigo): `bot.trigger()` sin mensaje entrante
