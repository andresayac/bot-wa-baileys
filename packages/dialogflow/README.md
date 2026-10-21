# @botmesh/dialogflow

> **Experimental — aún no publicado en npm.** Implementación real y probada, pero el paquete es `private`: no forma parte de la primera alpha y su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Contexto de NLU con **Dialogflow ES y CX** para [`@botmesh/core`](../core). Cada mensaje de texto pasa por `detectIntent` (API REST) y la intención detectada rutea a un handler o a un flow; los parámetros de Dialogflow llegan a `c.state`.

Sin SDK de Google: la autenticación es un JWT de cuenta de servicio firmado con `node:crypto` (RS256) que se canjea por un access token, y todas las peticiones salen por `secureFetch` de [`@botmesh/http`](../http).

## Uso

```ts
import { Bot, flow } from '@botmesh/core'
import { dialogflowContext, whenDialogflowIntent } from '@botmesh/dialogflow'

const bot = new Bot({ provider })

bot.plug(dialogflowContext({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS!), // JSON de la cuenta de servicio
  languageCode: 'es',
  fulfillment: 'unrouted',     // responde con el texto del agente si la intención no tiene ruta
}))

const df = bot.injectTools.dialogflow!

// Handler: recibe el resultado normalizado
whenDialogflowIntent(bot, df, 'order.status', (ctx, r) =>
  ctx.reply(`Buscando el pedido ${String(r.parameters.order)}…`))

// Flow: los parámetros se copian en c.state antes del primer paso
whenDialogflowIntent(bot, df, 'book.table', flow('reserva')
  .say((_ctx, c) => `Reserva para ${String(c.state.people)} personas`)
  .ask('¿A nombre de quién?', 'name'))

bot.onMessage((ctx) => ctx.reply('No te entendí'))   // lo que no rutea cae aquí
```

También puedes declarar las rutas en la config: `routes: { 'book.table': reservaFlow, greeting: (ctx) => ctx.reply('¡Hola!') }`.

### Dialogflow CX

```ts
bot.plug(dialogflowContext({
  credentials,
  cx: { agentId: 'xxxxxxxx-xxxx-…', location: 'us-central1', environment: 'prod' },
  languageCode: 'es',
}))
```

## Cómo funciona

1. Un hook `before('message')` (prioridad `0`; la moderación corre antes, en `100`) llama a `detectIntent` y guarda el resultado asociado a **ese** mensaje.
2. `whenDialogflowIntent` registra un predicado de `bot.when` que lee ese resultado (sin volver a llamar a Dialogflow). Si la intención coincide y supera `minConfidence`, se ejecuta el destino; si no, el mensaje sigue su camino normal (`onMessage`, otros matchers…).
3. No se envían a Dialogflow: mensajes vacíos, interacciones, comandos (`/…`, configurable con `commandPrefix`), mensajes de un usuario dentro de una conversación activa (`skipActiveConversation`), mensajes de un chat en handoff (`bot.isHandedOff()`: lo atiende un humano) y los que descarte `filter`.
4. Si `detectIntent` falla, se registra en el logger, se llama a `onError` y el mensaje sigue llegando a los demás handlers.

**Sesiones:** una sesión de Dialogflow por chat (`sessionScope: 'chat'`, por defecto) o por participante en grupos (`'participant'`), o la clave que devuelva `sessionKey(ctx)`. La clave se convierte en un id de sesión con SHA-256 (32 caracteres), así que el número de teléfono o el id del chat no se envían a Google.

## Configuración

| Opción | Tipo | Defecto | Descripción |
| --- | --- | --- | --- |
| `credentials` | `ServiceAccountCredentials` | — | JSON de la cuenta de servicio (`client_email`, `private_key`, `project_id`…). Acepta `\n` literales en la clave |
| `tokenSource` | `{ getAccessToken() }` | — | Alternativa a `credentials` |
| `projectId` | `string` | `credentials.project_id` | Proyecto de Google Cloud |
| `languageCode` | `string` | `'es'` | Idioma de las consultas |
| `languageFor` | `(ctx) => string \| undefined` | — | Idioma por mensaje |
| `queryParams` | `(ctx) => object \| undefined` | — | `queryParams` crudos por mensaje (contexts, payload, parameters…) |
| `cx` | `{ agentId, location, environment? }` | — | Usa Dialogflow CX |
| `location` / `environment` | `string` | global / draft | Solo ES: agente regional o entorno publicado |
| `minConfidence` | `number` | `0` | Confianza mínima para rutear |
| `sessionScope` | `'chat' \| 'participant'` | `'chat'` | Granularidad de la sesión |
| `sessionKey` | `(ctx) => string` | — | Clave de sesión propia |
| `routes` | `Record<string, handler \| flow>` | — | Rutas registradas al instalar |
| `fulfillment` | `'off' \| 'unrouted' \| 'all'` | `'off'` | Respuesta automática con los textos del agente |
| `commandPrefix` | `string \| false` | `'/'` | Los comandos no se envían a Dialogflow |
| `skipActiveConversation` | `boolean` | `true` | No consultar dentro de una conversación |
| `filter` | `(ctx) => boolean` | — | `false` = no consultar |
| `priority` | `number` | `0` | Prioridad del hook `before('message')` |
| `client` | `DialogflowClient` | — | Cliente ya construido (en lugar de crearlo desde la config) |
| `onError` | `(error, ctx) => void` | — | Errores de `detectIntent` |
| `http` | `{ fetch?, resolver?, timeoutMs?, maxBytes? }` | — | Opciones de `secureFetch` (útil en tests) |

## Resultado normalizado

```ts
interface DialogflowResult {
  intent: string | null        // displayName; null en CX NO_MATCH
  intentId?: string
  confidence: number
  isFallback: boolean
  parameters: Record<string, unknown>
  allRequiredParamsPresent: boolean
  messages: string[]           // textos de respuesta en orden
  fulfillmentText: string
  action?: string              // ES
  page?: string                // CX
  raw: unknown                 // queryResult crudo
}
```

`ctx.tools.dialogflow.resultFor(ctx)` devuelve el resultado del mensaje actual desde cualquier handler. `DialogflowClient` también se puede usar por separado: `new DialogflowClient({ credentials }).detectIntent(sessionId, 'hola')`.

## Errores

Credenciales inválidas lanzan `DialogflowError` de forma **síncrona** al hacer `bot.plug()`. Los fallos de red/API (`status`, `code` como `'PERMISSION_DENIED'`) se reportan por `onError` sin cortar el pipeline.
