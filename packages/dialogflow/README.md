# @botmesh/dialogflow

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`).

NLU context with **Dialogflow ES and CX** for [`@botmesh/core`](../core). Every text message goes through `detectIntent` (REST API) and the detected intent routes to a handler or a flow; Dialogflow parameters land in `c.state`.

No Google SDK: authentication is a service-account JWT signed with `node:crypto` (RS256) that is exchanged for an access token, and all requests go through `secureFetch` from [`@botmesh/http`](../http).

## Usage

```ts
import { Bot, flow } from '@botmesh/core'
import { dialogflowContext, whenDialogflowIntent } from '@botmesh/dialogflow'

const bot = new Bot({ provider })

bot.plug(dialogflowContext({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS!), // service-account JSON
  languageCode: 'en',
  fulfillment: 'unrouted',     // reply with the agent text when the intent has no route
}))

const df = bot.injectTools.dialogflow!

// Handler: receives the normalized result
whenDialogflowIntent(bot, df, 'order.status', (ctx, r) =>
  ctx.reply(`Looking up order ${String(r.parameters.order)}…`))

// Flow: parameters are copied into c.state before the first step
whenDialogflowIntent(bot, df, 'book.table', flow('booking')
  .say((_ctx, c) => `Booking for ${String(c.state.people)} people`)
  .ask('What name is the booking under?', 'name'))

bot.onMessage((ctx) => ctx.reply('Sorry, I did not understand'))   // anything unrouted falls here
```

You can also declare the routes in the config: `routes: { 'book.table': bookingFlow, greeting: (ctx) => ctx.reply('Hello!') }`.

### Dialogflow CX

```ts
bot.plug(dialogflowContext({
  credentials,
  cx: { agentId: 'xxxxxxxx-xxxx-…', location: 'us-central1', environment: 'prod' },
  languageCode: 'en',
}))
```

## How it works

1. A `before('message')` hook (priority `0`; moderation runs before it, at `100`) calls `detectIntent` and stores the result linked to **that** message.
2. `whenDialogflowIntent` registers a `bot.when` predicate that reads that result (without calling Dialogflow again). If the intent matches and meets `minConfidence`, the target runs; otherwise the message continues its normal path (`onMessage`, other matchers…).
3. Not sent to Dialogflow: empty messages, interactions, commands (`/…`, configurable with `commandPrefix`), messages from a user inside an active conversation (`skipActiveConversation`), messages from a chat in handoff (`bot.isHandedOff()`: a human is handling it) and anything `filter` discards.
4. If `detectIntent` fails, it is logged, `onError` is called and the message still reaches the other handlers.

**Sessions:** one Dialogflow session per chat (`sessionScope: 'chat'`, the default) or per participant in groups (`'participant'`), or the key returned by `sessionKey(ctx)`. The key becomes a session id with SHA-256 (32 characters), so the phone number or chat id is never sent to Google.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `credentials` | `ServiceAccountCredentials` | — | Service-account JSON (`client_email`, `private_key`, `project_id`…). Accepts literal `\n` in the key |
| `tokenSource` | `{ getAccessToken() }` | — | Alternative to `credentials` |
| `projectId` | `string` | `credentials.project_id` | Google Cloud project |
| `languageCode` | `string` | `'es'` | Query language |
| `languageFor` | `(ctx) => string \| undefined` | — | Per-message language |
| `queryParams` | `(ctx) => object \| undefined` | — | Raw per-message `queryParams` (contexts, payload, parameters…) |
| `cx` | `{ agentId, location, environment? }` | — | Use Dialogflow CX |
| `location` / `environment` | `string` | global / draft | ES only: regional agent or published environment |
| `minConfidence` | `number` | `0` | Minimum confidence to route |
| `sessionScope` | `'chat' \| 'participant'` | `'chat'` | Session granularity |
| `sessionKey` | `(ctx) => string` | — | Custom session key |
| `routes` | `Record<string, handler \| flow>` | — | Routes registered on install |
| `fulfillment` | `'off' \| 'unrouted' \| 'all'` | `'off'` | Automatic reply with the agent texts |
| `commandPrefix` | `string \| false` | `'/'` | Commands are not sent to Dialogflow |
| `skipActiveConversation` | `boolean` | `true` | Do not query inside a conversation |
| `filter` | `(ctx) => boolean` | — | `false` = do not query |
| `priority` | `number` | `0` | Priority of the `before('message')` hook |
| `client` | `DialogflowClient` | — | Pre-built client (instead of building it from the config) |
| `onError` | `(error, ctx) => void` | — | `detectIntent` errors |
| `http` | `{ fetch?, resolver?, timeoutMs?, maxBytes? }` | — | `secureFetch` options (useful in tests) |

## Normalized result

```ts
interface DialogflowResult {
  intent: string | null        // displayName; null for CX NO_MATCH
  intentId?: string
  confidence: number
  isFallback: boolean
  parameters: Record<string, unknown>
  allRequiredParamsPresent: boolean
  messages: string[]           // reply texts in order
  fulfillmentText: string
  action?: string              // ES
  page?: string                // CX
  raw: unknown                 // raw queryResult
}
```

`ctx.tools.dialogflow.resultFor(ctx)` returns the current message's result from any handler. `DialogflowClient` can also be used on its own: `new DialogflowClient({ credentials }).detectIntent(sessionId, 'hello')`.

## Errors

Invalid credentials throw `DialogflowError` **synchronously** on `bot.plug()`. Network/API failures (`status`, `code` such as `'PERMISSION_DENIED'`) are reported through `onError` without breaking the pipeline.
