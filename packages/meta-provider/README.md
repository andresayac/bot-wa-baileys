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
| Usuarios con **username** de WhatsApp (BSUID): recibir y enviar | ✅ (ver [Usernames y BSUID](#usernames-y-bsuid)) |
| Clics de botón/lista → interacciones (`type: 'buttons'` + `ctx.acknowledge`) | ✅ |
| Encuestas (poll) | ❌ (Graph 131051 — usá botones o WhatsApp Flows) |
| Grupos, typing/presence, editar/borrar mensajes | ❌ (no existe en la API) |

## Ventana de 24 horas

Fuera de las 24h desde el último mensaje del usuario, Meta solo deja enviar **plantillas**. Un envío libre lanza `OutsideSessionWindowError` (código 131047) — respondé con un `kind: 'template'`.

## Identidad

`chatId`/`senderId` son el `wa_id` (teléfono E.164 sin `+`) cuando se conoce y, si no, el **BSUID** del usuario (ver abajo). No hay dualidad LID/PN como en Baileys, pero sí puede faltar el teléfono: el provider lo resuelve antes de emitir el evento para que la misma persona conserve siempre el mismo id.

## Usernames y BSUID

Desde abril de 2026 la Cloud API identifica a cada usuario también con un **BSUID** (*business-scoped user ID*): un id propio de tu portfolio de negocio con la forma `US.13491208655302741918` (código de país ISO + `.` + hasta 128 alfanuméricos). Los portfolios vinculados reciben además un **BSUID padre** (`US.ENT.11815799212886844830`).

Si un usuario activa un **username** de WhatsApp, Meta **omite su teléfono** (`messages[].from`, `contacts[].wa_id`, `statuses[].recipient_id`) salvo que le hayas escrito o llamado en los últimos 30 días o lo tengas en tu *contact book*. En ese caso el webhook solo trae el BSUID (`from_user_id`, `contacts[].user_id`, `recipient_user_id`).

### Cómo se elige el id

Para cada mensaje, interacción, reacción o estado de entrega:

1. Si en esta sesión (vida del proceso) ya se emitió un id para ese BSUID, BSUID padre o teléfono, **se reutiliza**.
2. Si no, el **teléfono** cuando viene en el webhook.
3. Si no, el teléfono **aprendido antes** para ese BSUID (vía `identityMap`).
4. Si no, el **BSUID**.

El provider aprende el par teléfono ↔ BSUID de cualquier webhook que traiga ambos (mensajes + `contacts`, estados de entrega). Consecuencias:

- Un usuario visto primero con teléfono y después solo con BSUID **conserva el id basado en el teléfono**.
- Un usuario visto primero solo con BSUID que después comparte su teléfono **conserva el BSUID durante la sesión** (no se rompe la conversación en curso); el par queda guardado, así que en la siguiente sesión se usará el teléfono.
- Los estados de entrega (`sent`/`delivered`/`read`/`failed`) se resuelven con las mismas reglas, así que llegan con el mismo `chatId` que la conversación.
- Si Meta cambia el BSUID (webhook `user_id_update`) o el usuario cambia de número (mensaje de sistema `user_changed_number` / `user_changed_user_id`), los ids nuevos se enlazan al id de la sesión.
- Un item sin ningún id utilizable (o con ids malformados) **se descarta y se registra** con `logger.warn` (sin datos personales); nunca se emite un evento con id vacío.

En `senderInfo` quedan los datos de identidad disponibles:

| Campo | Contenido |
|---|---|
| `senderInfo.username` | username de WhatsApp, si el usuario lo activó |
| `senderInfo.platformData.phoneNumber` | teléfono (del webhook o aprendido), si se conoce |
| `senderInfo.platformData.bsuid` | BSUID |
| `senderInfo.platformData.parentBsuid` | BSUID padre, si existe |
| `senderInfo.platformData.username` | username (igual que arriba) |

### Enviar a un BSUID

No hay que hacer nada especial: si el `chatId` es un BSUID (o BSUID padre), el provider envía con el campo `recipient` en lugar de `to`; si es un teléfono, sigue usando `to`. `ctx.reply()` funciona igual con usuarios con username. Puedes comprobarlo con `isBsuid(chatId)`.

> Las plantillas de autenticación *one-tap*, *zero-tap* y *copy code* exigen teléfono; enviarlas a un BSUID falla con el error de Graph `131062`.

### Persistir los pares teléfono ↔ BSUID (`identityMap`)

Por defecto los pares se guardan en un `MemoryIdentityMap` en RAM (LRU de 10 000 entradas) y **se pierden al reiniciar**: tras un reinicio, un usuario que llegue solo con BSUID tendría un id distinto al teléfono que usaba antes. Para evitarlo, pasa tu propio `identityMap`. La interfaz es mínima y admite métodos síncronos o asíncronos:

```ts
interface IdentityMap {
  get(bsuid: string): string | undefined | Promise<string | undefined>  // → teléfono (wa_id)
  set(bsuid: string, phone: string): void | Promise<void>
}
```

Con Redis (asíncrono):

```ts
import { CloudAPIProvider } from '@bot-wa/meta'

const provider = new CloudAPIProvider({
  // ...accessToken, phoneNumberId, verifyToken, appSecret
  identityMap: {
    get: async (bsuid) => (await redis.hGet('wa:bsuid', bsuid)) ?? undefined,
    set: async (bsuid, phone) => { await redis.hSet('wa:bsuid', bsuid, phone) },
  },
})
```

O síncrono, precargando desde tu base de datos y escribiendo en segundo plano:

```ts
import { CloudAPIProvider, MemoryIdentityMap } from '@bot-wa/meta'

const memory = new MemoryIdentityMap({ maxEntries: 100_000, entries: await db.loadBsuidPairs() })
const provider = new CloudAPIProvider({
  // ...
  identityMap: {
    get: (bsuid) => memory.get(bsuid),
    set: (bsuid, phone) => { memory.set(bsuid, phone); void db.saveBsuidPair(bsuid, phone) },
  },
})
```

Detalles:

- Con un mapa síncrono, `ingest()` emite los eventos en el acto. Con uno asíncrono, `ingest()` sigue devolviendo `200` de inmediato y los eventos se emiten cuando termina la búsqueda, **siempre en el orden de los webhooks**. `stop()` espera a que se vacíe esa cola.
- `get` solo se consulta para usuarios que llegan sin teléfono y que la sesión aún no conoce; `set` se llama una vez por par y sesión (hazlo idempotente).
- Si `get` falla, el evento se emite con el BSUID y se registra el error; si `set` falla, solo se registra.
- `parseInbound(body)` (exportado) es **sin estado**: resuelve la identidad dentro de ese body. La continuidad entre webhooks la da `provider.ingest()`.
