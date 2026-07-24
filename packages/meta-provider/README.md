# @bot-wa/meta

Transporte **WhatsApp Cloud API (oficial de Meta)** para [`@bot-wa/core`](../core). A diferencia de Baileys (WhatsApp Web, no oficial), la Cloud API es **oficial: sin riesgo de baneo**, con **botones, listas y plantillas nativos**. Es webhook-based (no abre socket).

## Instalación

```bash
pnpm add @bot-wa/core @bot-wa/meta
```

**Cero dependencias extra** — usa `fetch` y `crypto` nativos de Node ≥ 22.

## Requisitos (Meta)

1. Una app en [developers.facebook.com](https://developers.facebook.com) con el producto **WhatsApp**.
2. Un **token de acceso permanente** (system user) con `whatsapp_business_messaging`.
3. El **phone number id** de tu número emisor.
4. Configurar un **webhook** apuntando a tu servidor (con un `verify_token` que tú eliges y, recomendado, el `app_secret` de la app).

## Uso

```ts
import { Bot } from '@bot-wa/core'
import { CloudAPIProvider } from '@bot-wa/meta'
import express from 'express'

const provider = new CloudAPIProvider({
  accessToken: process.env.META_TOKEN!,
  phoneNumberId: process.env.META_PHONE_ID!,
  verifyToken: 'mi-verify-secret',                 // el que pusiste en Meta
  appSecret: process.env.META_APP_SECRET!,         // requerido: verifica X-Hub-Signature-256
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.reply('👋 ¡Hola desde la API oficial!'))
await bot.start()

// ——— El webhook lo sirve TU servidor ———
const app = express()
app.get('/webhook', (req, res) => {
  const challenge = provider.verifyChallenge(req.query as never)
  challenge ? res.send(challenge) : res.sendStatus(403)
})
app.post('/webhook', express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf } }), (req, res) => {
  res.sendStatus(provider.ingest((req as any).rawBody ?? req.body, req.headers))
})
app.listen(3000)
```

> **Firma del webhook:** `appSecret` es obligatorio en producción; `ingest` valida `X-Hub-Signature-256`
> (HMAC-SHA256 en tiempo constante) y rechaza cuerpos falsificados con `403`.
> Pasale el **body crudo** (no el ya parseado) para que la firma calcule igual.
> Solo para desarrollo local se puede usar `allowUnsignedWebhooks: true` de forma explícita.

## Qué soporta

| Feature | Cloud API |
|---|---|
| Texto, imagen, video, audio, documento, sticker, ubicación, contacto | ✅ |
| **Botones de respuesta** (`ctx.buttons`, máx 3) | ✅ nativo |
| **Listas** (`OutboundContent` list) | ✅ nativo |
| **Plantillas** (kind `template`, p. ej. fuera de la ventana 24h) | ✅ |
| Reacciones, confirmaciones de lectura | ✅ |
| Clics de botón/lista → interacciones (`type: 'buttons'` + `ctx.acknowledge`) | ✅ |
| Encuestas (poll) | ❌ (Graph 131051 — usá botones o WhatsApp Flows) |
| Grupos, typing/presence, editar/borrar mensajes | ❌ (no existe en la API) |

## Ventana de 24 horas

Fuera de las 24h desde el último mensaje del usuario, Meta solo deja enviar **plantillas**. Un envío libre lanza `OutsideSessionWindowError` (código 131047) — respondé con un `kind: 'template'`.

## Identidad

`chatId`/`senderId` son el `wa_id` (E.164 sin `+`) — estable, sin la dualidad LID/PN de Baileys.
