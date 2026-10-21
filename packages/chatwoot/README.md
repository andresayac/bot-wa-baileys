# @botmesh/chatwoot

> **Experimental — aún no publicado en npm.** Paquete `private` del monorepo: úsalo con `workspace:*`; su API puede cambiar.

Integración de [Chatwoot](https://www.chatwoot.com) para [`@botmesh/core`](../core), construida sobre la API de *human handoff* del core (`ctx.handoff()`, `bot.resume()`, `bot.sendTo()` y los eventos `'handoff'`/`'resume'`).

- **Sincronización bidireccional:** cada mensaje entrante (también durante el handoff) se publica como `incoming` en Chatwoot y cada envío del bot como `outgoing`.
- **Mapeo chat ↔ contacto/conversación** persistido en el store del bot (API de cursores, con namespace por bot): sobrevive a reinicios.
- **Webhook de agente → `bot.sendTo`**, autenticado con token compartido y/o HMAC-SHA256 sobre el body crudo.
- **Auto-handoff** cuando un agente responde, y **`bot.resume()`** cuando la conversación se marca como resuelta.
- **Labels** al hacer handoff/resume, por mensaje (`labels.message`) o a mano (`addLabels`/`removeLabels`).
- Todo el HTTP saliente pasa por `secureFetch` de [`@botmesh/http`](../http) (HTTPS, anti-SSRF, timeouts, sin seguir redirecciones).

## Uso

```ts
import { createServer } from 'node:http'
import { Bot } from '@botmesh/core'
import { chatwootPlugin } from '@botmesh/chatwoot'

const bot = new Bot({ provider, handoff: { allowCommands: ['/bot'] } })

const chatwoot = chatwootPlugin({
  baseUrl: 'https://app.chatwoot.com',
  apiKey: process.env.CHATWOOT_TOKEN!,      // access token de un usuario/agente
  accountId: 1,
  inboxId: 2,                               // inbox de tipo "API"
  webhookToken: process.env.CHATWOOT_WEBHOOK_TOKEN!,
  labels: { handoff: ['humano'], resume: ['bot'] },
})
bot.plug(chatwoot)

bot.when('hablar con humano', async (ctx) => {
  await ctx.handoff({ reason: 'el usuario pidió un agente' })
  await ctx.reply('Te conecto con un agente…')
})

// En Chatwoot: Settings → Integrations → Webhooks →
//   https://bot.example.com/chatwoot?token=<CHATWOOT_WEBHOOK_TOKEN>
//   eventos: message_created, conversation_status_changed
createServer(chatwoot.webhookHandler()).listen(3001)
await bot.start()
```

¿Usas Express/Fastify? Pasa el body **crudo**:

```ts
app.post('/chatwoot', express.raw({ type: '*/*' }), async (req, res) => {
  const r = await chatwoot.handleWebhook({ rawBody: req.body, headers: req.headers, query: req.query })
  res.status(r.status).send(r.body)
})
```

## Flujo

| Evento | Qué hace el plugin |
| --- | --- |
| Mensaje entrante | `incoming` en la conversación del chat (la crea la primera vez). En grupos, el texto va prefijado con el nombre del participante. |
| El bot envía | `outgoing` (los medios se reflejan como `[image] caption`, etc.). |
| `ctx.handoff()` / `bot.handoff()` | Conversación `open`, nota privada (`handoffNote`) y `labels.handoff`. |
| Respuesta pública de un agente (webhook `message_created`) | `bot.handoff()` si `autoHandoff` y el chat no está en handoff; luego `bot.sendTo()` (adjuntos por URL). No se re-refleja en Chatwoot y un reenvío del mismo mensaje (mismo id) se ignora. |
| Conversación resuelta (webhook `conversation_status_changed`, o `conversation_updated` solo si `changed_attributes` trae el cambio de `status`) | `bot.resume(chatId, { reason: 'chatwoot:resolved' })`. |
| `bot.resume()` por otra causa | Conversación `resolved` (`resolveOnResume`), quita `labels.handoff`, añade `labels.resume`. |

Se ignoran: notas privadas, mensajes `incoming`, mensajes de *agent bots*, otros inboxes, conversaciones desconocidas y los ecos de los mensajes que creó el propio plugin.

## Opciones

| Opción | Por defecto | Descripción |
| --- | --- | --- |
| `baseUrl`, `apiKey`, `accountId`, `inboxId` | — | Conexión a Chatwoot (obligatorias). |
| `webhookToken` / `webhookSecret` | — | Al menos una (o `insecureNoWebhookAuth: true`). Token en `?token=`, `x-chatwoot-token` o `Authorization: Bearer`. HMAC en `x-chatwoot-signature` (hex, admite `sha256=`), sobre el body crudo o sobre `${timestamp}.${body}` si llega `x-chatwoot-timestamp`. |
| `webhookToleranceSec` | `300` | Desfase admitido del timestamp firmado. |
| `autoHandoff` | `true` | Pausar el bot cuando responde un agente. |
| `resumeOnResolve` | `true` | Reanudar el bot al resolver la conversación. |
| `resolveOnResume` | `true` | Resolver la conversación cuando el bot se reanuda por otra vía. |
| `handoffNote` | `'🤖 → 👤 Handoff: {{reason}}'` | Nota privada al hacer handoff; `false` la desactiva. |
| `syncInbound` / `syncOutbound` | `true` | Reflejar entrantes / envíos del bot. |
| `syncMode` | `'all'` | `'handoff'` solo refleja chats que están en handoff. |
| `labels` | — | `{ handoff?, resume?, message?(ctx) }`. |
| `contact(chatId, ctx)` | — | Datos de contacto nuevo (`name`, `phoneNumber`, `email`, `customAttributes`). El core no deriva teléfonos del id. |
| `forwardAttachments` | `true` | Reenviar adjuntos del agente como media por URL. |
| `http` | — | `{ fetch, resolver, allowHttp, allowPrivateHosts, timeoutMs }` (Chatwoot self-hosted en LAN necesita `allowPrivateHosts`). |
| `storage` | store del bot | `{ get, set }` de strings para el mapeo. |
| `onError(error, context)` | log `warn` | Errores de sincronización; nunca rompen el bot. |

## API

`chatwootPlugin()` devuelve el plugin con estos métodos (también en `ctx.tools.chatwoot`):

- `handleWebhook({ rawBody, headers, query })` → `{ status, body }` (401 sin auth, 400 JSON inválido, 503 si aún no está instalado).
- `webhookHandler({ maxBytes })` → handler de `node:http` (solo `POST`, límite 1 MiB).
- `conversationOf(chatId)`, `chatOf(conversationId)`.
- `addLabels(chatId, labels)`, `removeLabels(chatId, labels)`.
- `flush()` — espera a que termine la sincronización pendiente (tests, apagado ordenado).
- `client` — `ChatwootClient` (contactos, conversaciones, mensajes, estado, labels).

## Limitaciones

- Los medios entrantes se reflejan como texto (`[image] caption`), no se suben como adjuntos.
- Un chat ↔ una conversación; si Chatwoot devuelve 404 para la conversación mapeada se crea otra.
- Resolver la conversación en Chatwoot **reanuda el bot** (`bot.resume()`), pero **no cierra ningún ticket**: el plugin no conoce [`@botmesh/tickets`](../tickets) (ni ningún otro sistema de tickets) y no se acopla a él. Si usas ambos, ciérralo tú en el evento `'resume'`:

  ```ts
  bot.on('resume', async ({ chatId, reason }) => {
    if (reason !== 'chatwoot:resolved') return
    const tickets = bot.injectTools.tickets
    for (const t of (await tickets?.list({ chatId, status: ['open', 'assigned', 'pending'] })) ?? []) {
      await tickets!.close(t.id, { reason: 'chatwoot:resolved' })
    }
  })
  ```
