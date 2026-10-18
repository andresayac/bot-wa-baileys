# @bot-wa/evolution

Transporte [Evolution API](https://github.com/EvolutionAPI/evolution-api) v2
([`IProvider` v2](../core/src/core/provider.ts)) para [@bot-wa/core](../core).
Evolution es un gateway REST self-hosted de WhatsApp construido sobre Baileys:
el bot no abre el socket, habla con tu servidor Evolution por HTTP.

> Paquete **privado** (alpha): no se publica en npm.

- **Salida:** `POST {baseUrl}/message/<endpoint>/{instance}` con la cabecera
  `apikey`, siempre por `secureFetch` de `@bot-wa/http` (sin seguir redirecciones).
- **Entrada:** webhooks de Evolution → `provider.ingest(body, headers)`, con
  autenticación obligatoria (secreto compartido en cabecera o el `jwt_key` HS256
  de Evolution).
- **Identidad estable:** los gemelos LID/PN que Evolution adjunta
  (`remoteJidAlt`, `senderPn`, `participantAlt`, `participantPn`, `senderLid`)
  se enlazan dentro del provider; la misma persona siempre produce el mismo
  `senderId`, aunque un mensaje posterior llegue solo con el LID.
- **Contenido:** texto, imagen, vídeo, audio, nota de voz, documento, sticker,
  ubicación, contacto, encuesta, reacción; `buttons`/`list`/`card` se degradan a
  texto numerado; `native` para cualquier endpoint de `/message/*`.
- **Acciones:** descarga de media, marcar como leído, escribiendo/grabando,
  borrar para todos, editar texto.
- **Errores tipados:** `RecipientUnreachableError` (número sin WhatsApp),
  `RateLimitedError` (429 + `Retry-After`), `PayloadTooLargeError` (413),
  `UnsupportedContentError` (`template`), `ProviderError` para el resto.

## Uso

```ts
import express from 'express'
import { Bot } from '@bot-wa/core'
import { EvolutionProvider } from '@bot-wa/evolution'

const provider = new EvolutionProvider({
  baseUrl: 'http://localhost:8080',
  apiKey: process.env.EVOLUTION_API_KEY!,
  instance: 'my-instance',
  webhookSecret: process.env.EVOLUTION_WEBHOOK_SECRET!,
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.reply('¡Hola! 👋'))

const app = express()
// Cuerpo crudo o JSON: ingest() acepta string, Buffer u objeto.
app.post('/webhook/evolution', express.json({ limit: '25mb' }), (req, res) => {
  res.sendStatus(provider.ingest(req.body, req.headers))
})
app.listen(3000)
await bot.start() // connectionState → ready, o QR en `connection.update.authPayload`
```

Configura el webhook de la instancia apuntando a tu ruta, con el secreto en una
cabecera:

```bash
curl -X POST http://localhost:8080/webhook/set/my-instance \
  -H "apikey: $EVOLUTION_API_KEY" -H 'content-type: application/json' \
  -d '{"webhook":{"enabled":true,"url":"https://bot.example.com/webhook/evolution",
       "headers":{"x-webhook-secret":"<EVOLUTION_WEBHOOK_SECRET>"},
       "events":["MESSAGES_UPSERT","MESSAGES_UPDATE","CONNECTION_UPDATE","QRCODE_UPDATED","CALL","GROUP_PARTICIPANTS_UPDATE"]}}'
```

Alternativa: pon `"headers": { "jwt_key": "<clave>" }` en el webhook y
`webhookJwtKey: '<clave>'` en el provider; Evolution envía entonces
`Authorization: Bearer <JWT>` (HS256, caduca a los 10 min) y `ingest()` verifica
firma, caducidad y los claims `app: 'evolution'` / `action: 'webhook'`.

## Configuración

| Opción | Por defecto | Descripción |
| --- | --- | --- |
| `baseUrl` | — | URL del servidor Evolution. |
| `apiKey` | — | Clave global o token de la instancia (cabecera `apikey`). |
| `instance` | — | Nombre de la instancia. |
| `webhookSecret` | — | Secreto compartido (cabecera `x-webhook-secret` o `Authorization: Bearer`). |
| `webhookSecretHeader` | `x-webhook-secret` | Cabecera que lleva el secreto. |
| `webhookJwtKey` | — | El `jwt_key` del webhook de Evolution. |
| `allowUnsignedWebhooks` | `false` | Solo desarrollo local aislado. Sin secreto ni JWT, el constructor falla. |
| `selfId` | — | JID propio; si falta, se lee de `/instance/fetchInstances` o del `connection.update`. |
| `http` | — | `allowHttp` (por defecto, sí si `baseUrl` es `http://`), `allowPrivateHosts` (por defecto `true`: el gateway suele ser local), `timeoutMs` (30 s), `maxBytes` (64 MiB), `resolver`, `fetch`. |
| `identityCacheSize` | `10000` | Tamaño máximo del mapa LID↔PN (LRU). |
| `identityPersistence` | — | Mapa LID↔PN durable (`get`/`set` síncronos). Sin él, el id canónico de un contacto visto primero solo con LID puede cambiar tras un reinicio. |
| `convertAudioToMp4` | `false` | Pide a Evolution el audio en MP4 al descargar. |

`ingest()` devuelve el código HTTP: `200` (aceptado; también para otra instancia o
eventos desconocidos, para que Evolution no reintente), `401` (credencial
inválida) o `400` (no es un webhook de Evolution).

## Eventos soportados

| Webhook | Evento normalizado |
| --- | --- |
| `messages.upsert` | `message` (o `reaction` si es `reactionMessage`) |
| `messages.update` | `status` (`SERVER_ACK`→`sent`, `DELIVERY_ACK`→`delivered`, `READ`/`PLAYED`→`read`, `ERROR`→`failed`) |
| `connection.update` | `connection` (`open`→`ready`, `close` 401→`sessionInvalid`, 440→`sessionTakenOver`) |
| `qrcode.updated` | `connection` `authenticating` con el QR en `authPayload` |
| `call` | `call` |
| `group-participants.update` | `group` |

Los nombres se aceptan en cualquier forma (`MESSAGES_UPSERT`, `messages-upsert`,
`messages.upsert`, útil con `webhookByEvents`).

## Media

`ctx.media` / `provider.downloadMedia(ref)` usa el base64 del webhook si la
instancia tiene `webhookBase64: true`; si no, llama a
`/chat/getBase64FromMediaMessage/{instance}`. Nunca descarga URLs arbitrarias del
payload. Para enviar, una URL `https://` se pasa tal cual a Evolution y
cualquier otro `MediaSource` (Buffer, ruta, stream) viaja en base64.

## Limitaciones

- Botones y listas nativos no son fiables en WhatsApp Web: se envían como texto
  numerado. Para los de Evolution usa
  `ctx.sendNative('evolution', { endpoint: 'sendButtons', body: {...} })`.
- Los votos de encuesta (`pollUpdates`) aún no se emiten como `poll-vote`.
- Si el primer mensaje de una persona llega solo con LID y sin gemelo, ese LID
  queda como su id canónico durante la sesión (el mapa vive en memoria).
