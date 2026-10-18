# @bot-wa/gohighlevel

> **Experimental — aún no publicado en npm.** Implementación real y con tests, pero el paquete es `private`: su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Transporte **HighLevel (GoHighLevel / LeadConnector) Conversations API** para [`@bot-wa/core`](../core). Un bot que contesta a los contactos del CRM por el canal que usaron: **SMS, WhatsApp, Email, Facebook, Instagram, Live chat, GMB o un proveedor Custom**. Entrada por el webhook `InboundMessage` (firmado con **Ed25519, `X-GHL-Signature`**), salida por `POST /conversations/messages`.

## Requisitos

1. Un **Private Integration Token** (o un token OAuth de la location) con permisos de `conversations` y `conversations/message` (escritura).
2. El `locationId` de la subcuenta.
3. Una app del Marketplace (o integración) suscrita al webhook **`InboundMessage`** apuntando a tu servidor.

## Uso

```ts
import express from 'express'
import { Bot } from '@bot-wa/core'
import { GoHighLevelProvider } from '@bot-wa/gohighlevel'

const provider = new GoHighLevelProvider({
  accessToken: process.env.GHL_TOKEN!,
  locationId: process.env.GHL_LOCATION_ID!,
  // apiVersion: '2021-04-15',   // cabecera Version (por defecto)
  // defaultChannel: 'SMS',      // canal si el contacto aún no escribió
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.reply('¡Hola! Te escribo desde el CRM'))
await bot.start()

const app = express()
// Body CRUDO: la firma Ed25519 se calcula sobre los bytes exactos.
app.post('/ghl/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  res.sendStatus(provider.ingest(req.body, req.headers))
})
app.listen(3000)
```

- La clave pública Ed25519 de HighLevel viene incluida (`GHL_WEBHOOK_PUBLIC_KEY`); `publicKey` permite sobreescribirla si la rotan. La firma RSA heredada (`X-WH-Signature`, retirada el 1-sep-2026) solo se acepta si pasas `legacyPublicKey`.
- Respuestas de `ingest`: `200` aceptado (también eventos ignorados o de otra location), `400` body ilegible o ya parseado, `401` firma ausente o inválida.
- `allowUnsignedWebhooks: true` desactiva la verificación (solo desarrollo local).

## Identidad

`chatId` = `senderId` = **`contactId`** de HighLevel. HighLevel ya fusiona teléfono, email y redes en un contacto, así que la misma persona es el mismo chat en cualquier canal; el canal de cada mensaje va en `ctx.chat.platformData.channel` y el bot responde por el último canal usado. Para forzar otro: `provider.send(contactId, content, { platformData: { type: 'Email', subject: 'Tu pedido' } })` (los demás campos de `platformData` se pasan tal cual al body de la API).

## Contenido

| Kind | HighLevel |
| --- | --- |
| `text` | `message` (en `Email` también `html` escapado) |
| `image` / `video` / `document` / `audio` / `voice` | `attachments: [url]` (**URL pública**) + caption en `message` |
| `buttons` / `list` | menú de texto numerado |
| `template` | `templateId` (= `name`) |
| `native` (`provider: 'gohighlevel'`) | campos del body tal cual |

Entrante: mensajes (con adjuntos como `ctx.media`), llamadas `CALL` → evento `call`. Se ignoran los ecos `OutboundMessage` y el resto de eventos del CRM. `ctx.markRead()` pone `unreadCount: 0` en la conversación. `options.quoted` → `replyMessageId`.

## Errores

`429` → `RateLimitedError` · `404` o 400/422 por DND/opt-out/contacto inexistente → `RecipientUnreachableError` · `413` → `PayloadTooLargeError` · resto → `GoHighLevelApiError` (`status`).
