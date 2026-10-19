# Canales (providers)

El motor del bot (`@bot-wa/core`) no conoce ningún transporte. Un
**provider** lo conecta a un canal: recibe los eventos del canal, los
convierte en `InboundEvent` neutros y envía `OutboundContent` de vuelta. Los
mismos flujos, triggers y plugins funcionan en todos los canales; solo cambia
el constructor.

```ts
import { Bot } from '@bot-wa/core'

const bot = new Bot({ provider }) // cualquiera de los providers de abajo
```

Esta página recoge todos los providers del repositorio, cómo recibe eventos
cada uno y qué puede y qué no puede hacer.

## Estado: públicos y experimentales

| Paquete | Directorio | Estado | Transporte |
| --- | --- | --- | --- |
| `@bot-wa/baileys` | `baileys-provider` | Público | WhatsApp Web (socket de Baileys) |
| `@bot-wa/meta` | `meta-provider` | Público | WhatsApp Cloud API (oficial) |
| `@bot-wa/telegram` | `telegram-provider` | Público | Telegram Bot API |
| `@bot-wa/messenger` | `messenger-provider` | Experimental | Facebook Messenger (Send API) |
| `@bot-wa/instagram` | `instagram-provider` | Experimental | DMs de Instagram (Messenger API for Instagram) |
| `@bot-wa/discord` | `discord-provider` | Experimental | Discord (gateway + REST) |
| `@bot-wa/evolution` | `evolution-provider` | Experimental | Evolution API v2 (gateway de WhatsApp self-hosted) |
| `@bot-wa/wppconnect` | `wppconnect-provider` | Experimental | WPPConnect Server (gateway de WhatsApp self-hosted) |
| `@bot-wa/twilio` | `twilio-provider` | Experimental | Twilio Programmable Messaging (WhatsApp + SMS/MMS) |
| `@bot-wa/gohighlevel` | `gohighlevel-provider` | Experimental | HighLevel (LeadConnector) Conversations API |
| `@bot-wa/gupshup` | `gupshup-provider` | Experimental | Gupshup WhatsApp API |
| `@bot-wa/email` | `email-provider` | Experimental | Email (IMAP IDLE + SMTP) |
| `@bot-wa/tiktok` | `tiktok-provider` | Experimental | TikTok API for Business (comentarios + Business Messaging) |

Los paquetes **públicos** se instalan con `pnpm add`. Los **experimentales**
llevan `"private": true` en su `package.json`: están implementados y con
tests, pero **no se publican en npm** y su API puede cambiar. Úsalos desde
este monorepo (`"workspace:*"`).

## Elegir un canal

**WhatsApp** tiene varias opciones:

- **`@bot-wa/baileys`**: vincula el bot como un dispositivo de WhatsApp Web
  (QR o código de emparejamiento) y abre su propio socket. Sin servidor
  público ni webhook, con grupos y encuestas, sin coste por mensaje. Es un
  cliente **no oficial**: automatizar una cuenta puede infringir los términos
  de WhatsApp y acabar en el bloqueo del número. Deja activado el
  [rate limiter](/es/guide/rate-limiting).
- **`@bot-wa/meta`**: la WhatsApp Cloud API oficial. Botones, listas,
  plantillas y [formularios con WhatsApp Flows](/es/guide/formularios)
  nativos, sin riesgo de baneo. Necesita un webhook HTTPS público, no tiene
  grupos y los mensajes libres solo funcionan dentro de la
  [ventana de atención de 24 horas](/es/guide/ventana-24h).
- **`@bot-wa/evolution`** / **`@bot-wa/wppconnect`**: ya tienes desplegado un
  Evolution API o un WPPConnect Server. El bot habla con ese gateway por REST
  y recibe sus webhooks. Ambos gateways manejan WhatsApp Web, así que valen
  las mismas advertencias que con Baileys (no oficial, sin botones nativos
  fiables).
- **`@bot-wa/twilio`** / **`@bot-wa/gupshup`**: envías WhatsApp a través de
  la cuenta de ese proveedor. Admiten plantillas; Twilio cubre además SMS/MMS
  con la misma clase.
- **`@bot-wa/gohighlevel`**: el bot responde a los contactos del CRM
  HighLevel por el canal que usaron (SMS, WhatsApp, Email, Facebook,
  Instagram, Live chat...).

**Otros canales:** `@bot-wa/telegram` (long polling por defecto, webhook
opcional), `@bot-wa/discord` (socket del gateway), `@bot-wa/messenger` e
`@bot-wa/instagram` (webhooks de Meta), `@bot-wa/email` (cada hilo de correo
es un chat) y `@bot-wa/tiktok` (comentarios en tus propios videos y DMs).

### Socket, polling o webhook

- **Socket / polling** (el provider abre la conexión): Baileys, Discord,
  Telegram en modo polling, Email (IMAP IDLE). No hay nada que exponer a
  internet.
- **Webhook** (`capabilities.pushIngress: true`): Cloud API, Messenger,
  Instagram, Telegram en modo webhook, Evolution, WPPConnect, Twilio,
  HighLevel, Gupshup, TikTok. **Tu** servidor HTTP recibe el POST y le pasa
  el **body crudo** y las cabeceras a `provider.ingest()`, que verifica la
  firma o el token y devuelve el status HTTP con el que responder.
  [`@bot-wa/server`](/es/guide/servidor) resuelve ese cableado (body crudo,
  límites de tamaño, timeouts, endpoints de salud) para `node:http`, Express,
  Fastify y Hono.

El constructor de todo provider por webhook (Telegram, solo en modo webhook)
**lanza un error** si falta su credencial de webhook (app secret, auth token o token compartido), salvo que
pases `allowUnsignedWebhooks: true`, pensado solo para desarrollo local
aislado. HighLevel es la excepción: su clave pública de firma viene incluida.

## Matriz de capacidades

Los valores salen de la declaración `capabilities` de cada provider. Una
función marcada "no" se **degrada, no se rompe**: los botones y las listas
pasan a un menú de texto numerado, `ctx.edit` envía un mensaje nuevo,
`ctx.react` resuelve `{ skipped: true }` y `ctx.typing` no hace nada (ver
[Mensajes y media](/es/guide/mensajes#soporte-por-transporte)).

| Provider | Entrada | Botones | Listas | Encuestas | Enviar reacciones | Editar | Escribiendo | Confirmación de lectura | Grupos | Plantillas | `ctx.stream` | Formularios |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baileys | socket | no | no | sí | sí | no | sí | sí | sí | no | fragmentos | campo a campo |
| Cloud API (`meta`) | webhook | sí | sí | no | sí | no | no | sí | no | sí | fragmentos | nativo (WhatsApp Flows) |
| Telegram | polling o webhook | sí | no (teclado inline) | sí | sí | sí | sí | no | sí | no | borrador | campo a campo |
| Messenger | webhook | sí | sí | no | no | no | sí | sí | no | no | fragmentos | campo a campo |
| Instagram | webhook | sí (quick replies) | no | no | no | no | sí | sí | no | no | fragmentos | campo a campo |
| Discord | socket | sí | sí | sí | sí | sí | sí | no | sí | no | edición | campo a campo |
| Evolution | webhook | no | no | sí | sí | sí | sí | sí | sí | no | fragmentos | campo a campo |
| WPPConnect | webhook | no | no | sí | sí | sí | sí | sí | sí | no | fragmentos | campo a campo |
| Twilio | webhook | no | no | no | no | no | sí (solo WhatsApp) | no | no | sí | fragmentos | campo a campo |
| HighLevel | webhook | no | no | no | no | no | no | sí | no | sí | fragmentos | campo a campo |
| Gupshup | webhook | sí | sí | no | no | no | no | no | no | sí | fragmentos | campo a campo |
| Email | IMAP IDLE (o `ingest()`) | no | no | no | no | no | no | no | no | no | fragmentos | campo a campo |
| TikTok | webhook | sí (de 1 a 3, DMs; más → texto numerado) | sí (hasta 3 filas, DMs; más → texto numerado) | no | no | no | sí (DMs) | sí (DMs) | no | no | fragmentos | campo a campo |

- **Enviar reacciones** solo describe el envío. Varios providers reciben
  igualmente reacciones como eventos `reaction` (Messenger, Instagram,
  Gupshup, TikTok...).
- **`ctx.stream`**: `borrador` = vistas previas nativas en borrador y un
  mensaje final (chats privados de Telegram; ediciones en el resto),
  `edición` = un mensaje que se edita a medida que crece el texto,
  `fragmentos` = sin vista previa en vivo, mensajes del tamaño de una frase
  con indicador de escritura (`streaming: 'none'`). Ver [Respuestas en streaming](/es/guide/streaming).
- **Formularios**: `nativo` envía `flow().form()` como un WhatsApp Flow;
  `campo a campo` pregunta cada campo con mensajes de texto.
- **`textFormat`** (no es columna): el formato de texto que muestra el canal,
  para que quien genere Markdown, como `@bot-wa/ai`, lo convierta.
  `'whatsapp'` (`*negrita*`, `_cursiva_`, `~tachado~`): Baileys, Cloud API,
  Evolution, WPPConnect, Gupshup. `'plain'` (sin formato): Telegram (se envía
  sin `parse_mode`), Messenger, Instagram, TikTok. `'markdown'`: Discord. Sin
  declarar: Email. Los providers que sirven varios canales deciden por chat con
  el método opcional `textFormatFor(chatId)`, que gana a
  `capabilities.textFormat` y llega a los handlers como `ctx.textFormat`:
  Twilio devuelve `'whatsapp'` en los chats `whatsapp:` y `'plain'` en SMS;
  HighLevel sigue el canal de respuesta del contacto (`'whatsapp'` en WhatsApp,
  `'plain'` en SMS, Email, FB, IG, Live chat, GMB y custom).
- **Plantillas** es el tipo de contenido `template`: plantillas de la Cloud
  API, Content Templates de Twilio (`ContentSid`), `templateId` de HighLevel,
  plantillas de Gupshup. El resto de providers lo rechaza con
  `UnsupportedContentError`.
- Todos los providers salvo Baileys aceptan el tipo de contenido `native`
  (`ctx.sendNative('<id del provider>', payload)`) como vía de escape a la API
  propia del canal, con un payload específico de cada provider. Baileys lo
  rechaza con `UnsupportedContentError`.

## Providers

### `@bot-wa/baileys`

WhatsApp Web a través de [Baileys](https://github.com/WhiskeySockets/Baileys).
Se vincula con un código QR (o `pairingCode`) y guarda la sesión en
`sessionsDir`.

```ts
import { BaileysProvider } from '@bot-wa/baileys'

const provider = new BaileysProvider({ session: 'my-bot' })
```

- Socket propio del provider, con reconexión y backoff.
- Las formas LID y número de teléfono de un usuario se unen en un único
  `senderId` estable.
- Sin botones ni listas nativos (WhatsApp Web los retiró): usa menús
  `choose()` o `ctx.poll()`.
- El rate limiting anti-baneo de envíos está activado por defecto
  (`rateLimit`).

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/baileys-provider)

### `@bot-wa/meta` (WhatsApp Cloud API)

La API oficial. Funciona por webhook: handshake GET con `verifyChallenge()`
y eventos POST con `ingest()`.

```ts
import { CloudAPIProvider } from '@bot-wa/meta'

const provider = new CloudAPIProvider({
  accessToken: process.env.META_TOKEN!,        // system-user token
  phoneNumberId: process.env.META_PHONE_ID!,
  verifyToken: process.env.META_VERIFY_TOKEN!, // the one you set in Meta
  appSecret: process.env.META_APP_SECRET!,     // verifies X-Hub-Signature-256
})
```

- Botones de respuesta nativos (máximo 3), listas, plantillas y formularios
  con WhatsApp Flows.
- Los usuarios con username de WhatsApp pueden llegar con un BSUID en lugar
  del teléfono; el provider mantiene un id estable por persona
  (`identityMap`).
- Fuera de la ventana de 24 h los envíos libres rechazan con
  `OutsideSessionWindowError`. El gestor opcional `sessionWindow` reabre el
  chat con una plantilla y reintenta: ver
  [Ventana de 24 h y costos](/es/guide/ventana-24h).
- La API no tiene grupos, indicador de escritura ni encuestas;
  `deleteMessage` no hace nada.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/meta-provider)

### `@bot-wa/telegram`

Telegram Bot API. Long polling por defecto; `polling: false` cambia a modo
webhook, donde `webhookSecret` es obligatorio.

```ts
import { TelegramProvider } from '@bot-wa/telegram'

const provider = new TelegramProvider({ token: process.env.TELEGRAM_TOKEN! })

// Webhook mode: the same secret goes to setWebhook (secret_token)
const hooked = new TelegramProvider({
  token: process.env.TELEGRAM_TOKEN!,
  polling: false,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
})
```

- Teclados inline, encuestas nativas, reacciones y edición de mensajes.
- `ctx.stream()` usa borradores nativos en chats privados y ediciones en el
  resto.
- En modo webhook `ingest()` parsea un **string** JSON (o un objeto): con
  `@bot-wa/server` móntalo con `body: 'text'`.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/telegram-provider)

### `@bot-wa/messenger` (experimental)

Facebook Messenger a través del Send API de Graph, con la misma verificación
de webhook que la Cloud API.

```ts
import { MessengerProvider } from '@bot-wa/messenger'

const provider = new MessengerProvider({
  accessToken: process.env.FB_PAGE_TOKEN!, // Page access token (pages_messaging)
  verifyToken: process.env.META_VERIFY_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
})
```

- Botones y listas nativos; las reacciones llegan pero no se pueden enviar.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/messenger-provider)

### `@bot-wa/instagram` (experimental)

DMs de una cuenta profesional de Instagram conectada a una Página de
Facebook (Messenger API for Instagram).

```ts
import { InstagramProvider } from '@bot-wa/instagram'

const provider = new InstagramProvider({
  accessToken: process.env.FB_PAGE_TOKEN!, // token of the connected Page
  verifyToken: process.env.META_VERIFY_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
})
```

- Los botones salen como quick replies; las listas se degradan a texto
  numerado.
- Solo DMs (sin grupos); las reacciones llegan pero no se pueden enviar.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/instagram-provider)

### `@bot-wa/discord` (experimental)

Gateway de Discord (WebSocket) para los eventos y REST para enviar.

```ts
import { DiscordProvider, GatewayIntents } from '@bot-wa/discord'

const provider = new DiscordProvider({ token: process.env.DISCORD_TOKEN! })
// Default intents: Guilds | GuildMessages | MessageContent.
// Add GatewayIntents.DirectMessages to the `intents` bitmask to receive DMs.
```

- Botones, menús de selección, encuestas, reacciones y ediciones nativos;
  `ctx.stream()` edita un mensaje a medida que crece el texto.
- Las interacciones tienen un plazo estricto de confirmación
  (`interactionsRequireAck`).

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/discord-provider)

### `@bot-wa/evolution` (experimental)

[Evolution API](https://github.com/EvolutionAPI/evolution-api) v2, un
gateway REST de WhatsApp self-hosted construido sobre Baileys. Salida: REST
con la cabecera `apikey`. Entrada: el webhook de la instancia, autenticado con
un secreto compartido en cabecera o con el `jwt_key` de Evolution (JWT HS256).

```ts
import { EvolutionProvider } from '@bot-wa/evolution'

const provider = new EvolutionProvider({
  baseUrl: 'http://localhost:8080',
  apiKey: process.env.EVOLUTION_API_KEY!,
  instance: 'my-instance',
  webhookSecret: process.env.EVOLUTION_WEBHOOK_SECRET!, // or webhookJwtKey
})
// POST /webhook/evolution → res.sendStatus(provider.ingest(body, headers))
```

- `start()` comprueba la instancia; si no está vinculada, el QR o el código
  de emparejamiento llega en la actualización `connection` (`authPayload`).
- Los gemelos LID/PN que envía Evolution se enlazan antes de emitir; pasa
  `identityPersistence` para mantener los ids estables entre reinicios.
- Encuestas, reacciones, edición (texto), escribiendo y confirmaciones de
  lectura; botones, listas y cards se degradan a texto numerado; `template`
  se rechaza.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/evolution-provider)

### `@bot-wa/wppconnect` (experimental)

[WPPConnect Server](https://github.com/wppconnect-team/wppconnect-server), un
gateway self-hosted sobre WhatsApp Web (WA-JS). REST con token Bearer;
webhooks autenticados con un token en la URL del webhook.

```ts
import { WPPConnectProvider } from '@bot-wa/wppconnect'

const provider = new WPPConnectProvider({
  baseUrl: 'http://localhost:21465',
  session: 'my-bot',
  secretKey: process.env.WPP_SECRET_KEY!,       // or token: '<generated bearer>'
  webhookToken: process.env.WPP_WEBHOOK_TOKEN!, // webhook URL: …/webhooks/wpp?token=<it>
})
// POST /webhooks/wpp → res.sendStatus(await provider.ingest(body, headers, req.originalUrl))
```

- `ingest()` es **asíncrono** y recibe la URL de la petición como tercer
  argumento, porque wppconnect-server no puede añadir cabeceras: el token
  viaja en la query string.
- Los LID desconocidos se resuelven a número de teléfono (`contact/pn-lid`)
  antes de emitir.
- `markRead` marca el chat entero como leído; botones y listas se degradan a
  texto numerado.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/wppconnect-provider)

### `@bot-wa/twilio` (experimental)

Twilio Programmable Messaging: **WhatsApp y SMS/MMS** con una sola clase.
Webhooks verificados con `X-Twilio-Signature`, que cubre la URL pública
exacta.

```ts
import { TwilioProvider } from '@bot-wa/twilio'

const provider = new TwilioProvider({
  accountSid: process.env.TWILIO_SID!,
  authToken: process.env.TWILIO_TOKEN!,           // signs webhooks + REST auth
  whatsappFrom: 'whatsapp:+14155238886',
  smsFrom: '+15017122661',
  webhookUrl: 'https://bot.example.com/twilio/webhook', // EXACT URL set in Twilio
})
```

- `chatId` es el `From` de Twilio tal cual (`whatsapp:+57…` o `+57…`): la
  misma persona por WhatsApp y por SMS son dos chats.
- Texto de hasta 1600 caracteres; media solo desde URLs públicas; botones y
  listas pasan a texto numerado; `template` se traduce a `ContentSid` +
  `ContentVariables`.
- `ingestRequest({ url, body, headers })` para URLs que cambian por petición
  (multi-tenant).
- El error 63016 se traduce a `OutsideSessionWindowError`.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/twilio-provider)

### `@bot-wa/gohighlevel` (experimental)

HighLevel (GoHighLevel / LeadConnector) Conversations API. Entrada por el
webhook `InboundMessage` (Ed25519, `X-GHL-Signature`), salida con
`POST /conversations/messages` por el último canal que usó el contacto.

```ts
import { GoHighLevelProvider } from '@bot-wa/gohighlevel'

const provider = new GoHighLevelProvider({
  accessToken: process.env.GHL_TOKEN!,         // Private Integration Token
  locationId: process.env.GHL_LOCATION_ID!,
  // defaultChannel: 'SMS',                    // until the contact writes
})
```

- `chatId` = `contactId` de HighLevel: un chat por contacto en todos los
  canales; el canal de cada mensaje está en `ctx.chat.platformData.channel`.
- La clave pública de HighLevel viene incluida (`GHL_WEBHOOK_PUBLIC_KEY`),
  así que no hace falta secreto de webhook. `ingest()` necesita el body
  **crudo**.
- Media solo desde URLs públicas; `template` se traduce a `templateId`.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/gohighlevel-provider)

### `@bot-wa/gupshup` (experimental)

Gupshup WhatsApp API: endpoints de envío v1 y callbacks v2. Gupshup no firma
los callbacks, así que se autentican con un token compartido en la URL del
callback (o en una cabecera).

```ts
import { GupshupProvider } from '@bot-wa/gupshup'

const provider = new GupshupProvider({
  apiKey: process.env.GUPSHUP_API_KEY!,
  appName: 'MyBotApp',
  source: '917834811114',                          // the app's number
  webhookToken: process.env.GUPSHUP_WEBHOOK_TOKEN!, // callback: …/gupshup?token=<it>
})
// POST /gupshup → res.sendStatus(provider.ingestRequest({ url: req.originalUrl, body, headers }))
```

- Los botones salen como quick replies (hasta 3), después como lista (hasta
  10) y después como texto numerado; las listas son nativas hasta 10 filas.
- `chatId` = los dígitos del teléfono del remitente (sin `+`), justo lo que
  espera la API de envío.
- Media solo desde URLs públicas. Gupshup también documenta restringir por
  IP: haz ambas cosas en producción.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/gupshup-provider)

### `@bot-wa/email` (experimental)

Email: **IMAP IDLE** para recibir y **SMTP** para responder. Cada hilo de
correo es un chat, así que los flujos con `ask()` continúan cuando el cliente
responde al email. `imapflow` y `nodemailer` son peer dependencies opcionales
que se cargan de forma lazy.

```ts
import { EmailProvider } from '@bot-wa/email'

const provider = new EmailProvider({
  address: 'support@acme.com',
  imap: { host: 'imap.example.com', user: 'support@acme.com', pass: process.env.IMAP_PASS! },
  smtp: { host: 'smtp.example.com', user: 'support@acme.com', pass: process.env.SMTP_PASS! },
})
```

- `threading: 'thread'` (por defecto, un chat por hilo) o `'sender'` (un chat
  por dirección); persiste los hilos con `threadStore: cursorThreadStore(store)`.
- Protección contra bucles de respuestas automáticas y listas de correo,
  gestión de rebotes (eventos `status: 'failed'`, supresión de direcciones con
  rebote permanente).
- El email no autentica `From` por sí mismo: usa
  `requireAuthentication: { authservId }` para aceptar solo correo que tu MTA
  haya autenticado.
- Sin IMAP, `ingest(rawMime)` acepta el MIME crudo de un webhook de correo
  entrante y resuelve `{ status, accepted, reason? }`.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/email-provider)

### `@bot-wa/tiktok` (experimental)

TikTok API for Business (v1.3): **comentarios** en los videos propios de la
cuenta y **mensajes directos** (Business Messaging API, requiere aprobación).
Webhooks verificados con `TikTok-Signature`.

```ts
import { TikTokProvider } from '@bot-wa/tiktok'

const provider = new TikTokProvider({
  accessToken: process.env.TIKTOK_TOKEN!,             // or an async refresh function
  businessId: process.env.TIKTOK_BUSINESS_ID!,        // open_id of the account
  appSecret: process.env.TIKTOK_APP_SECRET!,          // verifies TikTok-Signature
  selfUniqueIdentifier: process.env.TIKTOK_SELF_UID!, // required to receive comments
})
```

- Chats: `dm:<conversation_id>` (DM), `comment:<video_id>:<comment_id>`
  (hilo de un comentario, un chat de grupo) y `hic:<comment_id>` (comentario
  de alta intención). `ctx.chat.platformData.surface` los distingue.
- DMs: texto (hasta 6000 caracteres), imágenes, tarjetas Q&A para los
  botones (de 1 a 3); comentarios: respuestas de texto de hasta 150
  caracteres. Los botones o listas que no caben en una tarjeta Q&A (más de 3
  opciones, botones con URL, títulos de más de 40 caracteres) y los menús
  enviados a un hilo de comentarios se degradan a un menú de texto numerado,
  como en Baileys.
- El bot no puede iniciar una conversación y TikTok limita los mensajes por
  ventana de 48 h (`OutsideSessionWindowError`).

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/tiktok-provider)

## Siguientes pasos

- [Servidor de webhooks](/es/guide/servidor): monta los providers por webhook
  con `@bot-wa/server`.
- [Ventana de 24 h y costos](/es/guide/ventana-24h): ventana de sesión de la
  Cloud API y seguimiento de uso.
- [Mensajes y media](/es/guide/mensajes): qué hace cada helper en cada
  transporte.
