# Integrations

::: warning Experimental — not published yet
The four packages on this page are **experimental**: real, tested
implementations that are still private (not on npm, not part of the first
alpha) and whose API may change. Use them from the monorepo (`workspace:*`).
:::

| Package | What it does | Tool |
| --- | --- | --- |
| [`@bot-wa/chatwoot`](#chatwoot) | Mirrors chats into a Chatwoot inbox; Chatwoot agents take over through the core handoff | `ctx.tools.chatwoot` |
| [`@bot-wa/tickets`](#tickets) | Support tickets with a priority queue, working hours and store persistence | `ctx.tools.tickets` |
| [`@bot-wa/moderation`](#moderation) | Group moderation: anti-spam, word/link filters, warn/mute/kick/delete | `ctx.tools.moderation` |
| [`@bot-wa/dialogflow`](#dialogflow) | Dialogflow ES/CX intent detection and intent-to-flow routing | `ctx.tools.dialogflow` |

All four are regular plugins (`bot.plug(factory({...}))`) with a
synchronous `install`. Importing a package types its `ctx.tools.*` entry;
outside a handler, use `bot.injectTools.<name>`.

```json
{
  "dependencies": {
    "@bot-wa/chatwoot": "workspace:*",
    "@bot-wa/tickets": "workspace:*",
    "@bot-wa/moderation": "workspace:*",
    "@bot-wa/dialogflow": "workspace:*"
  }
}
```

## How they fit in the pipeline

Three of them hook `before('message')`. Higher priority runs first, so the
order does not depend on the order you call `bot.plug()`:

| Plugin | Hook | Priority | Effect |
| --- | --- | --- | --- |
| chatwoot | `before('message')`, `after('send')` | `1000` | Mirrors every inbound message and every bot send, then calls `next()` |
| moderation | `before('message')` | `100` (`priority`) | `abort()`s a message that breaks a rule or comes from a muted user |
| dialogflow | `before('message')` | `0` (`priority`) | Runs `detectIntent` and stores the result for that message (skipped while the chat is in handoff) |

What follows from that:

- Chatwoot sees messages that moderation later drops (the agent gets the
  full picture).
- A message moderation drops never reaches Dialogflow, commands or handlers.
- `before('message')` hooks keep running while a chat is in
  [handoff](/guide/handoff), so moderation and Chatwoot keep working there.
  Dialogflow's hook skips handed-off chats: no `detectIntent` call is made
  while a human is in charge (see [Dialogflow](#dialogflow)).
- Dialogflow routes are `bot.when` predicates, so they win over the
  `aiPlugin` catch-all whatever the plug order. The rule "install
  `aiPlugin` after `slashCommandsPlugin`" still applies; these plugins do
  not change it.

## Chatwoot

Bridges the bot with an **API channel** inbox in
[Chatwoot](https://www.chatwoot.com), on top of the core
[handoff API](/guide/handoff).

```ts
import { createServer } from 'node:http'
import { Bot } from '@bot-wa/core'
import { chatwootPlugin } from '@bot-wa/chatwoot'

const bot = new Bot({ provider, store, handoff: { allowCommands: ['/bot'] } })

const chatwoot = chatwootPlugin({
  baseUrl: 'https://app.chatwoot.com',
  apiKey: process.env.CHATWOOT_TOKEN!,           // access token of a user/agent
  accountId: 1,
  inboxId: 2,                                    // an "API" inbox
  webhookToken: process.env.CHATWOOT_WEBHOOK_TOKEN!,
  labels: { handoff: ['human'], resume: ['bot'] },
})
bot.plug(chatwoot)

bot.when('talk to a human', async (ctx) => {
  await ctx.handoff({ reason: 'user asked for an agent' })
  await ctx.reply('Connecting you with an agent…')
})

// Chatwoot: Settings → Integrations → Webhooks
//   URL: https://bot.example.com/chatwoot?token=<CHATWOOT_WEBHOOK_TOKEN>
//   events: message_created, conversation_status_changed
createServer(chatwoot.webhookHandler()).listen(3001)
await bot.start()
```

With Express or Fastify, pass the **raw** body:

```ts
app.post('/chatwoot', express.raw({ type: '*/*' }), async (req, res) => {
  const r = await chatwoot.handleWebhook({ rawBody: req.body, headers: req.headers, query: req.query })
  res.status(r.status).send(r.body)
})
```

### What it does

| Event | Plugin behavior |
| --- | --- |
| Inbound message (also during handoff) | Posted as `incoming` in the chat's conversation (created on first use). In groups the text is prefixed with the participant's name |
| The bot sends | Posted as `outgoing`. Media is mirrored as text (`[image] caption`…) |
| `ctx.handoff()` / `bot.handoff()` | Conversation set to `open`, private note (`handoffNote`), `labels.handoff` added. When the handoff came from Chatwoot itself (`reason` starting with `chatwoot:`), only the labels are added |
| Public agent reply (`message_created`) | `bot.handoff(chatId, { reason: 'chatwoot:agent' })` if `autoHandoff` and the chat is not handed off; then `bot.sendTo()` (attachments by URL). Never mirrored back; a redelivery of the same message id is ignored |
| Conversation resolved (`conversation_status_changed`, `conversation_resolved`, or `conversation_updated` with a `status` change) | `bot.resume(chatId, { reason: 'chatwoot:resolved' })` when the chat is handed off (`resumeOnResolve`). It only ends the handoff: it does not close any ticket |
| `bot.resume()` for any other reason | Conversation `resolved` (`resolveOnResume`), `labels.handoff` removed, `labels.resume` added |

Ignored webhooks: private notes, `incoming` messages, agent-bot messages,
other inboxes, unknown conversations and echoes of messages the plugin
created itself.

Each chat maps to one Chatwoot contact (`identifier` = chat id) and one
conversation. The mapping lives in the bot store through the cursor API
(`chatwoot:chat:<chatId>`, `chatwoot:conv:<id>`), so it survives restarts
with a persistent store. Chat ids are only used as opaque keys.

### Chatwoot options

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl`, `apiKey`, `accountId`, `inboxId` | — | Chatwoot connection (required) |
| `webhookToken` / `webhookSecret` | — | At least one, or `insecureNoWebhookAuth: true` |
| `webhookToleranceSec` | `300` | Allowed skew of a signed timestamp |
| `autoHandoff` | `true` | Pause the bot when an agent replies |
| `resumeOnResolve` | `true` | Resume the bot when the conversation is resolved |
| `resolveOnResume` | `true` | Resolve the conversation when the bot resumes for another reason |
| `handoffNote` | `'🤖 → 👤 Handoff: {{reason}}'` | Private note on handoff; `false` disables it |
| `syncInbound` / `syncOutbound` | `true` | Mirror inbound messages / bot sends |
| `syncMode` | `'all'` | `'handoff'` mirrors only chats that are handed off |
| `labels` | — | `{ handoff?, resume?, message?(ctx) }` |
| `contact(chatId, ctx)` | — | Data for a new contact (`name`, `phoneNumber`, `email`, `customAttributes`). The core never derives a phone number from the id |
| `forwardAttachments` | `true` | Send agent attachments to the chat as media by URL |
| `http` | — | `{ fetch, resolver, allowHttp, allowPrivateHosts, timeoutMs }` (default timeout 15 s) |
| `storage` | bot store | Custom `{ get, set }` string key/value for the mapping |
| `onError(error, context)` | `warn` log | Sync errors; they never break the bot |

`ctx.tools.chatwoot` (also the object returned by `chatwootPlugin()`):
`handleWebhook()`, `webhookHandler({ maxBytes })`, `conversationOf(chatId)`,
`chatOf(conversationId)`, `addLabels(chatId, labels)`,
`removeLabels(chatId, labels)`, `flush()` (waits for pending sync, useful
on shutdown and in tests) and `client` (`ChatwootClient`).

### Security

- **Webhook auth is mandatory**: the factory throws without
  `webhookToken`, `webhookSecret` or `insecureNoWebhookAuth: true`. Keep
  the last one for an endpoint that is not reachable from outside.
- The token is accepted in `?token=`, `x-chatwoot-token` or
  `Authorization: Bearer`. The HMAC-SHA256 signature goes in
  `x-chatwoot-signature` (hex, `sha256=` prefix allowed) and is computed
  over the **raw body**, or over `${timestamp}.${body}` when
  `x-chatwoot-timestamp` is present. Comparisons are constant-time.
- `handleWebhook` answers `401` without valid auth, `400` on invalid JSON
  and `503` before the plugin is installed; it never throws.
  `webhookHandler` only accepts `POST` and caps the body at 1 MiB.
- Outgoing HTTP goes through `secureFetch` from `@bot-wa/http`: HTTPS only,
  SSRF guard, timeouts and no redirects, so `api_access_token` never
  reaches another origin. A self-hosted Chatwoot on a LAN needs
  `http.allowPrivateHosts` (and `http.allowHttp` for plain HTTP).
- With `syncMode: 'all'` every conversation is copied to Chatwoot. Use
  `syncMode: 'handoff'` if only escalated chats should leave the bot.

### Chatwoot limitations

- Inbound media is mirrored as text (`[image] caption`), not uploaded.
- One chat, one conversation. If Chatwoot answers 404 for the mapped
  conversation, a new one is created.
- Without cursor support in the store the mapping lives in memory (a
  warning is logged at install).

## Tickets

Support tickets and a queue as `ctx.tools.tickets`.

```ts
import { ticketsPlugin } from '@bot-wa/tickets'

bot.plug(ticketsPlugin({
  workingHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  timezone: 'America/Bogota',
  queueMessage: 'You are in the queue, position {{position}} (ticket #{{id}})',
  closedMessage: 'We are closed; we will answer when we open (ticket #{{id}})',
  assignMessage: '{{assignee}} is handling your ticket #{{id}}',
  closeMessage: 'Ticket #{{id}} closed. Thanks!',
  handoffOnAssign: true,   // bot.handoff(chatId) on assign
  resumeOnClose: true,     // bot.resume(chatId) on close
  onAssign: async (ticket) => notifyAgent(ticket),
}))

bot.when('support', async (ctx) => {
  const ticket = await ctx.tools.tickets!.create({ chatId: ctx.from, subject: ctx.body, priority: 'normal' })
  if (!ticket.created) await ctx.reply(`You already have ticket #${ticket.id}`)
})

// Agent panel / your own API
const tickets = bot.injectTools.tickets!
await tickets.assign('1', 'ana')
await tickets.close('1', { reason: 'solved' })
```

### API

| Method | Description |
| --- | --- |
| `create({ chatId, subject, priority?, meta? })` | Creates an `open` ticket. Resolves with the ticket plus `created`, `position` (1-based or `null`) and `withinWorkingHours`. With `reuseOpen` (default `true`) it returns the chat's non-closed ticket instead (`created: false`) |
| `get(id)` | The ticket or `undefined` |
| `update(id, patch)` | `subject`, `priority`, `status`, `assignee` (`null` unassigns and puts it back in the queue), `meta`. Rejects with `TicketNotFoundError` |
| `list(filter?)` | By `status` (one or several), `chatId`, `assignee`, `priority`; oldest first |
| `assign(id, assignee)` | Status `assigned`; fires `onAssign` |
| `close(id, { reason? })` | Status `closed`, sets `closedAt` and `closeReason`; fires `onClose` |
| `queue()` | `open` tickets by priority (`urgent` > `high` > `normal` > `low`), then age |
| `position(id)` | Queue position or `null` |
| `isOpen(date?)` | Inside working hours (always `true` without `workingHours`) |

Statuses: `open` (queued), `assigned`, `pending` (waiting on the customer,
out of the queue) and `closed`. Ids are sequential strings (`'1'`, `'2'`…).

### Ticket options

| Option | Default | Description |
| --- | --- | --- |
| `workingHours` | — | `'9-18'`, `'09:30-18:15'`, `{ days, start, end }` (`0` = Sunday … `6` = Saturday), an array of windows, or `(date) => boolean`. The end is exclusive; `'22-6'` wraps past midnight |
| `timezone` | process timezone | IANA zone used to evaluate `workingHours` (an unknown zone throws at plug time) |
| `queueMessage` / `closedMessage` | — | Sent on create, inside / outside working hours (`closedMessage` falls back to `queueMessage`) |
| `assignMessage` / `closeMessage` | — | Sent on assign / close |
| `handoffOnAssign` | `false` | `bot.handoff(chatId, { reason: 'ticket:assigned' })` on assign |
| `resumeOnClose` | `false` | `bot.resume(chatId, { reason: 'ticket:closed' })` on close, if the chat is handed off |
| `reuseOpen` | `true` | Return the chat's open ticket instead of creating another |
| `onCreate`, `onAssign`, `onClose`, `onUpdate(ticket, previous)` | — | Run after the change is persisted |
| `onError(error, source)` | `warn` log | Callback and notification errors; they never fail the operation |
| `storage` / `keyPrefix` | bot store / `'tickets:'` | Custom `{ get, set }` persistence and key prefix |

Templates accept `{{id}}`, `{{position}}`, `{{subject}}`, `{{priority}}`,
`{{assignee}}`, `{{status}}` and `{{reason}}`.

### Persistence

By default tickets are stored through the store cursor API
(`tickets:seq`, `tickets:index`, `tickets:t:<id>`), which all six stores
implement; with a plain `MemoryStore` they live in RAM. Only non-closed
tickets stay in memory; closed ones are read on demand. Data loads lazily
on the first call and mutations are serialized: a failed store write
rejects the call and leaves the desk unchanged. `TicketDesk` can also be
used without a bot: `new TicketDesk({ storage: memoryTicketStorage() })`.

### Ticket limitations

- There is no agent UI or agent identity: `assignee` is a free string.
  Build the panel on `bot.injectTools.tickets` and protect it yourself.
- `list()` with a filter that may include `closed` scans every id from 1
  to the last one.

## Moderation

Group moderation that runs before any handler.

```ts
import { Bot } from '@bot-wa/core'
import { moderationPlugin } from '@bot-wa/moderation'

const bot = new Bot({ provider })            // groupMode 'all' (the default)

bot.plug(moderationPlugin({
  provider,                                   // enables delete/kick/admins when supported
  antiSpam: { maxMessages: 5, windowMs: 10_000, action: 'warn' },
  wordFilter: { banned: ['spam', 'scam', /bit\.ly\/\w+/i], action: 'delete' },
  autoKickOnLink: true,                       // = linkFilter: { action: ['delete', 'kick'] }
  warnings: { max: 3, then: 'kick' },
  groups: {
    [staffGroupId]: false,                    // no moderation here
    [salesGroupId]: { wordFilter: { banned: ['free'] } },
  },
}))

bot.on('moderation', (report) => {
  // { chatId, senderId, rule, detail, ref, results: [{ action, status }], warnings }
})
```

A message that breaks a rule runs its actions and is `abort()`ed: it does
not reach commands, conversations or handlers. Messages from a muted user
are dropped until the mute expires. By default only **groups** are
moderated (`applyTo: 'all'` adds private chats). Interactions and the bot's
own messages are never moderated.

### Rules and actions

| Rule | Fields | Default action |
| --- | --- | --- |
| `antiSpam` | `maxMessages`, `windowMs` (sliding window per chat + sender) | `'warn'` |
| `wordFilter` | `banned: (string \| RegExp)[]`, `wholeWord` (default `true`) | `'delete'` |
| `linkFilter` | `groupInvites` (default `true`), `allLinks`, `allowInvites`, `allowDomains`, `invitePatterns` | `['delete', 'warn']` |

- Words are compared ignoring case and accents (`ñ` stays distinct from
  `n`) and as whole words; RegExps run on the raw text.
- Recognized invites: WhatsApp (`chat.whatsapp.com/…`), Telegram
  (`t.me/+…`, `t.me/joinchat/…`) and Discord (`discord.gg/…`,
  `discord.com/invite/…`). `allowInvites` matches the exact code.
- `action` takes one action or several in order.
- `autoKickOnLink: true` is shorthand for
  `linkFilter: { action: ['delete', 'kick'] }` and only applies when no
  `linkFilter` is set (globally or in the group override).

| Action | How it runs | Without support |
| --- | --- | --- |
| `delete` | `provider.deleteMessage(ref)` | `'unsupported'`. Without `provider` in the config it uses `ctx.delete()` and reports `'attempted'` |
| `kick` | `provider.groups.removeParticipants(chatId, [userId])` | `'unsupported'`, then falls back to `mute` (`kickFallback: 'none'` disables it) |
| `mute` | Internal state: the user's messages are ignored for `muteMs` (default 10 min) | Always available |
| `warn` | `bot.send` to the group, quoting the message and mentioning the user | `'failed'` if the send fails |

Warnings are counted per chat + user; at `warnings.max` the plugin runs
`warnings.then` and resets the count (`warnings: false` disables it). Texts
are configurable with `messages: { warn, reasons }` (`{name}`, `{reason}`,
`{count}`, `{max}`).

Admins skip every rule (`adminBypass`, default `true`): ids in `admins`,
anyone `isAdmin(chatId, userId)` approves, and the list from
`provider.groups.getAdmins(chatId)`, cached for `adminCacheMs` (default 5
min) and invalidated on `promote`/`demote` group events. When someone
leaves (`remove`), their warnings, mute and spam window are forgotten.

`ctx.tools.moderation`: `mute`, `unmute`, `isMuted`, `warnings`,
`resetWarnings`, `kick` (resolves an `ActionResult`), `setGroupRules`
(`false` disables, `undefined` removes the override) and
`invalidateAdmins`.

::: warning `groupMode` runs first
The bot's `groupMode` filter runs **before** `before('message')` hooks.
With `groupMode: 'mentions'` or `'commands'`, group messages that do not
mention the bot or are not commands never reach moderation. Use
`groupMode: 'all'` (the default) to moderate the whole group; the plugin
logs a warning at install when it sees a restrictive mode.
:::

### Moderation limitations

- State (spam windows, warnings, mutes) lives in memory and is lost on
  restart.
- No provider in the monorepo exposes `groups.removeParticipants` /
  `getAdmins` yet, so `kick` degrades to `mute` and admin detection relies
  on `admins` / `isAdmin`.

## Dialogflow

Runs every inbound text through Dialogflow ES or CX `detectIntent` and
routes the intent to a handler or a [flow](/guide/flows). No Google SDK:
the service-account JWT is signed with `node:crypto` (RS256) and all
requests go through `secureFetch`.

```ts
import { Bot, flow } from '@bot-wa/core'
import { dialogflowContext, whenDialogflowIntent } from '@bot-wa/dialogflow'

const bot = new Bot({ provider })

bot.plug(dialogflowContext({                        // alias of dialogflowPlugin
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS!), // service-account JSON
  languageCode: 'en',
  fulfillment: 'unrouted',     // reply with the agent's text when the intent has no route
}))

const df = bot.injectTools.dialogflow!

// Handler: receives the normalized result
whenDialogflowIntent(bot, df, 'order.status', (ctx, r) =>
  ctx.reply(`Looking up order ${String(r.parameters.order)}…`))

// Flow: the parameters are copied into c.state before the first step
whenDialogflowIntent(bot, df, 'book.table', flow('booking')
  .say((_ctx, c) => `Table for ${String(c.state.people)}`)
  .ask('Under what name?', 'name'))

bot.onMessage((ctx) => ctx.reply('Sorry, I did not get that'))   // unrouted messages land here
```

Routes can also go in the config:
`routes: { 'book.table': bookingFlow, greeting: (ctx) => ctx.reply('Hi!') }`.
For CX, add `cx: { agentId, location, environment? }`.

### How it works

1. The `before('message')` hook calls `detectIntent` and stores the result
   for **that** message. `ctx.tools.dialogflow.resultFor(ctx)` reads it
   from any handler.
2. `whenDialogflowIntent` registers a `bot.when` predicate that reads that
   result (no second call). If the intent matches with at least
   `minConfidence`, the target runs; otherwise the message falls through
   to other matchers and the catch-all.
3. Not sent to Dialogflow: empty messages, interactions, commands
   (`commandPrefix`, default `'/'`), messages from a chat in
   [handoff](/guide/handoff), messages from a user inside an active
   conversation (`skipActiveConversation`, default `true`) and anything
   `filter` rejects.
4. If `detectIntent` fails, it is logged, `onError(error, ctx)` is called
   and the message keeps flowing.

`fulfillment: 'all'` also answers fallback / no-match results with the
agent's text, so those messages never reach your `onMessage` or the
`aiPlugin` catch-all. Keep `'off'` or `'unrouted'` if an LLM should answer
what Dialogflow does not understand.

### Dialogflow options

| Option | Default | Description |
| --- | --- | --- |
| `credentials` | — | Service-account JSON (`client_email`, `private_key`, `project_id`…) |
| `tokenSource` | — | `{ getAccessToken() }`, alternative to `credentials` |
| `projectId` | `credentials.project_id` | Google Cloud project |
| `languageCode` / `languageFor(ctx)` | `'es'` | Query language, global / per message |
| `queryParams(ctx)` | — | Raw `queryParams` per message |
| `cx` | — | `{ agentId, location, environment? }` switches to CX |
| `location` / `environment` | global / draft | ES only: regional agent or published environment |
| `minConfidence` | `0` | Minimum confidence to route |
| `sessionScope` / `sessionKey(ctx)` | `'chat'` | One session per chat, per participant in groups (`'participant'`), or your own key |
| `routes` | — | Intent → handler or flow |
| `fulfillment` | `'off'` | `'unrouted'` or `'all'` auto-replies with the agent's texts |
| `commandPrefix` | `'/'` | `false` sends commands too |
| `skipActiveConversation` | `true` | Do not query inside a conversation |
| `filter(ctx)` | — | Return `false` to skip a message |
| `priority` | `0` | Before-hook priority |
| `onError(error, ctx)` | — | `detectIntent` failures |
| `http` | — | `{ fetch, resolver, timeoutMs, maxBytes }` for `secureFetch` |

### Security and privacy

- Invalid credentials throw `DialogflowError` **synchronously** at
  `bot.plug()`. The access token is fetched lazily on the first message,
  cached and refreshed shortly before it expires.
- The session key is hashed (SHA-256, 32 characters) before it is used as
  the Dialogflow session id, so chat ids and phone numbers are not sent to
  Google. The message **text** is.
- Keep the service-account JSON in a secret, never in the repo.

### Dialogflow limitations

- Only text is sent (no audio, no events). CX form filling lives in pages:
  `allRequiredParamsPresent` is always `true` there.

## Combining them

Tickets and Chatwoot both drive the core handoff, so they compose through
its events:

```ts
bot.plug(moderationPlugin({ provider, antiSpam: { maxMessages: 5, windowMs: 10_000 } }))
bot.plug(chatwootPlugin({ /* … */ labels: { handoff: ['human'] } }))
bot.plug(ticketsPlugin({ handoffOnAssign: true, resumeOnClose: true }))
```

Assigning a ticket calls `bot.handoff()`, and the `'handoff'` event opens
the Chatwoot conversation with its labels. Closing the ticket calls
`bot.resume()`, and Chatwoot resolves the conversation. Resolving it in
Chatwoot resumes the bot, but does not close the ticket: do that from your
own `bot.on('resume', …)` listener if you need it (the event's `reason` is
`'chatwoot:resolved'`).

## Next steps

- [Human handoff](/guide/handoff)
- [Hooks](/guide/hooks)
- [Plugins](/guide/plugins)
- [AI](/guide/ai)
