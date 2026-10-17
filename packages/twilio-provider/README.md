# @bot-wa/twilio

> **Experimental — aún no publicado en npm.** Implementación real y con tests, pero el paquete es `private`: su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Transporte **Twilio Programmable Messaging** para [`@bot-wa/core`](../core): **WhatsApp y SMS/MMS** con la misma clase. Webhook entrante verificado con **`X-Twilio-Signature`** (HMAC-SHA1 sobre la URL exacta + los parámetros POST ordenados) y envío por la REST API (`POST /2010-04-01/Accounts/{sid}/Messages.json`). No abre socket.

Sin SDK de Twilio: todas las peticiones salen por `secureFetch` de [`@bot-wa/http`](../http) (timeouts, límites de tamaño, anti-SSRF).

## Uso

```ts
import express from 'express'
import { Bot } from '@bot-wa/core'
import { TwilioProvider } from '@bot-wa/twilio'

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

Entrante: texto, media (`ctx.media` vía `downloadMedia`, con Basic auth solo hacia `api.twilio.com`), ubicación, respuestas citadas (`quoted`), quick replies (`ButtonPayload` → interacción `button`) y list pickers (`ListId` → `list`). Los status callbacks llegan como eventos `status` (`undelivered` → `failed` con `error.code`).

`ctx.typing()` usa el indicador de escritura de WhatsApp (`/v3/Indicators/Typing.json`, que además marca el mensaje como leído); en SMS es no-op.

## Errores

`429`/`20429`/`63018` → `RateLimitedError` · `21211`/`21610`/`21614`… → `RecipientUnreachableError` · `63016` → `OutsideSessionWindowError` · `21617`/`11751` → `PayloadTooLargeError` · resto → `TwilioApiError` (`status`, `code`, `moreInfo`).
