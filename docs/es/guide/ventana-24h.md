# Ventana de 24 h y costos (Cloud API)

En la WhatsApp Cloud API (`@botmesh/meta`) un negocio solo puede enviar
mensajes **libres** (texto, media, botones...) dentro de las **24 horas**
siguientes al último mensaje del usuario: la ventana de atención al cliente.
Fuera de ella solo pasan las **plantillas** aprobadas; Meta rechaza todo lo
demás con el error de Graph `131047`, que el provider traduce a
`OutsideSessionWindowError`.

`@botmesh/meta` incluye dos ayudas opcionales para esto:

- **`sessionWindow`**: sigue la ventana de cada chat, reabre los chats
  cerrados con una plantilla y reintenta el mensaje original cuando el
  usuario responde.
- **`usage`**: cuenta la información de facturación que Meta adjunta a los
  webhooks de estado, por chat y por categoría de precio.

Ambas existen solo en `@botmesh/meta`. Otros providers con una ventana
parecida (error `63016` de Twilio, Gupshup, TikTok) rechazan con
`OutsideSessionWindowError`, pero no tienen gestor.

## Sin el gestor

Por defecto no se sigue nada. Un envío libre fuera de la ventana rechaza y tú
decides qué hacer:

```ts
import { OutsideSessionWindowError } from '@botmesh/core'

try {
  await bot.sendTo(chatId, 'Your order shipped')
} catch (err) {
  if (!(err instanceof OutsideSessionWindowError)) throw err
  await bot.sendTo(chatId, {
    kind: 'template',
    name: 'order_update',
    language: 'en',
    components: [/* template parameters, Graph format */],
  })
}
```

Las plantillas siempre se permiten: son la forma de volver a abrir la
ventana.

## Activar el gestor

```ts
import { CloudAPIProvider } from '@botmesh/meta'

const provider = new CloudAPIProvider({
  accessToken: process.env.META_TOKEN!,
  phoneNumberId: process.env.META_PHONE_ID!,
  verifyToken: process.env.META_VERIFY_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  sessionWindow: {
    reopenTemplate: { kind: 'template', name: 'resume_conversation', language: 'en' },
    reopenTemplateByKind: {
      document: { kind: 'template', name: 'document_ready', language: 'en' },
    },
    onReport: (r) => logger.info({ chatId: r.chatId, outcome: r.outcome }, 'session window'),
  },
})
```

Con `sessionWindow`, `provider.send()` (y por tanto `ctx.reply`,
`bot.sendTo`...) pasa por un `SessionWindowManager`:

1. Cada **mensaje** o **interacción** entrante (pulsación de botón o de
   lista) registra la hora del último mensaje del chat. Las reacciones y los
   estados no abren la ventana.
2. Un envío libre a un chat cuya ventana **se sabe cerrada** (último mensaje
   entrante de hace más de 24 h, o Meta informó `131047` desde entonces) se
   salta la petición condenada al fracaso y pasa directamente al paso 4
   (`proactive`, activado por defecto). Un chat que nunca se vio no se
   considera cerrado: se intenta el envío.
3. Si un envío libre falla con `OutsideSessionWindowError`, la ventana se
   marca como cerrada.
4. El gestor envía la **plantilla de reapertura**, encola el contenido
   original y rechaza (o resuelve, ver `onReopened`).
5. Cuando el usuario responde, el contenido encolado se envía solo, en
   orden, antes de cualquier envío nuevo a ese chat. Tus handlers también se
   ejecutan con esa respuesta, como siempre.

Un webhook de estado `failed` con código `131047` sobre un mensaje libre que
envió el gestor (Meta puede informarlo de forma asíncrona) dispara la misma
reapertura y encolado, notificados por `onReport` porque `send()` ya había
resuelto.

Las plantillas (`kind: 'template'`) no pasan por el gestor: siempre se envían
directamente.

### Qué hace `send()` tras reabrir

- **`onReopened: 'reject'`** (por defecto): `send()` rechaza con
  `SessionWindowReopenedError`, una subclase de `OutsideSessionWindowError`
  con `template`, `queued` y `templateResult`. El código que ya maneja
  `OutsideSessionWindowError` sigue funcionando.
- **`onReopened: 'resolve'`**: `send()` resuelve con el resultado del envío
  de la plantilla, y `raw` es `{ queued, template, result }`. Úsalo cuando
  quien envía no deba ver un error (por ejemplo, `ctx.reply` dentro de los
  handlers).

```ts
import { SessionWindowReopenedError } from '@botmesh/meta'

try {
  await bot.sendTo(chatId, 'Your invoice is attached')
} catch (err) {
  if (err instanceof SessionWindowReopenedError) {
    // err.template went out; err.queued === true → delivered when the user replies
  } else throw err
}
```

Si falla la propia plantilla de reapertura, `send()` rechaza (con el error
`131047` original cuando lo hubo), el resultado es `reopen-failed` y el
contenido **no** queda en cola. Si no se resuelve ninguna plantilla para el
contenido, el resultado es `no-template` y se lanza el error original.

### Elegir la plantilla

- `reopenTemplate`: una plantilla para cualquier contenido, o un resolver
  `(ctx) => SessionTemplate | undefined` (síncrono o asíncrono). `ctx` trae
  `chatId`, `content`, `reason` (`'error'`, `'proactive'` o `'status'`) y
  `lastInboundAt`. Devuelve `undefined` para no reabrir.
- `reopenTemplateByKind`: una plantilla por tipo de contenido (`text`,
  `image`, `document`...); tiene prioridad sobre `reopenTemplate`.

```ts
sessionWindow: {
  reopenTemplate: async ({ chatId }) => {
    const lang = await users.language(chatId)
    return { kind: 'template', name: 'resume_conversation', language: lang }
  },
}
```

Los envíos simultáneos a un mismo chat cerrado comparten **un solo** envío
de plantilla y, mientras un chat reabierto espera la respuesta, los envíos
siguientes se encolan sin mandar otra plantilla.

### Notificaciones

`onReport(report)` recibe cada resultado (los errores lanzados dentro se
ignoran). `report` trae `chatId`, `outcome` y, según el caso, `reason`,
`content`, `template`, `result` y `error`.

| `outcome` | Significado |
| --- | --- |
| `queued` | Contenido encolado; se envió la plantilla de reapertura (o ya estaba pendiente) |
| `reopened` | Plantilla enviada; contenido no encolado (`retryOnReply: false`) |
| `sent` | Contenido encolado entregado tras la respuesta del usuario |
| `failed` | El contenido encolado volvió a fallar al reintentarlo |
| `expired` | Contenido encolado más antiguo que `pendingTtlMs` cuando el usuario respondió |
| `dropped` | Contenido descartado: la cola del chat o la tabla de chats estaba llena, o `clearPending()` |
| `no-template` | Ninguna plantilla configurada o resuelta: no se reabrió nada |
| `reopen-failed` | Falló la propia plantilla de reapertura |

## Opciones

| Opción | Por defecto | Descripción |
| --- | --- | --- |
| `reopenTemplate` | — | Plantilla, o `(ctx) => plantilla \| undefined` |
| `reopenTemplateByKind` | — | Plantilla por tipo de contenido (gana a `reopenTemplate`) |
| `proactive` | `true` | Saltarse el envío libre cuando la ventana se sabe cerrada (solo si se resuelve una plantilla) |
| `retryOnReply` | `true` | Encolar el contenido y reintentarlo cuando el usuario responde |
| `onReopened` | `'reject'` | `'reject'` (lanza `SessionWindowReopenedError`) o `'resolve'` |
| `onReport` | — | Callback de resultados |
| `store` | `MemorySessionWindowStore` | Dónde vive el estado de la ventana |
| `windowMs` | 24 h | Duración de la ventana |
| `maxPendingPerChat` | `20` | Envíos encolados por chat (se descarta el más antiguo) |
| `maxPendingChats` | `1000` | Chats con envíos encolados (se descarta la cola del chat más antiguo) |
| `pendingTtlMs` | 24 h | Los envíos encolados más antiguos se descartan al llegar la respuesta |
| `maxTrackedSends` | `500` | Envíos libres recordados para reaccionar a estados `131047` asíncronos (`0` lo desactiva) |
| `scope` | — | Número de negocio del gestor; `CloudAPIProvider` pone su `phoneNumberId` |
| `now` | `Date.now` | Reloj (tests) |

## Persistir el estado de la ventana

Por el store solo pasa el **estado de la ventana**: por chat,
`{ lastInboundAt?, closedAt? }` (epoch ms). El `MemorySessionWindowStore`
por defecto está acotado (`maxChats`, por defecto 10 000) y se pierde al
reiniciar. Implementa `SessionWindowStore` sobre Redis o SQL para
conservarlo entre reinicios y procesos; los métodos pueden ser síncronos o
asíncronos:

```ts
import type { SessionWindowStore } from '@botmesh/meta'

const store: SessionWindowStore = {
  async get(key) {
    const raw = await redis.hGet('wa:window', key)
    return raw ? JSON.parse(raw) : undefined
  },
  async set(key, state) { await redis.hSet('wa:window', key, JSON.stringify(state)) },
  async delete(key) { await redis.hDel('wa:window', key) },
}

new CloudAPIProvider({ /* ... */ sessionWindow: { store, reopenTemplate } })
```

La **cola de reintentos** y los envíos seguidos guardan `OutboundContent`,
así que siempre viven en memoria (acotados) y se pierden al reiniciar. Antes
de entregarle media al gestor, el provider la sube una sola vez (Buffer, ruta
o `{ stream }`) y la cola solo guarda el id de media: los reintentos nunca
vuelven a leer un stream ya consumido ni retienen bytes.

## Varios números: `forScope`

La ventana pertenece a un par **número de negocio + usuario**. El provider
acota su gestor por `phoneNumberId` y las claves del store pasan a ser
`<phoneNumberId>:<chatId>`, así que un mismo store sirve a varios números.

Para compartir un gestor (mismas opciones y store) entre providers, pasa la
instancia; cada provider obtiene su propia vista con
`forScope(phoneNumberId)`, con sus propias claves de ventana, su cola y sus
envíos seguidos:

```ts
import { SessionWindowManager } from '@botmesh/meta'

const windows = new SessionWindowManager({ store, reopenTemplate })

const sales = new CloudAPIProvider({ /* ... */ phoneNumberId: 'SALES_ID', sessionWindow: windows })
const support = new CloudAPIProvider({ /* ... */ phoneNumberId: 'SUPPORT_ID', sessionWindow: windows })

sales.sessionWindow === windows.forScope('SALES_ID') // true (memoised)
```

## Consultar un chat

`provider.sessionWindow` es el gestor (o `undefined` si no configuraste
`sessionWindow`):

```ts
const sw = provider.sessionWindow!
await sw.state(chatId)     // 'open' | 'closed' | 'unknown'
await sw.isOpen(chatId)    // true only when known open
await sw.expiresAt(chatId) // epoch ms when the window closes, or undefined
sw.pending(chatId)         // sends queued for the chat
sw.clearPending(chatId)    // drop them (each reported as 'dropped')
```

También se exportan `SESSION_WINDOW_MS` (24 h) y `SESSION_WINDOW_ERROR_CODE`
(`131047`).

## Costos y uso

Cada evento `status` de la Cloud API trae la información de facturación de
Meta normalizada en `DeliveryStatus.platformData`:

- `platformData.pricing`: `{ billable, pricingModel?, category?, type? }`.
  `pricingModel` es `PMP` (precio por mensaje, desde el 2025-07-01) o `CBP`
  (el modelo antiguo por conversación); `type` (PMP) es `regular`,
  `free_customer_service` o `free_entry_point`.
- `platformData.conversation` (cuando Meta lo envía):
  `{ id?, originType?, expiresAt? }` (`expiresAt` en epoch ms).

```ts
import { pricingOf } from '@botmesh/meta'

bot.on('status', (status) => {
  const pricing = pricingOf(status.platformData)
  if (pricing?.billable) metrics.increment(`wa.billable.${pricing.category ?? 'unknown'}`)
})
```

`provider.usage` (un `UsageTracker`, activado por defecto) agrega ese pricing
por chat y por categoría. Meta repite el pricing en `sent`, `delivered` y
`read`; cada id de mensaje se cuenta una sola vez.

```ts
const provider = new CloudAPIProvider({
  /* ... */
  usage: { rates: { marketing: 0.0625, utility: 0.008 } }, // price per billable message
})

provider.usage!.forChat(chatId) // { messages, billable, free, estimatedCost, byCategory } | undefined
provider.usage!.totals()        // the same, across every chat
provider.usage!.chats()         // chats with counters, least recently updated first
provider.usage!.reset(chatId)   // clear one chat (totals kept); reset() clears everything
```

| Opción de `usage` | Por defecto | Descripción |
| --- | --- | --- |
| `rates` | — | Precio por mensaje facturable por categoría, o `(entry) => number \| undefined` (las tarifas cambian por país). Desconocido → 0 |
| `maxChats` | `10000` | Chats con contadores propios (se expulsa el actualizado hace más tiempo; los totales se conservan) |
| `maxTrackedMessages` | `10000` | Ids de mensaje recordados para contar cada mensaje una vez |

`usage: false` desactiva el conteo (el pricing sigue llegando a
`platformData`). También puedes pasar tu propia instancia de `UsageTracker`,
por ejemplo para compartirla entre providers. `estimatedCost` es solo la suma
de las tarifas que configuraste: la factura de Meta es la fuente de verdad.

## Ver también

- [Canales](/es/guide/canales): todos los providers y sus capacidades.
- [README de `@botmesh/meta`](https://github.com/andresayac/botmesh/tree/main/packages/meta-provider)
