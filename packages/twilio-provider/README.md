# @botmesh/twilio

> **Experimental — aún no publicado en npm.** Implementación real y con tests, pero el paquete es `private`: su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Transporte **Twilio Programmable Messaging** para [`@botmesh/core`](../core): **WhatsApp y SMS/MMS** con la misma clase. Webhook entrante verificado con **`X-Twilio-Signature`** (HMAC-SHA1 sobre la URL exacta + los parámetros POST ordenados) y envío por la REST API (`POST /2010-04-01/Accounts/{sid}/Messages.json`). No abre socket.

Sin SDK de Twilio: todas las peticiones salen por `secureFetch` de [`@botmesh/http`](../http) (timeouts, límites de tamaño, anti-SSRF).

## Uso

```ts
import express from 'express'
import { Bot } from '@botmesh/core'
import { TwilioProvider } from '@botmesh/twilio'

const provider = new TwilioProvider({
  accountSid: process.env.TWILIO_SID!,
  authToken: process.env.TWILIO_TOKEN!,            // firma los webhooks y autentica la REST API
  whatsappFrom: 'whatsapp:+14155238886',           // remitente para chats whatsapp:+…
  smsFrom: '+15017122661',                         // remitente para chats SMS (+…)
  webhookUrl: 'https://bot.example.com/twilio/webhook', // EXACTA, tal como está en la consola
  statusCallback: 'https://bot.example.com/twilio/webhook', // opcional: recibos de entrega
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.reply('¡Hola desde Twilio!'))
await bot.start()

const app = express()
// Body CRUDO: la firma cubre los parámetros tal como los envió Twilio.
app.post('/twilio/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const status = provider.ingest(req.body, req.headers)
  res.status(status).type('text/xml').send('<Response/>')
})
app.listen(3000)
```

- **URL de la firma:** se usa `webhookUrl`. Si la URL cambia por petición (multi-tenant), usa `provider.ingestRequest({ url, body, headers })` con la URL completa que llamó Twilio. Alternativa: `webhookPath` + cabeceras `X-Forwarded-Proto/Host` (solo detrás de un proxy propio). Se aceptan las variantes con y sin puerto por defecto, como hacen los SDK.
- **JSON webhooks** (`bodySHA256` en la query) también se verifican.
- `allowUnsignedWebhooks: true` desactiva la verificación (solo desarrollo local).

## Identidad

`chatId` = `senderId` = el `From` de Twilio tal cual: `whatsapp:+573001112233` en WhatsApp, `+573001112233` en SMS. La misma persona por WhatsApp y por SMS son **dos chats distintos** (canales distintos). La respuesta sale desde el número que recibió el mensaje (cuentas con varios números), si no desde `whatsappFrom`/`smsFrom`, y si no desde `messagingServiceSid`.

## Contenido

| Kind | Twilio |
| --- | --- |
| `text` | `Body` (máx. 1600 caracteres → `PayloadTooLargeError` local) |
| `image` / `video` / `document` / `audio` / `voice` / `sticker` | `MediaUrl` (**URL pública**; Buffer/path → `UnsupportedContentError`) |
| `location` | `PersistentAction: geo:lat,lng\|label` |
| `buttons` / `list` | menú de texto numerado (los interactivos de Twilio requieren Content Templates) |
| `template` | `ContentSid` (= `name`) + `ContentVariables` (= `components`) |
| `native` (`provider: 'twilio'`) | parámetros de la Messages API tal cual |

Entrante: texto, media (`ctx.media` vía `downloadMedia`, con Basic auth solo hacia `api.twilio.com`; un mensaje con varios adjuntos llega como un mensaje por adjunto, ver abajo), ubicación, respuestas citadas (`quoted`), quick replies (`ButtonPayload` → interacción `button`) y list pickers (`ListId` → `list`). Los status callbacks llegan como eventos `status` (`undelivered` → `failed` con `error.code`).

**Varios adjuntos.** Twilio manda todos los adjuntos de un mensaje en un solo webhook (`NumMedia` > 1, `MediaUrl0..N-1`, máximo 10). El provider emite **un `InboundMessage` por adjunto**, en orden, para que cada uno tenga su `ctx.media`:

- el primero conserva `ref.id` = `MessageSid` y el texto (`Body`);
- el adjunto `i` lleva `ref.id` = `` `${MessageSid}:${i}` `` y cuerpo vacío;
- todos comparten chat, remitente y `raw` (los parámetros del webhook).

Los ids son únicos por adjunto y se repiten en un reintento del webhook, así que el dedupe del core descarta los reintentos sin perder adjuntos. Ojo: cada adjunto pasa por el dispatcher como un mensaje propio, así que un `ask()` que espera una imagen consume solo el primero.

`ctx.typing()` usa el indicador de escritura de WhatsApp (`POST /v3/Indicators/Typing.json` con `{ "channel": "WHATSAPP", "messageId": "SM…" }`, en beta pública; además marca el mensaje como leído y se borra al responder o a los 25 s). Solo se envía en chats de WhatsApp con un mensaje entrante (`SM…`/`MM…`) de las últimas 24 h; en SMS es no-op. Es *best-effort*: nunca rechaza. Si Twilio responde 4xx (p. ej. un remitente o cuenta sin soporte), se registra en `debug` y el chat deja de intentarlo durante 30 min; 429/5xx/errores de red solo se registran.

Los usuarios de WhatsApp identificados por un ID de usuario de ámbito empresarial (BSUID, p. ej. `From=whatsapp:CO.2132056440717202`, `WaId=CO.2132056440717202`) funcionan igual que los de número: ese `From` es el `chatId`/`senderId` estable y se usa tal cual como `To` al responder.

## Errores

`429`/`20429`/`63018` → `RateLimitedError` · `21211`/`21610`/`21614`… → `RecipientUnreachableError` · `63016` → `OutsideSessionWindowError` · `21617`/`11751` → `PayloadTooLargeError` · resto → `TwilioApiError` (`status`, `code`, `moreInfo`).
