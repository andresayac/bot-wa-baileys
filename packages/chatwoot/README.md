# @botmesh/chatwoot

> **Experimental — not yet published on npm.** `private` package of the monorepo: use it with `workspace:*`; its API may change.

[Chatwoot](https://www.chatwoot.com) integration for [`@botmesh/core`](../core), built on the core's *human handoff* API (`ctx.handoff()`, `bot.resume()`, `bot.sendTo()` and the `'handoff'`/`'resume'` events).

- **Two-way sync:** every inbound message (also during handoff) is posted as `incoming` in Chatwoot and every bot send as `outgoing`.
- **Chat ↔ contact/conversation mapping** persisted in the bot store (cursors API, namespaced per bot): survives restarts.
- **Agent webhook → `bot.sendTo`**, authenticated with a shared token and/or HMAC-SHA256 over the raw body.
- **Auto-handoff** when an agent replies, and **`bot.resume()`** when the conversation is marked as resolved.
- **Labels** on handoff/resume, per message (`labels.message`) or manually (`addLabels`/`removeLabels`).
- All outbound HTTP goes through `secureFetch` from [`@botmesh/http`](../http) (HTTPS, anti-SSRF, timeouts, no redirect following).

## Usage

```ts
import { createServer } from 'node:http'
import { Bot } from '@botmesh/core'
import { chatwootPlugin } from '@botmesh/chatwoot'

const bot = new Bot({ provider, handoff: { allowCommands: ['/bot'] } })

const chatwoot = chatwootPlugin({
  baseUrl: 'https://app.chatwoot.com',
  apiKey: process.env.CHATWOOT_TOKEN!,      // access token of a user/agent
  accountId: 1,
  inboxId: 2,                               // inbox of type "API"
  webhookToken: process.env.CHATWOOT_WEBHOOK_TOKEN!,
  labels: { handoff: ['human'], resume: ['bot'] },
})
bot.plug(chatwoot)

bot.when('talk to a human', async (ctx) => {
  await ctx.handoff({ reason: 'the user asked for an agent' })
  await ctx.reply('Connecting you to an agent…')
})

// In Chatwoot: Settings → Integrations → Webhooks →
//   https://bot.example.com/chatwoot?token=<CHATWOOT_WEBHOOK_TOKEN>
//   events: message_created, conversation_status_changed
createServer(chatwoot.webhookHandler()).listen(3001)
await bot.start()
```

Using Express/Fastify? Pass the **raw** body:

```ts
app.post('/chatwoot', express.raw({ type: '*/*' }), async (req, res) => {
  const r = await chatwoot.handleWebhook({ rawBody: req.body, headers: req.headers, query: req.query })
  res.status(r.status).send(r.body)
})
```

## Flow

| Event | What the plugin does |
| --- | --- |
| Inbound message | `incoming` in the chat's conversation (created on first use). In groups, the text is prefixed with the participant's name. |
| The bot sends | `outgoing` (media is mirrored as `[image] caption`, etc.). |
| `ctx.handoff()` / `bot.handoff()` | `open` conversation, private note (`handoffNote`) and `labels.handoff`. |
| Public reply from an agent (`message_created` webhook) | `bot.handoff()` if `autoHandoff` and the chat is not already handed off; then `bot.sendTo()` (attachments by URL). It is not mirrored back into Chatwoot, and a re-delivery of the same message (same id) is ignored. |
| Conversation resolved (`conversation_status_changed` webhook, or `conversation_updated` only when `changed_attributes` carries the `status` change) | `bot.resume(chatId, { reason: 'chatwoot:resolved' })`. |
| `bot.resume()` for another reason | `resolved` conversation (`resolveOnResume`), removes `labels.handoff`, adds `labels.resume`. |

Ignored: private notes, `incoming` messages, *agent bot* messages, other inboxes, unknown conversations and echoes of the messages the plugin itself created.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl`, `apiKey`, `accountId`, `inboxId` | — | Chatwoot connection (required). |
| `webhookToken` / `webhookSecret` | — | At least one (or `insecureNoWebhookAuth: true`). Token in `?token=`, `x-chatwoot-token` or `Authorization: Bearer`. HMAC in `x-chatwoot-signature` (hex, accepts `sha256=`), over the raw body or over `${timestamp}.${body}` when `x-chatwoot-timestamp` is present. |
| `webhookToleranceSec` | `300` | Allowed clock skew of the signed timestamp. |
| `autoHandoff` | `true` | Pause the bot when an agent replies. |
| `resumeOnResolve` | `true` | Resume the bot when the conversation is resolved. |
| `resolveOnResume` | `true` | Resolve the conversation when the bot resumes another way. |
| `handoffNote` | `'🤖 → 👤 Handoff: {{reason}}'` | Private note on handoff; `false` disables it. |
| `syncInbound` / `syncOutbound` | `true` | Mirror inbound messages / bot sends. |
| `syncMode` | `'all'` | `'handoff'` mirrors only chats that are handed off. |
| `labels` | — | `{ handoff?, resume?, message?(ctx) }`. |
| `contact(chatId, ctx)` | — | New contact data (`name`, `phoneNumber`, `email`, `customAttributes`). The core does not derive phone numbers from the id. |
| `forwardAttachments` | `true` | Forward agent attachments as media by URL. |
| `http` | — | `{ fetch, resolver, allowHttp, allowPrivateHosts, timeoutMs }` (a self-hosted Chatwoot on a LAN needs `allowPrivateHosts`). |
| `storage` | bot store | String `{ get, set }` for the mapping. |
| `onError(error, context)` | `warn` log | Sync errors; they never break the bot. |

## API

`chatwootPlugin()` returns the plugin with these methods (also available under `ctx.tools.chatwoot`):

- `handleWebhook({ rawBody, headers, query })` → `{ status, body }` (401 without auth, 400 invalid JSON, 503 if it is not installed yet).
- `webhookHandler({ maxBytes })` → `node:http` handler (`POST` only, 1 MiB limit).
- `conversationOf(chatId)`, `chatOf(conversationId)`.
- `addLabels(chatId, labels)`, `removeLabels(chatId, labels)`.
- `flush()` — waits for pending sync to finish (tests, graceful shutdown).
- `client` — `ChatwootClient` (contacts, conversations, messages, status, labels).

## Limitations

- Inbound media is mirrored as text (`[image] caption`); it is not uploaded as an attachment.
- One chat ↔ one conversation; if Chatwoot returns 404 for the mapped conversation, a new one is created.
- Resolving the conversation in Chatwoot **resumes the bot** (`bot.resume()`), but **does not close any ticket**: the plugin does not know about [`@botmesh/tickets`](../tickets) (or any other ticketing system) and does not couple to it. If you use both, close it yourself in the `'resume'` event:

  ```ts
  bot.on('resume', async ({ chatId, reason }) => {
    if (reason !== 'chatwoot:resolved') return
    const tickets = bot.injectTools.tickets
    for (const t of (await tickets?.list({ chatId, status: ['open', 'assigned', 'pending'] })) ?? []) {
      await tickets!.close(t.id, { reason: 'chatwoot:resolved' })
    }
  })
  ```
