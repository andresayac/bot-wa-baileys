# @bot-wa/messenger

Transporte **Facebook Messenger (Send API oficial de Meta)** para [`@bot-wa/core`](../core). Hermano de `@bot-wa/meta` (WhatsApp Cloud API): misma familia Graph — **webhook con handshake `hub.challenge` + firma `X-Hub-Signature-256`** y una **Send API HTTP** (`POST /{page-id}/messages`). No abre socket.

## Instalación

```bash
pnpm add @bot-wa/core @bot-wa/messenger
```

**Cero dependencias extra** — usa `fetch` y `crypto` nativos de Node ≥ 20.

## Requisitos (Meta)

1. Una app en [developers.facebook.com](https://developers.facebook.com) con el producto **Messenger** y una Página de Facebook conectada.
2. Un **Page Access Token** con `pages_messaging` (generado en la app, sección Messenger).
3. Configurar el **webhook** de la página apuntando a tu servidor: suscribí el campo `messages` con un `verify_token` que vos elegís y, recomendado, el `app_secret` de la app.

## Uso

```ts
import { Bot } from '@bot-wa/core'
import { MessengerProvider } from '@bot-wa/messenger'
import express from 'express'

const provider = new MessengerProvider({
  accessToken: process.env.MESSENGER_TOKEN!,
  verifyToken: 'mi-verify-secret',               // el que pusiste en Meta
  appSecret: process.env.META_APP_SECRET,        // opcional: verifica X-Hub-Signature-256
  pageId: 'me',                                  // o el id numérico de la página
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.reply('👋 ¡Hola desde Messenger!'))
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

> **Firma del webhook:** si pasás `appSecret`, `ingest` valida `X-Hub-Signature-256`
> (HMAC-SHA256 en tiempo constante) y rechaza cuerpos falsificados con `403`.
> Pasale el **body crudo** (no el ya parseado) para que la firma calcule igual.

## Configuración

| Campo | Default | Descripción |
|---|---|---|
| `accessToken` | — | Page Access Token (`pages_messaging`). |
| `verifyToken` | — | Secreto del handshake GET del webhook. |
| `appSecret` | — | Si está, verifica `X-Hub-Signature-256` en cada POST. |
| `apiVersion` | `v21.0` | Versión del Graph API. |
| `graphUrl` | `https://graph.facebook.com` | Base del Graph. |
| `pageId` | `me` | Id de la página (o `me`). |
| `selfId` | — | PSID del bot (para `fromMe`). |

## Qué soporta

| Feature | Messenger |
|---|---|
| Texto, imagen, video, audio, documento (por URL pública) | ✅ |
| **Botones postback** (`ctx.buttons`, template `button`, máx 3) | ✅ nativo |
| **Listas** (template `generic`, un elemento por fila) | ✅ nativo |
| Quick replies / postbacks entrantes → interacciones (`kind: 'button'`) | ✅ |
| Reacciones entrantes (`message.reaction` → evento `reaction`) | ✅ |
| Typing (`typing_on`/`typing_off`) y confirmación de lectura (`mark_seen`) | ✅ |
| Descarga de media entrante (`MediaRef.token` es la URL del attachment) | ✅ |
| Encuestas, stickers, ubicación, contacto, plantillas, enviar reacciones | ❌ (`UnsupportedContentError` — no hay endpoint en la Send API) |
| Grupos, presence, editar/borrar mensajes | ❌ (no existe en la API) |

## Limitaciones documentadas

- **Media solo por URL pública.** La Send API refiere attachments por URL (`is_reusable: true`); este provider **no** implementa el upload por chunks. Pasá `MediaSource` como URL (`'https://…'` o `{ url }`) — un `Buffer`/path/stream lanza `UnsupportedContentError` con la nota.
- **Citas/respuestas (`quoted`) se ignoran:** la Send API no tiene contexto de reply de primer nivel.
- **Reacciones salientes:** no hay endpoint público — `kind: 'reaction'` lanza `UnsupportedContentError`. Las entrantes sí se normalizan.
- `acknowledgeInteraction` es un no-op: los postbacks de Messenger no requieren ack.
- **Identidad:** `chatId`/`senderId` son el PSID (`sender.id`) — estable por par página↔usuario.

## Errores

Los errores del Graph (`res.error`) se mapean a los tipos de `@bot-wa/core`: códigos de rate limit **4/613** → `RateLimitedError` (honrando `Retry-After`); el resto → `ProviderError`.
