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
await ctx.replyWithTyping('typing this out...') // muestra "escribiendo…" antes de enviar
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

- **`@bot-wa/baileys`** — los botones/listas interactivos nativos están
  muertos en el protocolo actual de WhatsApp Web, así que se degradan a un
  **menú de texto numerado**. Un menú numerado (`.choose()` en un flow, o
  `c.choose()` en una conversación — ver [Flujos](./flujos)) o una encuesta
  real suele leerse mejor.
- **`@bot-wa/meta`** (Cloud API) — botones/listas/templates nativos.
- **`@bot-wa/telegram`** — teclados inline nativos.

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
`UnsupportedContentError` tipado de `@bot-wa/core`.

## Reaccionar

```ts
await ctx.react('👍')
await ctx.react('❤️')
```

## Otras acciones

```ts
await ctx.markRead()   // marca el mensaje entrante como leído
await ctx.typing()     // muestra "escribiendo…"
await ctx.recording()  // muestra "grabando audio…"
await ctx.delete()     // elimina el mensaje entrante (si está permitido)
```

Las acciones se degradan a no-op en providers que no tienen la capacidad.

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
el voto cifrado ya no. Detalles en el README de `@bot-wa/baileys`.

## Acceder al contenido del media

`ctx.media` es un campo plano (no una promesa) presente siempre que el
mensaje entrante trae media:

```ts
bot.onImage(async (ctx) => {
  if (ctx.media) {
    console.log(ctx.media.mimetype)  // 'image/jpeg'
    console.log(ctx.media.buffer)    // Buffer
    console.log(ctx.media.size)      // bytes
  }
})
```

## El `MessageContext` completo

Además de los helpers de respuesta, cada handler recibe campos de datos en
`ctx`: `ctx.body`, `ctx.from` (id del chat), `ctx.sender` (id del usuario;
= `from` en DMs, participant en grupos), `ctx.senderInfo`, `ctx.pushName`,
`ctx.chat` (`{ id, kind, name?, isGroup, isBroadcast, participants? }`),
`ctx.type`, `ctx.isGroup` / `ctx.isPrivate` / `ctx.isFromMe`,
`ctx.mentions`, `ctx.quoted?`, `ctx.media?`, `ctx.timestamp`, `ctx.tools`
(registro de DI), `ctx.raw` (payload nativo del provider), `ctx.ref` (la
referencia al mensaje — `{ id, chatId, native? }`, reemplaza el `ctx.key`
de v1), `ctx.user` (el [perfil persistente](./datos-usuario) del remitente),
`ctx.handoff()` (pasar el chat a un [humano](./handoff)) y `ctx.call` (el
`CallEvent`, solo en contextos [`CALL`](./triggers#call)).

## Identidad por transporte

Cada provider resuelve los alias antes de emitir, así que `ctx.sender` es
el mismo para la misma persona (el contrato de identidad):

- **Baileys:** las formas LID y PN (teléfono) de un usuario se unen en un id
  canónico (el PN cuando se conoce). Lo usan los mensajes, las reacciones,
  los votos, las llamadas, los eventos de grupo y presencia, `ctx.mentions`
  y el propio `selfId` del bot, así que `groupMode: 'mentions'` funciona
  tanto si la mención usó el LID como el PN.
- **Cloud API (`@bot-wa/meta`):** los usuarios que activaron un **username**
  de WhatsApp pueden llegar sin teléfono, solo con un id propio de tu
  negocio (**BSUID**, p. ej. `US.13491208655302741918`). El provider
  mantiene un id estable por persona (el teléfono si se conoce y, si no, el
  BSUID), aprende los pares teléfono ↔ BSUID (persístelos con un
  `identityMap`) y envía a un BSUID con el campo `recipient` de forma
  automática. `senderInfo.username` y `senderInfo.platformData.bsuid` dan
  los detalles. Las plantillas de autenticación exigen teléfono: enviarlas a
  un BSUID falla con el error de Graph `131062`, mapeado a
  `UnsupportedContentError`. Ver el README de `@bot-wa/meta`.

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

`bot.trigger(name, { chatId, userId?, isGroup?, data?, ifActive? })` inicia un flujo
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
**empieza**, no cuando termina. `reason` es `'stopped' | 'blocked' | 'handoff' | 'busy'`.
Si el sujeto ya tiene una conversación activa o dormida, no se toca salvo con `ifActive: 'replace'`.
Puedes hacer `await bot.trigger(...)` desde un handler o comando del mismo chat sin problema: corre en el turno de ese mensaje.

## Métricas de runtime

`bot.metrics()` devuelve una foto en memoria: conversaciones (iniciadas, completadas,
canceladas, expiradas, sin reintentos, con error, activas, duración media) en total y
por flujo, mensajes de entrada y salida, descartes de entrada (duplicados, bloqueados,
handoff), triggers, errores y uptime. `bot.resetMetrics()` pone los contadores a cero.
`toPrometheus(snapshot, { prefix?, labels? })` la renderiza en formato de texto de Prometheus, sin dependencias:

```ts
import { toPrometheus } from '@bot-wa/core'

app.get('/metrics', (_req, res) => res.type('text/plain').send(toPrometheus(bot.metrics())))

bot.on('conversation:started', ({ id, name, chatId }) => { /* ... */ })
bot.on('conversation:ended', ({ id, name, chatId, outcome, durationMs }) => { /* ... */ })
```

`id` es único por instancia de conversación, así que sirve para emparejar cada `ended` con su `started`.
Cuando una conversación se reemplaza, su `ended` (`outcome: 'cancelled'`) se emite antes del `started` de la nueva.

## Siguientes pasos

- [Flujos conversacionales](./flujos) — conversaciones multi-paso
- [Ejemplos](/es/ejemplos/media) — recetas de media completas
