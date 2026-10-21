# @botmesh/wppconnect

Transporte [WPPConnect Server](https://github.com/wppconnect-team/wppconnect-server)
([`IProvider` v2](../core/src/core/provider.ts)) para [@botmesh/core](../core).
`wppconnect-server` expone WhatsApp Web (WA-JS) como API REST; el bot habla con
él por HTTP y recibe los eventos por webhook.

> Paquete **privado** (alpha): no se publica en npm.

- **Salida:** `POST {baseUrl}/api/{session}/<endpoint>` con
  `Authorization: Bearer <token>`, por `secureFetch` de `@botmesh/http` (sin
  seguir redirecciones). Con `secretKey`, el token se genera en `start()` y se
  regenera una vez ante un 401 (la `secretKey` nunca aparece en los errores).
- **Entrada:** webhooks (`onmessage`, `onack`, `onreactionmessage`,
  `incomingcall`, `onparticipantschanged`, `status-find`, `qrcode`) →
  `await provider.ingest(body, headers, url)`, con token obligatorio y
  comprobación de `session`.
- **Identidad estable:** los LID desconocidos se resuelven a su número con
  `GET /api/{session}/contact/pn-lid/{lid}` **antes** de emitir (con caché), y
  `sender.phoneNumber` también enlaza el par. La misma persona siempre produce el
  mismo `senderId`.
- **Contenido:** texto, imagen, vídeo, audio, nota de voz, documento, sticker,
  ubicación, contacto (vCard), encuesta, reacción; `buttons`/`list`/`card` se
  degradan a texto numerado; `native` para cualquier endpoint de `/api/{session}/`.
- **Acciones:** descarga de media (`download-media`), marcar chat como leído
  (`send-seen`), escribiendo/grabando, borrar, editar texto.
- **Errores tipados:** `RecipientUnreachableError`, `RateLimitedError`,
  `PayloadTooLargeError`, `UnsupportedContentError`, `ProviderError`.

## Uso

```ts
import express from 'express'
import { Bot } from '@botmesh/core'
import { WPPConnectProvider } from '@botmesh/wppconnect'

const provider = new WPPConnectProvider({
  baseUrl: 'http://localhost:21465',
  session: 'my-bot',
  secretKey: process.env.WPP_SECRET_KEY!,     // o token: '<bearer ya generado>'
  webhookToken: process.env.WPP_WEBHOOK_TOKEN!,
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.reply('¡Hola! 👋'))

const app = express()
app.post('/webhooks/wpp', express.json({ limit: '25mb' }), async (req, res) => {
  res.sendStatus(await provider.ingest(req.body, req.headers, req.originalUrl))
})
app.listen(3000)
await bot.start() // start-session + status-session → ready, o QR en authPayload
```

`wppconnect-server` no firma los webhooks ni permite cabeceras propias, así que
el token va en la URL del webhook (configuración del servidor):

```json
{ "webhook": { "url": "https://bot.example.com/webhooks/wpp?token=<WPP_WEBHOOK_TOKEN>" } }
```

Pasa la URL de la petición (`req.originalUrl` basta) como tercer argumento de
`ingest()`. Si un proxy delante la reescribe, también se acepta en la cabecera
`x-webhook-token` o como `Authorization: Bearer <token>`.

## Configuración

| Opción | Por defecto | Descripción |
| --- | --- | --- |
| `baseUrl` | `http://localhost:21465` | URL de wppconnect-server. |
| `session` | — | Nombre de la sesión. |
| `token` / `secretKey` | — | Uno de los dos es obligatorio. |
| `webhookToken` | — | Token del webhook (query `token`, cabecera o Bearer). |
| `webhookTokenHeader` | `x-webhook-token` | Cabecera alternativa. |
| `webhookTokenParam` | `token` | Parámetro de query. |
| `allowUnsignedWebhooks` | `false` | Solo desarrollo local aislado. |
| `startSession` | `true` | Llama a `start-session` en `start()`. |
| `webhookUrl` | — | Webhook por sesión enviado en `start-session` (debe estar en `allowedUrls` del servidor). |
| `resolveLid` | `true` | Resolver LIDs con `contact/pn-lid`. |
| `maxLidLookups` | `5` | Máximo de consultas `pn-lid` por webhook (en paralelo). |
| `lidLookupTimeoutMs` | `5000` | Timeout de cada consulta `pn-lid`. |
| `lidRetryMs` | `300000` | Espera antes de reintentar un LID cuya consulta falló. |
| `selfId` | — | Número propio (`573…@c.us`); si falta se aprende del `to` de un DM entrante. |
| `http` | — | `allowHttp`, `allowPrivateHosts` (por defecto `true`), `timeoutMs` (30 s), `maxBytes` (64 MiB), `resolver`, `fetch`. |
| `identityCacheSize` | `10000` | Tamaño máximo del mapa LID↔PN (LRU). |
| `identityPersistence` | — | Mapa LID↔PN durable (`get`/`set` síncronos). Sin él, el id canónico de un contacto visto primero solo con LID puede cambiar tras un reinicio. |

`ingest()` resuelve al código HTTP: `200` (aceptado; también para otra sesión o
eventos desconocidos), `401` (token inválido) o `400` (no es un webhook válido).

## Notas

- Los ids de mensaje son los serializados de WA-JS
  (`false_573…@c.us_3EB0…`): son los que aceptan `send-reply`, `react-message`,
  `delete-message` y `download-media`.
- `markRead` marca el **chat** entero (`send-seen`); WhatsApp Web no tiene
  recibos por mensaje.
- Para botones/listas de WPPConnect usa
  `ctx.sendNative('wppconnect', { endpoint: 'send-list-message', body: {...} })`.
