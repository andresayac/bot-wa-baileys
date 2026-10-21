# @botmesh/gupshup

> **Experimental — aún no publicado en npm.** Implementación real y con tests, pero el paquete es `private`: su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Transporte **Gupshup WhatsApp API** para [`@botmesh/core`](../core): envío por `POST /wa/api/v1/msg` (y `/wa/api/v1/template/msg`) y recepción por callbacks en **formato v2**. Sin SDK: todo sale por `secureFetch` de [`@botmesh/http`](../http).

## Requisitos

1. Una app de WhatsApp en Gupshup: **API key**, **nombre de la app** (`src.name`) y el **número** de la app.
2. Callback URL configurado en la consola con **payload v2**, incluyendo un token secreto en la query: `https://bot.example.com/gupshup?token=<secreto>`.

Gupshup **no firma** sus callbacks: el provider los autentica con ese token (comparación en tiempo constante). Gupshup recomienda además restringir por IP; haz ambas cosas en producción.

## Uso

```ts
import express from 'express'
import { Bot } from '@botmesh/core'
import { GupshupProvider } from '@botmesh/gupshup'

const provider = new GupshupProvider({
  apiKey: process.env.GUPSHUP_API_KEY!,
  appName: 'MiBotApp',
  source: '917834811114',
  webhookToken: process.env.GUPSHUP_WEBHOOK_TOKEN!,
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.buttons('¿Qué necesitas?', [
  { id: 'saldo', title: 'Saldo' },
  { id: 'asesor', title: 'Asesor' },
]))
bot.when('saldo', (ctx) => ctx.reply('Tu saldo es…'))
await bot.start()

const app = express()
app.post('/gupshup', express.raw({ type: '*/*' }), (req, res) => {
  res.sendStatus(provider.ingestRequest({ url: req.originalUrl, body: req.body, headers: req.headers }))
})
app.listen(3000)
```

- `ingestRequest` lee el token de la query (`webhookTokenParam`, por defecto `token`) o de la cabecera; `ingest(body, headers)` solo de la cabecera (`webhookTokenHeader`, por defecto `x-webhook-token`).
- Respuestas: `200` aceptado (también el ping vacío de validación), `400` JSON inválido, `401` token ausente o incorrecto.
- `allowUnsignedWebhooks: true` desactiva el token (solo desarrollo local).

## Identidad

`chatId` = `senderId` = `sender.phone` (dígitos con código de país, sin `+`), que es exactamente el `destination` que espera la API de envío. Los mensajes entrantes llevan el id de WhatsApp; los salientes, el `messageId` de Gupshup (= `gsId` en los callbacks), así que estados, reacciones y citas a mensajes del bot se enlazan por `gsId`.

## Contenido

| Kind | Gupshup |
| --- | --- |
| `text` | `{ type: 'text' }` |
| `image` / `video` / `audio` / `voice` / `document` / `sticker` | `image` (`originalUrl`/`previewUrl`), `video`, `audio`, `file`, `sticker` (**URL pública**) |
| `location` / `contact` | `location` / `contact` |
| `buttons` | `quick_reply` (≤ 3, `postbackText` = `id` del botón) → `list` (≤ 10) → texto numerado |
| `list` | `list` interactiva (`postbackText` = `id` de la fila; > 10 filas → texto numerado) |
| `template` | `/template/msg` con `{ id: name, params: components }` (`components` = array de strings o `{ params }`) |
| `native` (`provider: 'gupshup'`) | objeto `message` tal cual |

`platformData` en las opciones de envío sobreescribe campos del formulario (p. ej. `{ source: '…' }` para otro número).

Entrante: texto, media (`ctx.media`, URL con caducidad `urlExpiry`), ubicación, contacto, citas (`quoted`), `quick_reply`/`button_reply`/`list_reply` y botones de plantilla → interacciones (el `postbackText` llega como `ctx.body`), reacciones → evento `reaction`, `message-event` → `status` (`enqueued`/`deleted` se descartan; `failed` lleva `code` y `reason`).

## Errores

`429` → `RateLimitedError` · "not opted in / inactive / invalid destination" → `RecipientUnreachableError` · "24 hours" → `OutsideSessionWindowError` · tamaño → `PayloadTooLargeError` · resto → `GupshupApiError` (`status`). Una respuesta `200` con `status: 'error'` también rechaza.
