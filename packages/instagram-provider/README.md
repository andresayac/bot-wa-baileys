# @bot-wa/instagram

> **Experimental — aún no publicado en npm.** Implementación real y con tests, pero el paquete es `private`: no forma parte de la primera alpha y su API puede cambiar. Úsalo desde este monorepo (`workspace:*`); el `pnpm add` de abajo funcionará cuando se publique.

Transporte **Instagram DM (Messenger API for Instagram, oficial de Meta)** para [`@bot-wa/core`](../core). Es webhook-based (no abre socket): los mensajes llegan al webhook de objeto `page` de la Página de Facebook conectada y el envío usa el Send API de Graph (`me/messages`).

## Instalación

```bash
pnpm add @bot-wa/core @bot-wa/instagram
```

**Cero dependencias extra** — usa `fetch` y `crypto` nativos de Node ≥ 22.

## Requisitos (Meta)

1. Una **cuenta de Instagram profesional** (business o creator) **conectada a una Página de Facebook** — los DMs se canalizan a través de esa Página.
2. Una app en [developers.facebook.com](https://developers.facebook.com) con el producto **Messenger**, con la cuenta de Instagram conectada (Messenger API for Instagram) y los permisos `instagram_basic`, `instagram_manage_messages` y `pages_manage_metadata`.
3. Un **Page access token** de la Página conectada.
4. Configurar un **webhook** sobre el objeto `page` con los campos `messages`, `messaging_postback`, `message_reactions` y `message_echoes`, apuntando a tu servidor (con un `verify_token` que tú eliges y, recomendado, el `app_secret` de la app).

## Uso

```ts
import { Bot } from '@bot-wa/core'
import { InstagramProvider } from '@bot-wa/instagram'
import express from 'express'

const provider = new InstagramProvider({
  accessToken: process.env.META_PAGE_TOKEN!,      // token de la Página conectada
  verifyToken: 'mi-verify-secret',                // el que pusiste en Meta
  appSecret: process.env.META_APP_SECRET!,        // requerido: verifica X-Hub-Signature-256
  selfId: process.env.IG_ACCOUNT_ID,              // opcional: IGSID de la cuenta IG
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.reply('👋 ¡Hola desde Instagram!'))
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

| Feature | Instagram DM |
|---|---|
| Texto | ✅ |
| Imagen, video, audio, documento | ✅ **solo URL pública** (el Send API de IG no acepta buffers/paths) |
| **Botones** (`ctx.buttons`) | ✅ como **quick replies** (respuestas rápidas, título ≤20) |
| Clic de quick reply / postback → interacción (`kind: 'button'`) | ✅ |
| Listas | ⚠️ degradadas a texto numerado (IG no tiene listas) |
| Reacciones **recibidas** (IG DM reactions) | ✅ (`kind: 'reaction'`) |
| Typing (`ctx.typing`) y confirmaciones de lectura (`mark_seen`) | ✅ (sender_action) |
| Tarjeta (`card`) | ✅ como texto (sus botones, como quick replies) |
| Enviar reacciones / encuestas / ubicación / contacto / sticker / plantillas | ❌ (`UnsupportedContentError`) |
| Grupos, presencia, editar/borrar mensajes | ❌ (no existe en la API) |

## Identidad

`chatId`/`senderId` son el **IGSID** (Instagram-Scoped User ID) del remitente — estable y opaco. Los mensajes propios llegan como `message.is_echo` y se descartan (no se emiten como eventos).

## Notas

- **Media solo por URL:** adjuntá archivos subidos a un hosting público y pasá la URL (`ctx.photo('https://…/foto.jpg')`). Un `Buffer`, path o stream lanza `UnsupportedContentError`.
- `ctx.buttons` se envía como quick replies: chips táctiles bajo el mensaje; el tap llega como interacción con `data` = el `id` del botón.
- Fuera de la ventana de mensajes, Meta puede requerir que el usuario haya interactuado primero (política de la plataforma IG); los errores de Graph se traducen a los errores tipados de `@bot-wa/core` (`RateLimitedError` en códigos 4/613; `OutsideSessionWindowError` fuera de la ventana, subcódigo 2534022; `RecipientUnreachableError` si el usuario no existe o no está disponible, código 551 o subcódigos 2018001/2534014).
- Un mensaje que el usuario anula (`is_deleted`) no se emite como mensaje nuevo.
