# Mensajes y media

Todo lo que puedes enviar y recibir.

## Helpers de respuesta (dentro de un handler)

Todos estos apuntan a `ctx.from` y devuelven `Promise<SentMessage>`.
`reply`, `say`, `answer` y `text` son alias equivalentes:

```ts
await ctx.reply('👋 Hello!')
await ctx.say('How are you?')          // alias
await ctx.answer('👍')                  // alias
await ctx.text('plain text')            // alias
await ctx.quote('replying to your message')     // cita el mensaje entrante
await ctx.reply('typing this out...', { typing: true }) // muestra "escribiendo…" antes de enviar
```

## Enviar foto

```ts
await ctx.photo('https://picsum.photos/400/300', '📸 caption')
await ctx.photo('./photo.jpg', 'caption')  // archivo local
await ctx.photo(buffer, 'caption')          // Buffer
```

## Enviar video

```ts
await ctx.video(url, 'caption')
await ctx.video(url, 'caption', { gifPlayback: true })  // GIF
await ctx.video(url, 'caption', { ptv: true })           // video circular
```

## Enviar audio y nota de voz

```ts
await ctx.audio(url)   // audio
await ctx.voice(url)   // nota de voz (PTT)
```

## Enviar archivo

```ts
await ctx.file(url, 'document.pdf', 'caption')
```

## Enviar sticker

```ts
await ctx.sticker(url, { pack: 'My Pack', author: 'me' })
```

## Enviar ubicación

```ts
await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
```

## Enviar contacto

```ts
await ctx.contact('573001234567', 'Support Bot')
```

## Botones: normalizados, degradados por transporte

`ctx.buttons(text, buttons)` envía contenido de botones normalizado. Cómo
aterriza depende del provider:

- **`@botmesh/baileys`** — los botones/listas interactivos nativos están
  muertos en el protocolo actual de WhatsApp Web, así que se degradan a un
  **menú de texto numerado**. Un menú numerado (`.choose()` en un flow, o
  `c.choose()` en una conversación — ver [Flujos](./flujos)) o una encuesta
  real suele leerse mejor.
- **`@botmesh/meta`** (Cloud API) — botones/listas/templates nativos.
- **`@botmesh/telegram`** — teclados inline nativos.

```ts
await ctx.buttons('Choose one', [
  { id: 'a', title: 'Option A' },
  { id: 'b', title: 'Option B' },
])

// Las encuestas son nativas en Baileys y Telegram. La Cloud API no tiene
// encuestas: ahí ctx.poll() rechaza con UnsupportedContentError — usa botones.
await ctx.poll('What do you prefer?', ['Option A', 'Option B'])

// Selección múltiple
await ctx.poll('What do you like?', ['🍕 Pizza', '🍔 Burger'], true)
```

Si un provider no puede honrar un tipo de contenido, `send` rechaza con un
`UnsupportedContentError` tipado de `@botmesh/core`.

## Indicador de escritura y pausas

`BotConfig.typing` muestra "escribiendo…" antes de cada respuesta de texto
enviada por `ctx` (`reply`/`say`/`answer`/`text`/`quote` y `.say` de los flujos).
Dura `longitud del texto / charsPerSecond`, acotado a `[minMs, maxMs]`. Viene
desactivado por defecto.

```ts
const bot = new Bot({ provider, typing: true }) // por defecto: { minMs: 800, maxMs: 3000, charsPerSecond: 20 }
const ajustado = new Bot({ provider, typing: { enabled: true, minMs: 500, maxMs: 2000 } })

// Por respuesta: cambia el indicador y/o espera antes
await ctx.reply('Un momento…', { typing: false })
await ctx.reply('Aquí está', { delay: '1.5s', typing: { maxMs: 1000 } })
```

- `typing: true` usa la temporización del bot, `typing: false` lo suprime y un
  objeto lo activa con esos cambios. Un `maxMs` por respuesta menor que el `minMs`
  del bot baja el mínimo en lugar de lanzar un error.
- `delay` (ms o `'500ms'`, `'1.5s'`) corre antes del indicador. `cancelIf: () => boolean`
  se comprueba después de la espera: si devuelve `true`, la respuesta se descarta.
- Si el indicador falla, el envío no falla: es cosmético y best effort.
- En providers sin `capabilities.typing` no hay indicador **ni espera**. `delay` se respeta en todos.
- Una respuesta en espera se descarta (resuelve `{ skipped: true }`) si el bot se detiene, el chat pasa a handoff o el flujo se aborta durante la espera. `stop({ drain: true })` espera a esas respuestas.
- `ctx.replyWithTyping(texto, msPorCaracter?)` está **obsoleto**: marca su propio ritmo (40 ms
  por carácter por defecto) e ignora `BotConfig.typing`. Usa `ctx.reply(texto, { typing: true })`.

Las respuestas largas o generadas por IA se pueden enviar por partes en lugar de
de una vez: ve [Streaming](./streaming).

## Editar un mensaje

```ts
const msg = await ctx.reply('Procesando…')
await ctx.edit('Listo ✅')                       // edita la última respuesta de este mismo contexto
await ctx.edit(msg.ref, 'Listo ✅')              // edita un mensaje concreto
await ctx.edit('Listo ✅', { fallback: 'skip' }) // nunca envía un mensaje nuevo
```

`ctx.edit(contenido)` solo apunta a la última respuesta enviada por **este mismo
contexto** (esta ejecución del handler, o este flujo) y solo si es del mismo tipo
de contenido. Nunca edita respuestas a un mensaje anterior, respuestas del flujo
de otro participante en un grupo ni una respuesta seguida de un
`bot.send`/`bot.sendTo` al chat. El resultado trae `edited: true` cuando el
provider editó el mensaje en el sitio.

Si el provider no puede editar (sin `capabilities.edit`, un tipo de contenido que
no admite edición o nada que editar), `ctx.edit` envía el contenido como **mensaje
nuevo** en el chat del mensaje editado (`ref.chatId`), o no envía nada con
`{ fallback: 'skip' }`. Las ediciones pasan por los hooks `before`/`after('send')`
(el payload lleva `edit: ref`, ver [Hooks](./hooks#ediciones-y-salida-en-streaming)) y actualizan el registro de salida.

## Reaccionar

```ts
await ctx.react('👍')
await ctx.react('❤️')
await ctx.react('🔥', msg.ref) // reacciona a otro mensaje
await ctx.react('')            // quita la reacción, donde el transporte lo permite
```

En providers que no pueden enviar reacciones, `ctx.react` resuelve
`{ skipped: true }` en lugar de rechazar.

## Soporte por transporte

`ctx.supports(feature)` devuelve `'native'`, `'degraded'` o `'unsupported'` para
`'typing'`, `'delay'`, `'edit'` y `'react'`:

| Transporte | typing | delay | edit | react |
| --- | --- | --- | --- | --- |
| WhatsApp (Baileys) | nativo | nativo | degradado (mensaje nuevo) | nativo |
| WhatsApp Cloud API | no soportado | nativo | degradado (mensaje nuevo) | nativo |
| Messenger | nativo | nativo | degradado (mensaje nuevo) | no soportado (skipped) |
| Instagram | nativo | nativo | degradado (mensaje nuevo) | no soportado (skipped) |
| Telegram | nativo | nativo | nativo | nativo |
| Discord | nativo | nativo | nativo | nativo |

## Otras acciones

```ts
await ctx.markRead()   // marca el mensaje entrante como leído
await ctx.typing()     // muestra "escribiendo…"
await ctx.recording()  // muestra "grabando audio…"
await ctx.delete()     // elimina el mensaje entrante (si está permitido)
```

Las acciones se degradan a no-op en providers que no tienen la capacidad.
`ctx.typing()` y `ctx.recording()` son *best-effort*: nunca rechazan. Si el
provider no puede mostrar el indicador, el error se registra en `debug` y el
handler sigue, así que un indicador fallido nunca cuesta la respuesta siguiente.

## Recibir media

```ts
bot.onImage(async (ctx) => { await ctx.reply('📸 Got your image!') })
bot.onAudio(async (ctx) => { await ctx.reply('🎵 Got your audio') })
bot.onVideo(async (ctx) => { await ctx.reply('🎬 Got your video') })
bot.onSticker(async (ctx) => { await ctx.reply('🎨 Got your sticker!') })
bot.onDocument(async (ctx) => { await ctx.reply('📄 Got your file') })
bot.onLocation(async (ctx) => { await ctx.reply('📍 Got your location') })
bot.onContact(async (ctx) => { await ctx.reply('👤 Got your contact') })
bot.onPoll(async (ctx) => { await ctx.reply('📊 Got your poll') })
```

`onImage`/`onAudio`/etc. son matchers de baja especificidad: un
`bot.when(...)` más específico que también coincida gana primero, a menos
que llame a `ctx.pass()`. El mismo nivel está disponible como constantes de
trigger (`IMAGE`, `VOICE_NOTE`, `MEDIA`, `LOCATION`, `CALL`...): ver
[Triggers especiales](./triggers).

## Recibir una ubicación

Una ubicación compartida llega con `ctx.type === 'location'` y sus
coordenadas normalizadas en `ctx.sharedLocation` (no en `ctx.location`, que
**envía** una):

```ts
bot.onLocation(async (ctx) => {
  const loc = ctx.sharedLocation
  if (!loc) return ctx.reply('No pude leer esa ubicación')
  await ctx.reply(`📍 ${loc.latitude}, ${loc.longitude}${loc.name ? ` (${loc.name})` : ''}`)
})
```

`sharedLocation` es `{ latitude, longitude, name?, address?, live? }` (grados
decimales WGS84; `live: true` en el primer mensaje de una ubicación en tiempo
real). `ctx.body` conserva el nombre del lugar o la dirección (o `''`), así que
los triggers de texto siguen funcionando. La rellenan: WhatsApp vía Baileys
(pines y ubicación en tiempo real), WhatsApp Cloud API, Telegram (pines,
ubicación en tiempo real y lugares/venues), Messenger e Instagram (cuando Meta
envía coordenadas), Evolution API y WPPConnect (pines y ubicación en tiempo
real), Gupshup y Twilio (`Latitude`/`Longitude`). Discord y HighLevel no reciben
ubicaciones. En otros canales, o si el transporte no trae coordenadas,
`ctx.type` sigue siendo `'location'` pero `sharedLocation` es `undefined`. Si
escribes un provider, mapea el payload con
`toInboundLocation({ latitude, longitude, name, address, live })` de
`@botmesh/core`, que descarta coordenadas ausentes o fuera de rango.

Dentro de una conversación, `c.waitLocation(opts?)` espera una y resuelve con
el `InboundLocation`; cualquier otra cosa vuelve a pedirla con `otherwise` (por
defecto, el texto localizado `core.wait.location`). El mensaje entrante
guardado también la conserva (`StoredMessage.location`).

```ts
bot.conversation('envio', async (c) => {
  await c.say('Comparte la ubicación de entrega 📍')
  const loc = await c.waitLocation({ timeout: '5m' })
  await c.say(`Entregamos en ${loc.latitude}, ${loc.longitude}`)
})
```

## Votos de encuestas

`ctx.poll(pregunta, opciones, multiSelect?)` envía una encuesta nativa. Los
votos llegan por el evento `poll` con el recuento completo y actual:

```ts
await ctx.poll('¿Pizza o sushi?', ['Pizza', 'Sushi'])

bot.on('poll', (vote) => {
  // vote.ref.id      → id del mensaje de la encuesta
  // vote.ref.chatId  → chat donde se votó (el mismo chatId que usan sus mensajes)
  // vote.senderId    → quien acaba de votar, con el id canónico de sus mensajes
  // vote.options     → recuento actual: [{ name, votes, voters }]
  const elegidas = vote.options.filter((o) => o.voters?.includes(vote.senderId)).map((o) => o.name)
  console.log(elegidas.length ? `Eligió: ${elegidas.join(', ')}` : 'Retiró su voto')
})
```

En **Baileys**, WhatsApp cifra cada voto de extremo a extremo; el provider
lo descifra por su cuenta. Recuerda las 500 encuestas más recientes que vio
(las del bot y las que crean otros en los chats que escucha), solo acepta
un voto que llega por el chat de la encuesta y nombra a su creador, guarda
el último voto de cada persona y cuenta cada mensaje de voto una sola vez
(la re-entrega offline de Baileys no se vuelve a emitir). Límites: solo se
descifran las encuestas que vio **este proceso** (tras un reinicio, los
votos de encuestas anteriores se descartan con un log `debug`) y el bot no
puede votar. Una encuesta que crea otra persona sigue llegando como mensaje
`poll` (`bot.onPoll`, el [trigger `POLL`](./triggers#triggers-por-tipo-de-mensaje));
el voto cifrado ya no. Detalles en el README de `@botmesh/baileys`.

## Acceder al contenido del media

El media entrante se descarga de forma **perezosa**: el contexto solo lleva una
referencia hasta que pides los bytes con `loadMediaOf(ctx)`. Descarga una sola vez
a través del provider y guarda el resultado en `ctx.media`:

```ts
import { loadMediaOf, MediaTooLargeError } from '@botmesh/core'

bot.onImage(async (ctx) => {
  try {
    const media = await loadMediaOf(ctx, { maxBytes: 5 * 1024 * 1024 })
    if (!media) return                 // sin media, o la descarga falló
    console.log(media.mimetype)        // 'image/jpeg'
    console.log(media.buffer)          // Buffer
    console.log(media.size)            // bytes, si el provider los declaró
    // ctx.media ya es el mismo payload
  } catch (err) {
    if (err instanceof MediaTooLargeError) await ctx.reply('Ese archivo es demasiado grande')
    else throw err
  }
})
```

- Resuelve `undefined` si el mensaje no trae media, el provider no puede
  descargar o (por defecto) la descarga falla. `{ throwOnError: true }` rechaza
  con el error de la descarga.
- `maxBytes` se compara con el tamaño que declaró el provider, antes de descargar
  nada, y otra vez mientras se lee; la descarga se corta en cuanto lo supera.
  Rechaza con `MediaTooLargeError` (un `PayloadTooLargeError`, con `bytes` y
  `maxBytes`).
- Llámalo en un hook `before('message')` para descargar antes del enrutado; así
  transcribe las notas de voz el plugin de [voz](./voz).

## El `MessageContext` completo

Además de los helpers de respuesta, cada handler recibe campos de datos en
`ctx`: `ctx.body`, `ctx.from` (id del chat), `ctx.sender` (id del usuario;
= `from` en DMs, participant en grupos), `ctx.senderInfo`, `ctx.pushName`,
`ctx.chat` (`{ id, kind, name?, isGroup, isBroadcast, participants? }`),
`ctx.type`, `ctx.isGroup` / `ctx.isPrivate` / `ctx.isFromMe`,
`ctx.mentions`, `ctx.quoted?`, `ctx.media?` (tras `loadMediaOf`), `ctx.timestamp`, `ctx.tools`
(registro de DI), `ctx.raw` (payload nativo del provider), `ctx.ref` (la
referencia al mensaje — `{ id, chatId, native? }`, reemplaza el `ctx.key`
de v1), `ctx.user` (el [perfil persistente](./datos-usuario) del remitente),
`ctx.handoff()` (pasar el chat a un [humano](./handoff)), `ctx.call` (el
`CallEvent`, solo en contextos [`CALL`](./triggers#call)) y los miembros de
[i18n](./i18n) `ctx.lang`, `ctx.langSource`, `ctx.t()` y `ctx.setLang()`.

## Identidad por transporte

Cada provider resuelve los alias antes de emitir, así que `ctx.sender` es
el mismo para la misma persona (el contrato de identidad):

- **Baileys:** las formas LID y PN (teléfono) de un usuario se unen en un id
  canónico (el PN cuando se conoce). Lo usan los mensajes, las reacciones,
  los votos, las llamadas, los eventos de grupo y presencia, `ctx.mentions`
  y el propio `selfId` del bot, así que `groupMode: 'mentions'` funciona
  tanto si la mención usó el LID como el PN.
- **Cloud API (`@botmesh/meta`):** los usuarios que activaron un **username**
  de WhatsApp pueden llegar sin teléfono, solo con un id propio de tu
  negocio (**BSUID**, p. ej. `US.13491208655302741918`). El provider
  mantiene un id estable por persona (el teléfono si se conoce y, si no, el
  BSUID), aprende los pares teléfono ↔ BSUID (persístelos con un
  `identityMap`) y envía a un BSUID con el campo `recipient` de forma
  automática. `senderInfo.username` y `senderInfo.platformData.bsuid` dan
  los detalles. Las plantillas de autenticación exigen teléfono: enviarlas a
  un BSUID falla con el error de Graph `131062`, mapeado a
  `UnsupportedContentError`. Ver el README de `@botmesh/meta`.

## Enviar fuera de un handler

Para escribirle a alguien sin esperar a que escriba primero — p. ej. desde
una [tarea programada](./scheduler) — usa la instancia del bot directamente.
El contenido es la unión etiquetada neutral de transporte (`{ kind, ... }`):

```ts
await bot.sendText('573001234567@s.whatsapp.net', '🌅 Good morning!')
await bot.send('573001234567@s.whatsapp.net', {
  kind: 'image',
  media: { url },
  caption: 'hi',
})
await bot.sendTo(chatId, 'Hola, soy Ana de soporte')  // mismo camino; un string se envía como texto
```

## Difusiones (broadcast)

`bot.broadcast(chatIds, content, options?)` envía un mismo contenido (un string se
envía como texto) a muchos chats, por lotes, sin bloquear las colas de entrada de cada chat:

```ts
const ac = new AbortController()
const res = await bot.broadcast(chatIds, '🎉 ¡Nueva promo!', {
  batchSize: 10,          // chats por lote (default 10)
  delayBetween: '2s',     // pausa entre lotes (ms o '2s', '1m'; default 0)
  concurrency: 1,         // envíos en paralelo por lote (default 1)
  maxRetries: 3,          // reintentos por chat tras un RateLimitedError (default 3)
  onProgress: (done, total) => bot.logger.info(`${done}/${total}`),
  onFail: (chatId, error) => bot.logger.warn({ chatId, err: error }, 'broadcast falló'),
  signal: ac.signal,      // aborta para parar antes
})
// → { total, sent, failed, skipped, errors: [{ chatId, error }], messages, cancelled, pending }
```

- Un `RateLimitedError` pausa a **todos** los workers durante su `retryAfterMs` y reintenta ese chat.
- Los demás errores se anotan en `errors` y la difusión sigue; nunca rechaza por el fallo de un chat.
- Abortar `signal` o llamar a `bot.stop()` impide nuevos envíos; los chats sin intentar vuelven en `pending` (`cancelled: true`).
- Los ids duplicados se envían una vez; los envíos que omite un hook `before('send')` cuentan como `skipped`.

::: warning Cambio incompatible
`sent` y `failed` ahora son **contadores**. Los envíos aceptados pasaron a `messages` y los fallos a `errors`.
:::

Desde un handler, lánzala con `void bot.broadcast(...)` para no retener la cola de ese chat.

## Iniciar un flujo desde código

`bot.trigger(name, { chatId, userId?, isGroup?, data?, ifActive?, body? })` inicia un flujo
registrado o una `bot.conversation` para alguien que no ha escrito: recordatorios,
webhooks, paneles de administración. `data` inicializa `c.state`:

```ts
bot.schedule('0 9 * * *', async () => {
  for (const cita of await db.citasDeHoy()) {
    await bot.trigger('recordatorio', { chatId: cita.chatId, data: { hora: cita.hora } })
  }
})
```

Pasa por las listas de acceso, el gate de handoff humano y la cola FIFO del chat.
Resuelve `{ started, name, chatId, userId, reason? }` en cuanto la conversación
**empieza**, no cuando termina (para eso, escucha `'conversation:ended'`). `reason` es
`'stopped' | 'blocked' | 'handoff' | 'busy'`; un `name` desconocido rechaza.
Si el sujeto ya tiene una conversación activa o dormida, no se toca salvo con `ifActive: 'replace'`.
Puedes hacer `await bot.trigger(...)` desde un handler o comando del mismo chat sin problema: corre en el turno de ese mensaje.

- `userId` (por defecto, `chatId`) e `isGroup` apuntan a un participante de un grupo;
  `body` fija el `ctx.body` del mensaje sintético (por defecto `''`).
- No corren hooks `before('message')`, matchers ni el evento `'message'`, y no se
  persiste nada del mensaje sintético (`ctx.raw` es `{ synthetic: 'trigger', name }`).
- `bot.triggerFlow(id, { chatId, userId?, isGroup? }, { data?, body? })` es un envoltorio
  fino con `ifActive: 'replace'` que resuelve `true`/`false` y rechaza con el bot detenido
  (`state` es un alias obsoleto de `data`).

## Métricas de runtime

`bot.metrics()`, `bot.resetMetrics()`, el exportador de Prometheus `toPrometheus()` y
los eventos `'conversation:started'` / `'conversation:ended'` se documentan en
[Operación](./operations#metricas-de-runtime).

## Siguientes pasos

- [Flujos conversacionales](./flujos) — conversaciones multi-paso
- [Streaming](./streaming) — respuestas largas y de IA, por partes
- [Canales](./canales) — qué soporta cada transporte
- [Operación](./operations) — métricas y eventos de conversación
- [Ejemplos](/es/ejemplos/media) — recetas de media completas
