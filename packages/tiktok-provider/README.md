# @botmesh/tiktok

> **Experimental, aún no publicado en npm.** El paquete es `private`: no forma parte de la primera alpha y su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Transporte **TikTok** para [`@botmesh/core`](../core) sobre la **TikTok API for Business oficial (v1.3)**. Funciona por webhooks (`pushIngress`) y no abre ningún socket. Cubre dos superficies:

| Superficie | Entrada (webhook) | Respuesta | Requisitos |
|---|---|---|---|
| **Comentarios** en videos o fotos propios | `comment.update` (suscripción `event_type: COMMENT`) | `POST /business/comment/reply/create/` | Scope `comment.list` + "Manage Account Comment" |
| **Mensajes directos** (Business Messaging API) | `im_receive_msg` (suscripción `event_type: DIRECT_MESSAGE`) | `POST /business/message/send/` | Acceso aprobado a Business Messaging, cuenta con Advanced Access o Verified Business, dueño de la cuenta mayor de 18 años |
| **Comentarios de alta intención** (Comment-to-Message) | `im_receive_high_intent_comment` | `/business/message/send/` con `direct_reply` | Solo cuentas registradas en Vietnam, Indonesia o Tailandia |

Cada POST del webhook se valida con **`TikTok-Signature`** (HMAC-SHA256 de `${t}.${bodyCrudo}` con el app secret y una ventana anti-replay). Toda petición saliente pasa por `secureFetch` de [`@botmesh/http`](../http), que exige HTTPS, bloquea hosts privados y aplica timeouts y límites de tamaño.

## Uso

```ts
import { Bot } from '@botmesh/core'
import { TikTokProvider } from '@botmesh/tiktok'
import express from 'express'

const provider = new TikTokProvider({
  accessToken: process.env.TIKTOK_TOKEN!,          // o una función async que lo refresque
  businessId: process.env.TIKTOK_BUSINESS_ID!,     // open_id de /tt_user/oauth2/token/
  appSecret: process.env.TIKTOK_APP_SECRET!,       // verifica TikTok-Signature
  selfUniqueIdentifier: process.env.TIKTOK_SELF_UID!, // unique_identifier de la cuenta (necesario para comentarios)
})

const bot = new Bot({ provider })

// Comentarios: el chat es el hilo del comentario (ctx.isGroup === true)
bot.when('precio', async (ctx) => {
  await ctx.reply('¡Gracias por tu comentario! Te escribimos por DM 🙌')
})

// DMs: menú con tarjeta Q&A (de 1 a 3 botones; con más, menú de texto numerado)
bot.when('hola', async (ctx) => {
  await ctx.buttons('¿Qué necesitas?', [
    { id: 'precios', title: 'Precios' },
    { id: 'horario', title: 'Horario' },
  ])
})

await bot.start()

// El webhook lo sirve TU servidor. Pasa el body CRUDO: la firma se calcula sobre esos bytes.
const app = express()
app.post('/tiktok/webhook', express.raw({ type: '*/*' }), (req, res) => {
  res.sendStatus(provider.ingest(req.body, req.headers))
})
app.listen(3000)
```

Registra la URL del webhook una vez por app (no por cuenta):

```bash
curl -X POST https://business-api.tiktok.com/open_api/v1.3/business/webhook/update/ \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"…","secret":"…","event_type":"COMMENT","callback_url":"https://tu.host/tiktok/webhook"}'
# y lo mismo con "event_type":"DIRECT_MESSAGE" si tienes Business Messaging
```

`ingest()` devuelve el status HTTP con el que debes responder: `200` si lo acepta (también cuando el evento se ignora), `400` si el body no es crudo o no es JSON, y `403` si la firma no es válida, falta o está fuera de la ventana. TikTok reintenta durante 72 h cualquier respuesta distinta de 200, así que responde rápido; los handlers corren en segundo plano.

## Configuración

| Campo | Default | Descripción |
|---|---|---|
| `accessToken` | requerido | Token de la cuenta (header `Access-Token`). Acepta `string` o `() => string \| Promise<string>`, porque los tokens de cuenta caducan a las 24 h y el refresco corre por tu cuenta. |
| `businessId` | requerido | `open_id` de la cuenta, que se envía como `business_id`. Los webhooks de otras cuentas autorizadas en la misma app se ignoran. |
| `appSecret` | requerido* | Secret de la app; verifica `TikTok-Signature`. |
| `allowUnsignedWebhooks` | `false` | Solo para desarrollo local: acepta webhooks sin firmar. |
| `signatureToleranceSec` | `300` | Ventana anti-replay (diferencia máxima entre `t` y el reloj local). |
| `selfUniqueIdentifier` | — | `unique_identifier` de la propia cuenta. **Obligatorio para recibir comentarios**: sus comentarios (incluidas las respuestas del bot vistas por otra instancia o tras un reinicio) llegan con `fromMe: true` y no se despachan. Sin él, los webhooks de comentarios se ignoran; los DMs funcionan igual. |
| `apiBaseUrl` / `apiVersion` | `https://business-api.tiktok.com/open_api` / `v1.3` | Endpoint de la API. |
| `http` | — | Opciones de `secureFetch` (`timeoutMs`, `maxBytes`, `resolver`, `fetch`…). |
| `logger` / `debug` | pino `error` | Logger compatible con pino. |

## Modelo de chats e identidad

- **`senderId` = `unique_identifier`**, el identificador global de TikTok, que se mantiene igual entre APIs. La misma persona tiene el mismo `senderId` en comentarios y en DMs.
- Los ids de chat son opacos para el core. El provider los construye así:
  - `dm:<conversation_id>`: conversación de DM (`kind: 'dm'`).
  - `comment:<video_id>:<comment_id>`: hilo de un comentario de primer nivel (`kind: 'group'`, `isGroup: true`). Las respuestas a un comentario caen en el hilo de su `parent_comment_id`, y las conversaciones van por participante.
  - `hic:<comment_id>`: comentario de alta intención (respuesta por DM).
    TikTok solo admite **una** respuesta directa por comentario. Tras enviarla, el provider enlaza el chat `hic:` con la conversación de DM que se abre (la aprende de la respuesta de la API, del eco `im_send_msg` o del primer DM del autor del comentario). Mientras haya actividad en las 48 h siguientes, los DMs de esa conversación llegan al mismo chat `hic:`, así que un flow iniciado desde el comentario (`.ask()`, `choose()`) recibe la respuesta. Los envíos posteriores a `hic:` van a la conversación (texto, imágenes, botones). Un segundo envío antes de conocer la conversación falla con `RecipientUnreachableError`. El enlace vive en memoria: tras un reinicio, los DMs llegan a `dm:<conversation_id>`.
- `ctx.chat.platformData.surface` vale `'comment'`, `'dm'` o `'high-intent-comment'`. Con `scope: 'dm'` / `scope: 'group'` en un trigger separas DMs de comentarios.
- Los ids de comentario de TikTok son enteros de 64 bits que llegan como números JSON. Se parsean **sin pérdida** (`parseJsonLossless`) y se tratan como strings.

## Qué soporta

| Contenido | DM | Comentario | Alta intención |
|---|---|---|---|
| `text` | ✅ (≤ 6000 caracteres; `ctx.quote()` cita el mensaje) | ✅ (≤ 150 caracteres) | ✅ (el primer envío es la respuesta directa; los siguientes van al DM enlazado, con todo lo de la columna DM) |
| `image` | ✅ (Buffer, `{path}` y URL se suben con `/business/message/media/upload/`; `{ native: { mediaId } }` reutiliza un `media_id` existente) | ❌ | ❌ |
| `buttons` | ✅ `QA_BUTTON_CARD` (1 a 3, títulos ≤ 20) o `QA_LINK_CARD` (títulos ≤ 40); pregunta ≤ 40. Si no cabe (más de 3, botones con URL, textos más largos), menú de texto numerado | ✅ menú de texto numerado (≤ 150 caracteres) | ✅ menú de texto numerado en la respuesta directa |
| `list` | ✅ `QA_LINK_CARD` si hay como mucho 3 filas en total; con más, menú de texto numerado | ✅ menú de texto numerado (≤ 150 caracteres) | ✅ menú de texto numerado en la respuesta directa |
| `native` (`provider: 'tiktok'`) | ✅ (se fusiona en el body de `message/send`, p. ej. `SHARE_POST`) | ✅ (se fusiona en `reply/create`, p. ej. `image_uri`) | ❌ |
| Resto (`audio`, `video`, `document`, `location`, `poll`, `reaction`…) | `UnsupportedContentError` | `UnsupportedContentError` | `UnsupportedContentError` |

Entrada (DM): texto, imagen y video (`ctx.media` con `downloadMedia` a través de `/business/message/media/download/`), stickers, posts compartidos (`type: 'unknown'`, con la URL embed en `body`), mensajes citados (`ctx.quoted`), reacciones (eventos `reaction`) y clics en tarjetas Q&A (interacción `button` con `data` igual al `id` del botón). `im_send_msg` se emite como estado `sent`.

Acciones: `typing()` envía `SENDER_ACTION TYPING`, que desaparece a los 5 s. `markRead()` envía `MARK_READ` por conversación. En comentarios ambas son no-op.

## Límites (impuestos por TikTok)

- **No se puede iniciar conversación**: solo se responde a usuarios que escribieron primero.
- **Ventana de 48 h** en conversaciones sin follow mutuo: hasta 10 mensajes en las 48 h posteriores al primer mensaje del usuario; ilimitados durante 48 h tras cada respuesta suya, y 3 como máximo fuera de ventana. Los rechazos se mapean a `OutsideSessionWindowError`.
- **EEA, Suiza y Reino Unido**: TikTok no entrega el contenido. El evento `im_receive_msg_eu` se descarta.
- `comment.update` llega **hasta 5 minutos tarde** y no trae nombre ni username del autor. Solo se procesa `comment_action: 'insert'`; borrados, ocultados y cambios de visibilidad se ignoran.
- Las respuestas que envía el propio bot generan su propio `comment.update`. La protección contra bucles es el autor: con `selfUniqueIdentifier`, todo comentario de la cuenta llega como `fromMe: true` (vale tras un reinicio y entre varias instancias). Además, el proceso recuerda los `comment_id` que creó y no los re-emite. Sin `selfUniqueIdentifier` los comentarios se descartan.
- Las llamadas a la API **no siguen redirecciones**: el token va en la cabecera `Access-Token`, que una redirección a otro origen arrastraría. Una respuesta 3xx falla con `TikTokApiError`.
- Las imágenes en DM solo funcionan donde TikTok permite adjuntos; consúltalo con `/business/message/capabilities/get/`.

## Errores tipados

| Situación | Error |
|---|---|
| HTTP 429 o `code` 40016 / 40100 / 40132 / 40133 | `RateLimitedError` (respeta `Retry-After`) |
| Ventana o cuota de mensajes | `OutsideSessionWindowError` |
| `code` 40007 (no existe la conversación o el comentario), o chat id inválido | `RecipientUnreachableError` |
| Texto por encima del límite, también un menú degradado (se comprueba antes de llamar a la API) | `PayloadTooLargeError` |
| Tipo de contenido no soportado | `UnsupportedContentError` |
| Cualquier otro `code` ≠ 0 o HTTP no-2xx | `TikTokApiError` (`code`, `requestId`, `httpStatus`) |
