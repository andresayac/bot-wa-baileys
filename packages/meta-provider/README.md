# @bot-wa/meta

Transporte **WhatsApp Cloud API (oficial de Meta)** para [`@bot-wa/core`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core). A diferencia de Baileys (WhatsApp Web, no oficial), la Cloud API es **oficial: sin riesgo de baneo**, con **botones, listas y plantillas nativos**. Es webhook-based (no abre socket).

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
> Un body que no es un objeto JSON se responde con `400` (nunca lanza).

## Qué soporta

| Feature | Cloud API |
|---|---|
| Texto, imagen, video, audio, documento, sticker, ubicación, contacto | ✅ (al subir un `Buffer`, el tipo MIME sale del `mimetype` del documento, la extensión, los bytes o el tipo de contenido; nunca `application/octet-stream` para imagen, audio, video o sticker) |
| **Botones de respuesta** (`ctx.buttons`, máx 3) | ✅ nativo |
| **Listas** (`OutboundContent` list) | ✅ nativo |
| **Plantillas** (kind `template`, p. ej. fuera de la ventana 24h) | ✅ |
| Reacciones, confirmaciones de lectura | ✅ |
| Usuarios con **username** de WhatsApp (BSUID): recibir y enviar | ✅ (ver [Usernames y BSUID](#usernames-y-bsuid)) |
| Clics de botón/lista → interacciones (`type: 'buttons'` + `ctx.acknowledge`) | ✅ |
| Botones de respuesta rápida de **plantillas** (`type: 'button'`) → interacción con el `payload` | ✅ |
| Respuestas citando un mensaje → `ctx.quoted.ref.id` (el `wamid` citado) | ✅ |
| **Formularios** (`flow().form()` → WhatsApp Flows estáticos) | ✅ nativo (ver [WhatsApp Flows](#whatsapp-flows-formularios)) |
| Encuestas (poll) | ❌ (Graph 131051 — usá botones o WhatsApp Flows) |
| Grupos, typing/presence, editar/borrar mensajes | ❌ (no existe en la API) |

## WhatsApp Flows (formularios)

`flow().form(definicion)` del core se envía aquí como un **WhatsApp Flow** nativo (`capabilities.forms === 'native'`). El provider compila la definición a un Flow JSON estático de una pantalla (`navigate`, sin endpoint ni cifrado) y la respuesta (`nfm_reply`) vuelve como mensaje de tipo `'form'` que el paso guarda, validado, en `c.state`.

Un Flow debe existir en Meta antes de enviarse:

```ts
const provider = new CloudAPIProvider({ ...cfg, wabaId: process.env.WABA_ID, flows: { signup: '1234567890' } })
// o crearlo una vez desde el bot (Flows API, token con whatsapp_business_management):
const { flowId } = await provider.publishForm(signup, { categories: ['SIGN_UP'] })   // guarda flowId para config.flows
// o exportar el JSON para pegarlo en WhatsApp Manager:
writeFileSync('signup.flow.json', JSON.stringify(toFlowJson(signup), null, 2))
```

Si un formulario no tiene Flow asociado (ni `config.flows` ni `.form(def, { nativeId })`), el paso pregunta campo por campo como en cualquier otro canal. `flowJsonWarnings(def)` avisa de etiquetas que WhatsApp recortará. El botón (`cta`) y el cuerpo del mensaje siguen el `ctx.lang` del usuario (catálogo `core.form.*`); la etiqueta de envío queda fija en el Flow publicado, así que elige su idioma con `toFlowJson(def, { lang: 'en' })` / `publishForm(def, { flowJson: { lang: 'en' } })` (por defecto `'es'`) o define `submitLabel`. Los Flows con endpoint (`data_exchange`, pantallas dinámicas cifradas) aún no están soportados.

## Ventana de 24 horas

Fuera de las 24h desde el último mensaje del usuario, Meta solo deja enviar **plantillas**. Un envío libre lanza `OutsideSessionWindowError` (código 131047) — respondé con un `kind: 'template'`.

Con `sessionWindow` el provider lo gestiona solo: guarda la hora del último mensaje entrante de cada chat, y cuando un envío libre falla con 131047 (o la ventana ya se sabe cerrada) envía una plantilla aprobada para reabrir la conversación, encola el mensaje original y lo reintenta cuando el usuario responde.

```ts
const provider = new CloudAPIProvider({
  /* ... */
  sessionWindow: {
    reopenTemplate: { kind: 'template', name: 'retomar_conversacion', language: 'es' },
    reopenTemplateByKind: { document: { kind: 'template', name: 'documento_listo', language: 'es' } },
    onReport: (r) => logger.info({ chatId: r.chatId, outcome: r.outcome }, 'session window'),
    // store: miStoreRedis,          // SessionWindowStore (por defecto, en memoria y acotado)
    // onReopened: 'resolve',        // por defecto 'reject' → SessionWindowReopenedError
  },
})
await provider.sessionWindow!.isOpen('573001112233')
```

`send()` rechaza con `SessionWindowReopenedError` (subclase de `OutsideSessionWindowError`) cuando reabre y encola; con `onReopened: 'resolve'` devuelve el resultado del envío de la plantilla. La cola de reintentos vive en memoria y está acotada (`maxPendingPerChat`, `maxPendingChats`, `pendingTtlMs`); antes de entregarle el contenido, el provider sube la media una sola vez (buffer, ruta o `{ stream }`) y la cola solo guarda el id de media, así que los reintentos no vuelven a leer un stream ya consumido ni retienen bytes. La ventana es por número de negocio + usuario: las claves del store llevan el `phoneNumberId` como prefijo (`<phoneNumberId>:<chatId>`) y un `SessionWindowManager` compartido entre varios providers le da a cada número su propia vista (`manager.forScope(phoneNumberId)`), con su ventana, su cola y sus envíos. Si la propia plantilla falla (`reopen-failed`), `send()` rechaza y el mensaje **no** queda en cola. Los envíos simultáneos a un chat cerrado comparten una sola plantilla, y un 131047 tardío sobre un mensaje enviado antes de la última respuesta del usuario no cierra la ventana (el mensaje se reenvía en el momento).

## Costos (pricing)

Cada evento `status` incluye en `platformData.pricing` el objeto `pricing` del webhook normalizado (`billable`, `pricingModel` `PMP`/`CBP`, `category`, `type` — `regular`, `free_customer_service`, `free_entry_point`) y, si viene, `platformData.conversation`. `provider.usage` agrega por chat y por categoría (cada mensaje se cuenta una vez):

```ts
const provider = new CloudAPIProvider({ /* ... */, usage: { rates: { marketing: 0.0125, utility: 0.0008 } } })
provider.usage!.forChat('573001112233') // { messages, billable, free, estimatedCost, byCategory }
provider.usage!.totals()
```

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
