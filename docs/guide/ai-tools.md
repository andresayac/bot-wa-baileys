# AI tool calling

With `tools`, the model behind [`@bot-wa/ai`](/guide/ai) can call functions of
your bot (search the catalog, look up an order, create a booking) through each
provider's native tool / function calling. You declare every tool once; the
plugin maps it to Anthropic, OpenAI, Gemini or Ollama, runs a multi-step loop
and feeds the results back to the model until it writes the final answer.

::: warning Alpha — first npm publish pending
`@bot-wa/ai` is part of the first alpha, which is **not on npm yet**. Use it
from the monorepo (`workspace:*`) until it is published.
:::

## Declaring tools

```ts
import { aiPlugin, defineTool } from '@bot-wa/ai'
import { z } from 'zod' // optional: any schema with safeParse()

bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  persona: 'You are the assistant of La Espiga Bakery.',
  tools: {
    search_product: {
      description: 'Search the catalog by text',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      handler: async ({ q }: { q: string }) => db.products.search(q),
    },
    create_order: defineTool({
      title: 'Create order', // shown to the user in the confirmation
      description: 'Create an order for the customer. items: menu keys and quantities',
      schema: z.object({
        items: z.array(z.object({ product: z.enum(['rye_bread', 'croissant']), quantity: z.number().int().min(1) })).min(1),
      }),
      confirm: true, // ask the user "yes/no" before running it
      dedupe: 'args', // never run the very same order twice in a row
      timeoutMs: 10_000,
      handler: async (args, { ctx }) => db.orders.create({ ...args, chat: ctx?.from }),
    }),
  },
}))
```

Each entry of `tools` is an `AITool`; the key is the name the model sees.

| Field | Type | Description |
|---|---|---|
| `description` | `string` | What the tool does. The model reads it to decide when to call it; it is never shown to the user. |
| `title` | `string` | Short label shown to the user in the default confirmation (`'Create order'`). Default: the humanized name (`create_order` → `Create order`). |
| `schema` | JSON Schema or `safeParse` validator | Arguments. Omitted means no arguments. |
| `jsonSchema` | JSON Schema | Model-facing schema override (useful with `safeParse` validators). |
| `handler` | `(args, tctx) => unknown` | Runs the tool. Strings go back to the model as-is, `undefined` as `'ok'`, anything else JSON-serialized. |
| `confirm` | `boolean` | Require human confirmation before running it (see [below](#human-confirmation)). |
| `confirmMessage` | `string \| (args) => string` | Custom confirmation prompt. |
| `labels` | `{ [argKey]: { [value]: label } }` | Human labels of argument values in the default confirmation (`{ product: { rye_bread: 'Rye bread' } }`). See [Readable values and totals](#readable-values-and-totals). |
| `confirmLines` | `(args) => string[]` | Your own lines (e.g. prices and the total computed in code) in place of the argument lines of the default confirmation. |
| `dedupe` | `'args' \| { windowMs }` | Do not run it again with the same arguments within the window (`'args'`: 10 minutes) in the same chat (see [Repeated side effects](#repeated-side-effects)). |
| `timeoutMs` | `number` | Per-tool timeout, overrides `toolTimeoutMs`. |

`defineTool<TArgs>(tool)` is an identity helper: it only infers the argument
type for the handler, so your editor autocompletes `args`.

### Schemas

- **JSON Schema**: sent to the model as is and validated with a built-in
  subset (`type`, `required`, `properties`, `enum`, `const`, `items`,
  `additionalProperties: false`, `minimum`/`maximum` and their exclusive
  forms, `minLength`/`maxLength`, `minItems`/`maxItems`).
- **`safeParse` validators** (zod and similar): the arguments are validated with
  `safeParse()` and the handler receives the parsed `data`. The model-facing
  schema comes from the validator's `toJSONSchema()` when it has one (zod v4);
  otherwise pass `jsonSchema` yourself.

Invalid arguments never reach the handler **nor the user**: they are checked
before any confirmation, so nobody is asked to approve a call that cannot run.
The model gets an error result (saying the user was not asked) and can retry.
Use an `enum` for closed sets such as product keys: in a live test a model
passed `"chocolate cake"` instead of the menu key `chocolate_cake`, and only the
`enum` stops that before the user is asked.

### The handler context

The second argument of `handler` is an `AIToolContext`:

| Field | Description |
|---|---|
| `tool` | Name of the tool being run. |
| `callId` | Id of this call (assigned by the provider, or synthesized). |
| `chatKey` | Conversation key (`chatKeyOf(ctx)`) when the call comes from a chat turn. |
| `ctx` | The `MessageContext` of the turn (autoreply, or `replyInChat(..., { ctx })`). |
| `signal` | Aborted when the tool times out or the turn is cancelled. Pass it to `fetch` and friends. |

## The tool loop

Every turn runs a loop: call the model with the tool definitions; while it asks
for tools, validate the arguments, ask for confirmation when needed, run each
handler under its timeout and send the results back.

- **`maxSteps`** (default `5`) caps the model calls per turn. Tool calls
  requested in the last allowed step are **not** run (the model would never see
  their results): the turn replies `maxStepsMessage` and emits
  `loop.max_steps`.
- Several calls in the same step run one after another, in order.
- **Errors go to the model, never to the user**: a handler that throws,
  invalid arguments, an unknown tool, a timeout or a declined confirmation
  become failed tool results, so the model can recover or explain.
- **Timeouts**: `toolTimeoutMs` (default `15000`, `0` disables) applies to
  every tool unless the tool sets its own `timeoutMs`. On expiry the handler's
  `signal` is aborted. Each model call keeps the plugin's `timeoutMs`.
- The stored chat history stays plain user/assistant text: the intermediate
  tool turns are not persisted.

| Option | Default | Description |
|---|---|---|
| `tools` | — | The tool set. |
| `maxSteps` | `5` | Max model calls per turn. |
| `toolTimeoutMs` | `15000` | Default per-tool timeout (`0` disables). |
| `maxStepsMessage` | localized `ai.tools.maxSteps` (es: `'No pude completar la solicitud. Intenta de nuevo con más detalle.'`) | Reply when the loop hits `maxSteps`. |
| `toolConfirm` | `{ timeout: '2m', buttons: true }` | `{ yes?, no?, timeout?, buttons?, answeredNotice?, expiredNotice?, systemNote? }` for `confirm: true` tools in the autoreply (`expiredNotice` also covers `confirmWith(c)`). |
| `onToolEvent` | — | Audit callback for every loop event. |

::: tip Tools and streaming
A turn with tools is never streamed: with `tools` configured, the
autoresponder ignores the [`stream`](/guide/streaming#with-bot-wa-ai) option
and replies in one message, and `streamReplyInChat()` does not run tools.
:::

## Human confirmation

A tool with `confirm: true` only runs after a person approves it.

**In the autoresponder** the plugin asks the user itself. The question
(`confirmMessage`, or a readable default, see below) is asked inside a runtime
conversation, so the handler returns and the chat's FIFO queue is released:
the user's answer reaches the conversation and the loop resumes. It never
deadlocks the chat.

The answer is classified with `classifyConfirmation()`:

- **A clear yes** (`sí`, `ok`, `dale`, `sí, por favor`…) runs the tool.
- **A clear no** (`no`, `no, gracias`, `cancelar`…) declines it and the model
  is told not to retry it.
- **Anything else**, including a yes that adds changes (`sí pero cambia a 5
  unidades`), does **not** run the tool and is not discarded: the model gets
  `{ "executed": false, "reason": "user_replied", "userReply": "…" }`, so it
  can call the tool again with the corrected arguments (the user confirms
  again) or answer the question.

Answers are compared ignoring case, accents and punctuation, and courtesy
words around a yes/no are ignored. The default "yes" words (`DEFAULT_YES`) are
`si`, `s`, `yes`, `y`, `ok`, `okay`, `confirmo`, `confirmar`, `dale`, `claro`,
`de acuerdo`, `acepto`, `1`, `vale`, `listo`, `perfecto`, `adelante`, `hazlo`,
`correcto`, `está bien`, `sure`, `yeah` and `yep`; the "no" words
(`DEFAULT_NO`) are `no`, `n`, `nop`, `nope`, `nel`, `cancelar`, `cancela`,
`cancelo`, `cancel`, `negativo`, `mejor no`, `para nada`, `tampoco`,
`no gracias`, `2` and `0`. Change them with `toolConfirm.yes` / `toolConfirm.no`.

- **No double confirmation**: when the turn has a confirmer, the system prompt
  gets a localized note (`ai.tools.confirmNote`) listing the `confirm: true`
  tools and telling the model not to ask "shall I place it?" itself but to call
  the tool as soon as the user expresses the intent. `toolConfirm.systemNote`
  replaces it with your own text or turns it off (`false`).
- `toolConfirm.timeout` (default `'2m'`) bounds the wait. A timeout or `/reset`
  cancels the turn **silently**; `/reset` also cancels it after the approval,
  so the stale turn neither replies nor writes into the history it just
  cleared.
- Turns of the same chat are serialized: a new message waits for a detached
  turn to finish. A confirmation never replaces a conversation the user
  started meanwhile; the turn is cancelled instead and does not reply on top of
  that flow.

### Yes/No buttons

On channels that render native buttons (`capabilities.buttons`: Telegram
inline keyboards, WhatsApp Cloud API reply buttons, Discord, Messenger and
Instagram quick replies…) the question goes out as a **buttons message** with
localized labels (`Sí` / `No`, `Yes` / `No` in English; keys
`ai.tools.button.yes` / `ai.tools.button.no`) and the same summary, without the
typed-answer hint (`ai.tools.confirmButtons`: `Voy a: {tool}{args}\n¿Confirmas?`).

- A press resolves the confirmation exactly like typing yes or no, and the
  interaction is acknowledged (Telegram `answerCallbackQuery`, Discord's
  3-second ack). Typed answers keep working alongside the buttons, including a
  reply with changes that goes back to the model.
- Once answered (or timed out / cancelled), the buttons are removed by editing
  the message into text with the choice (`→ Sí`) where the provider can edit
  (Telegram, Discord).
- A press on a confirmation that is no longer pending (answered, superseded by
  a newer one, timed out, `/reset`) is acknowledged and ignored, before any
  routing: each confirmation has its own button ids, so an old press never
  answers a newer confirmation nor a later question of a conversation.
- **Channels that cannot edit messages** (WhatsApp Cloud API, Messenger,
  Instagram) leave the buttons on screen. There, a press on a confirmation that
  is no longer pending gets a short localized reply (`ai.tools.confirmExpired`:
  "Esa confirmación ya no está activa." / "That confirmation is no longer
  active."); `toolConfirm.expiredNotice: false` drops it silently. Optionally,
  `toolConfirm.answeredNotice: true` also replies `ai.tools.confirmAnswered`
  ("Respuesta recibida: Sí." / "Answer received: Yes.") when a press answers;
  it is off by default because those channels already show the user's pick as
  their own message. Neither notice is sent where the buttons are edited away.
- Channels without native buttons (WhatsApp via Baileys, Twilio, SMS, email…)
  keep the typed question with the `(sí/no)` hint.
- `toolConfirm.buttons: false` always asks for a typed answer. A tool's
  `confirmMessage` is used as is in both modes. A `bot.locale()` override of
  `ai.tools.confirm` is reused for buttons when you don't translate
  `ai.tools.confirmButtons` too.

The default prompt never shows the tool description (written for the model)
nor raw JSON. It is the localized `ai.tools.confirm` message with the tool
`title` and one short line per argument; a single list argument shows one line
per item, and items with a quantity read as `quantity × product`:

```text
Voy a: Crear pedido
• 5 × torta_chocolate
• 2 × cafe
¿Confirmas? (sí/no)
```

It is Spanish by default and English (`About to: Create order … Do you
confirm? (yes/no)`) when `ctx.lang` is `en` (see
[i18n](/guide/i18n#built-in-messages)). A chat in a language without built-in
texts (say `fr`) gets the bot's default locale when that is `es` or `en`, else
English. Override it per language with
`bot.locale('en', { ai: { tools: { confirm: 'Run {tool}?{args}' } } })`
(`{tool}` is the title, `{args}` a newline plus the `• ` lines, or empty), or
set `confirmMessage` on the tool.

### Readable values and totals

Catalog keys like `pan_de_bono` are good for the model and bad for the user.
Two tool options improve the default prompt without writing it yourself:

- **`labels`** maps argument values to human labels, per argument key (also
  inside list items). Values without a label are shown as-is; the model and
  the handler keep receiving the raw keys.
- **`confirmLines(args)`** returns the lines to show instead of the arguments,
  inside the same localized wrapper. Use it to show what **your code**
  computed (prices, the total), so the user never confirms a number the model
  made up. `confirmMessage` still wins over both.

```ts
const MENU = { pan_de_bono: { name: 'Pan de bono', price: 2500 }, cafe: { name: 'Café', price: 4000 } }

crear_pedido: {
  title: 'Crear pedido',
  labels: { producto: { pan_de_bono: 'Pan de bono', cafe: 'Café' } },
  // or, with prices and the total:
  confirmLines: ({ items }) => [
    ...items.map((i) => `• ${i.cantidad} × ${MENU[i.producto].name}: $${MENU[i.producto].price * i.cantidad}`),
    `Total: $${items.reduce((sum, i) => sum + MENU[i.producto].price * i.cantidad, 0)}`,
  ],
  // ...
}
```

```text
Voy a: Crear pedido
• 2 × Pan de bono: $5000
• 1 × Café: $4000
Total: $9000
¿Confirmas? (sí/no)
```

`argLines(args, ctx, labels)` and `summarizeValue(value, ctx, depth, labels)`
are exported if you build your own prompt.

**Inside your own conversation** pass `confirmWith(c)`. It never blocks the
queue either, and on a channel with native buttons it asks with the same Yes/No
buttons as the autoreply (same semantics: typed answers keep working, the
press is acknowledged, the buttons are edited away where possible, and a later
press is acknowledged and ignored instead of answering your next `c.ask()`).
Elsewhere, or with `buttons: false`, it asks a typed yes/no with `c.ask()`. The
buttons go to the chat of the `ctx` you pass to `replyInChat` (or the `ctx`
option).

```ts
import { chatKeyOf, confirmWith } from '@bot-wa/ai'

bot.conversation('support', async (c, ctx) => {
  const text = await c.ask('How can I help you?')
  const answer = await ctx.tools.ai.replyInChat(chatKeyOf(ctx), text, {
    ctx,
    confirm: confirmWith(c, { timeout: '1m' }),
  })
  await ctx.reply(answer)
})
```

`confirmWith(c, { yes, no, timeout, buttons, ctx, answeredNotice })` classifies
the answer like the autoresponder: `'approved'`, `'denied'` or `{ reply }`. A
conversation control error (timeout, cancel, replaced conversation) propagates
out of the loop as usual, so the runtime handles it.

**Without a confirmer** (for example a bare `ctx.tools.ai.ask()`), `confirm:
true` tools are denied and the model is told human confirmation was not
available.

You can also write your own `ToolConfirmer`: an async function that receives
`{ tool, callId, args, description, title, prompt, previous? }` and resolves
`'approved'`, `'denied'`, `{ reply: string }` (the user's free-text answer,
handed to the model) or `'cancelled'`. `'cancelled'` aborts the whole turn:
the loop throws `AIToolCancelledError` (with the `tool` name).

## Repeated side effects

Models sometimes call a side-effecting tool again on their own (for example to
"fix" an order total after the user said "nothing else"). The client remembers
the successful runs of `confirm: true` and `dedupe` tools per chat (in memory,
for 30 minutes; `/reset` and `ctx.tools.ai.clearToolHistory(chatKey)` forget
them) and uses them three ways:

- **Confirmation notice**: when a `confirm: true` tool already ran in the chat
  **with the same arguments**, the prompt starts with a localized line
  (`ai.tools.confirmRepeat`): `Heads-up: I already did «Place order» a moment
  ago (result: …). Confirming will do it again.` The confirmer also receives it
  as `previous`. A call with different arguments (changing 3 → 2 units) is a
  new action: no notice, no `previous`. The result summary leaves out fields
  too nested to read (lists of objects).
- **System prompt**: the next turns list the actions already run
  (`ai.tools.doneNote`), asking the model not to repeat them unless the user
  asks explicitly.
- **`dedupe`** (opt-in per tool): a call with the same validated arguments as a
  successful run within the window is not run and not confirmed; the model gets
  `{ "executed": false, "reason": "duplicate", "previous": { "result", "secondsAgo" } }`.
  `dedupe: 'args'` uses a 10-minute window; `dedupe: { windowMs: 60_000 }` sets
  your own. It also works for tools without `confirm`.

A run whose handler returns an object with a non-empty `error` (for example
`{ error: 'No order P-123' }`) did nothing, so it is not remembered: no repeat
notice, no "already done" line and no `dedupe` block.

`toolConfirm.systemNote: false` also turns off the system prompt list.

## Best practices for side-effecting tools

These rules come from live tests with real models on WhatsApp. Without them a
model will miscalculate an order total in free text, show catalog keys to the
customer, or claim it "replaced" an order when it had no tool to do so.

1. **Never let the model compute money.** Prices, subtotals and totals are
   computed in your code: offer a quote tool (no `confirm`, no side effects)
   for "how much is…?", compute the total again in the handler that stores the
   order, and show it in the confirmation with `confirmLines` (or
   `confirmMessage`). Return the computed total in the tool result so the
   model can repeat it instead of calculating it.
2. **Validate catalog values with `enum`.** Product keys, sizes, branches…:
   arguments are validated **before** the confirmation, so an invented product
   goes back to the model as an error and the user never confirms an
   impossible order. Pair the keys with `labels` (or names in `confirmLines`)
   so the user sees "Pan de bono", not `pan_de_bono`.
3. **Give every create its update, cancel and list tools.** If the model can
   only create, it will "fix" an order by creating another one, or say it
   changed something it could not. A list tool (`my_orders`) gives it the ids
   to update or cancel.
4. **Use `dedupe` on create tools** (`dedupe: 'args'`), so an identical order
   is not placed twice in a row when the model calls the tool again on its own.
5. **Return an explicit `{ error }` for unknown ids** (`{ error: 'No active
   order P-123. Check my_orders.' }`), never a silent `ok` or `null`. The model
   reads it and tells the user; the run is not remembered as done.
6. **Keep `confirm: true` on everything with side effects** (create, update,
   cancel, pay, book). Read-only tools (menu, quote, list) do not need it.
7. **Rely on the system note, do not fight it.** With a confirmer, the system
   prompt tells the model which tools the system confirms, not to ask "shall I
   place it?" itself, not to mention the confirmation process and never to
   claim it did, changed, replaced or cancelled anything a tool result did not
   confirm (and to say so plainly when it has no tool for a request). Keep it
   on (`toolConfirm.systemNote`) unless you replace it with an equivalent text.

A complete bakery with all of the above:

```ts
import { Bot } from '@bot-wa/core'
import { aiPlugin } from '@bot-wa/ai'

const MENU = {
  pan_de_bono: { name: 'Pan de bono', price: 2500 },
  croissant: { name: 'Croissant', price: 5000 },
  cafe: { name: 'Café', price: 4000 },
} as const
type Product = keyof typeof MENU
type Item = { producto: Product; cantidad: number }
type Order = { id: string; items: Item[]; total: number; estado: 'confirmado' | 'cancelado' }

const PRODUCTS = Object.keys(MENU)
const ITEMS = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    properties: {
      producto: { type: 'string', enum: PRODUCTS }, // only real products
      cantidad: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['producto', 'cantidad'],
    additionalProperties: false,
  },
}
const ORDER_ID = { type: 'string', description: 'Order id (mis_pedidos)' }

// Money is computed here, never by the model.
const money = (n: number) => '$' + n.toLocaleString('es-CO')
const quote = (items: Item[]) => {
  const lines = items.map((i) => ({ ...i, nombre: MENU[i.producto].name, subtotal: MENU[i.producto].price * i.cantidad }))
  return { items: lines, total: lines.reduce((sum, l) => sum + l.subtotal, 0) }
}
const quoteLines = (items: Item[]) => {
  const q = quote(items)
  return [...q.items.map((l) => `• ${l.cantidad} × ${l.nombre}: ${money(l.subtotal)}`), `Total: ${money(q.total)}`]
}

const orders = new Map<string, Order[]>() // per chat; use ctx.user or your DB in production
const ordersOf = (chat = '') => {
  if (!orders.has(chat)) orders.set(chat, [])
  return orders.get(chat)!
}
const active = (chat: string | undefined, id: string) => ordersOf(chat).find((o) => o.id === id && o.estado !== 'cancelado')
const noOrder = (id: string) => ({ error: `No active order ${id}. Check mis_pedidos.` })

const bot = new Bot({ provider })
bot.plug(aiPlugin({
  provider: 'anthropic',
  persona: 'You are the assistant of Panadería La Espiga. Use ver_menu for products and cotizar_pedido for any price or total; never calculate amounts yourself.',
  tools: {
    ver_menu: {
      description: 'List the menu: key, name and price.',
      handler: () => Object.entries(MENU).map(([clave, p]) => ({ clave, nombre: p.name, precio: p.price })),
    },
    cotizar_pedido: {
      description: 'Compute prices, subtotals and the total of a list of products without placing anything.',
      schema: { type: 'object', properties: { items: ITEMS }, required: ['items'] },
      handler: ({ items }: { items: Item[] }) => quote(items),
    },
    mis_pedidos: {
      description: "List the customer's orders with id, items, total and status.",
      handler: (_args: unknown, { ctx }) => ordersOf(ctx?.from),
    },
    crear_pedido: {
      title: 'Crear pedido',
      description: 'Place a new order. items: menu keys and quantities.',
      schema: { type: 'object', properties: { items: ITEMS }, required: ['items'] },
      confirm: true,
      dedupe: 'args',
      confirmLines: ({ items }: { items: Item[] }) => quoteLines(items),
      handler: ({ items }: { items: Item[] }, { ctx }) => {
        const order: Order = { id: 'P-' + Date.now().toString(36).toUpperCase(), ...quote(items), estado: 'confirmado' }
        ordersOf(ctx?.from).push(order)
        return order // the model repeats this total, it does not compute it
      },
    },
    actualizar_pedido: {
      title: 'Cambiar pedido',
      description: 'Replace the items of an existing order (by id) with the complete new list.',
      schema: { type: 'object', properties: { id: ORDER_ID, items: ITEMS }, required: ['id', 'items'] },
      confirm: true,
      confirmLines: ({ id, items }: { id: string; items: Item[] }) => [`• Pedido: ${id}`, ...quoteLines(items)],
      handler: ({ id, items }: { id: string; items: Item[] }, { ctx }) => {
        const order = active(ctx?.from, id)
        if (!order) return noOrder(id)
        return Object.assign(order, quote(items))
      },
    },
    cancelar_pedido: {
      title: 'Cancelar pedido',
      description: 'Cancel an existing order by id.',
      schema: { type: 'object', properties: { id: ORDER_ID }, required: ['id'] },
      confirm: true,
      handler: ({ id }: { id: string }, { ctx }) => {
        const order = active(ctx?.from, id)
        if (!order) return noOrder(id)
        order.estado = 'cancelado'
        return { id, estado: 'cancelado' }
      },
    },
  },
}))
```

The [`create-bot-wa`](/guide/getting-started) `ai-full` template ships the same
tools, with the orders kept in `ctx.user`.

For a complete, runnable version in English, see the
[bakery AI assistant example](https://github.com/andresayac/bot-wa-baileys/tree/main/examples/bakery-ai) (`examples/bakery-ai`). It runs the same
bot on WhatsApp through Baileys (QR) or Twilio (webhook + `@bot-wa/server`) and
includes typed env config and tests with `MockAIProvider`.

## Audit events

Every step of the loop emits an `AIToolEvent`, both to `onToolEvent` and on
the bot as `'ai.tool'`:

```ts
import type { AIToolEvent } from '@bot-wa/ai'

bot.on('ai.tool', (e: AIToolEvent) => {
  audit.write({ type: e.type, tool: e.tool, step: e.step, chat: e.chatKey, ms: e.durationMs })
})
```

| `type` | When |
|---|---|
| `tool.call` | Arguments validated, the tool is about to run (or to be confirmed). |
| `tool.confirm.requested` | A `confirm: true` tool asked for approval. |
| `tool.confirm.approved` / `.denied` / `.cancelled` | Outcome of the confirmation. |
| `tool.confirm.replied` | The user answered with something other than a clear yes/no; the text went to the model. |
| `tool.duplicate` | A `dedupe` tool was called again with the same arguments; it was not run. |
| `tool.result` | The handler returned (`durationMs`). |
| `tool.error` | The handler threw (`error`, `durationMs`). |
| `tool.timeout` | The handler exceeded its timeout (`error`, `durationMs`). |
| `tool.invalid_args` | The arguments failed validation (`error`). |
| `tool.unknown` | The model asked for a tool that does not exist. |
| `loop.max_steps` | The loop stopped at `maxSteps`. |

Each event carries `at` (ms epoch), `step` (1-based), and when relevant `tool`,
`callId`, `chatKey`, `args`, `durationMs` and `error`.

::: warning `args` may contain personal data
Events include the arguments the model produced. Treat them as personal data
in your audit sink. The plugin's own debug log records metadata only (tool,
type, step, duration).
:::

## Providers

| Provider | Native tool calling |
|---|---|
| `anthropic` | Yes (`tools` / `tool_use`) |
| `openai` and the OpenAI-compatible presets | Yes (`tools` / `tool_calls`); depends on the vendor's model supporting it |
| `gemini` | Yes (`functionDeclarations` / `functionCall`) |
| `ollama` | Yes (`tools` / `tool_calls`); depends on the local model supporting it |

Streaming calls (`stream()`, `streamReplyInChat()`) never send tools.

## Using tools from your code

With `tools` configured, `ctx.tools.ai.ask()` and `ctx.tools.ai.replyInChat()`
run the loop automatically. Both accept `{ ctx, confirm, signal, chatKey }`.
For full control, `runTools()` returns the loop result:

```ts
const r = await ctx.tools.ai.runTools(
  { messages: [{ role: 'user', content: ctx.body }] },
  { ctx },
)
r.text            // final answer
r.steps           // model calls made
r.toolResults     // every tool result, in order
r.maxStepsReached // true when the loop stopped at maxSteps
```

`runToolLoop()` is the same loop without an `AIClient`: you pass the tools, a
`generate` function and the messages.

```ts
import { resolveProvider, runToolLoop } from '@bot-wa/ai'

const provider = await resolveProvider({ provider: 'anthropic' })
const r = await runToolLoop({
  tools,
  generate: (input) => provider.generate(input),
  base: { system: 'You are a stock assistant.' },
  messages: [{ role: 'user', content: 'Is there rye bread left?' }],
  maxSteps: 3,
  onEvent: (e) => console.log(e.type),
})
```

## Testing

`MockAIProvider` can script tool calls: return `{ toolCalls }` from `reply` to
make the "model" call a tool, and plain text to finish. Build an `AIClient`
with your tools and assert on the result:

```ts
import { AIClient, ContextManager, MockAIProvider } from '@bot-wa/ai'
import { MemoryStore } from '@bot-wa/core'

const mock = new MockAIProvider({
  reply: (input) => input.messages.at(-1)?.role === 'tool'
    ? 'We have rye bread.'
    : { toolCalls: [{ name: 'search_product', args: { q: 'rye' } }] },
})

const searched: string[] = []
const client = new AIClient(mock, new ContextManager(new MemoryStore()), {
  tools: {
    search_product: {
      description: 'Search the catalog',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      handler: ({ q }: { q: string }) => { searched.push(q); return ['rye bread'] },
    },
  },
})

expect(await client.ask('do you have rye?')).toBe('We have rye bread.')
expect(searched).toEqual(['rye'])
```

`mock.calls` keeps every request the client sent (with its `messages` and
`tools`), so you can also assert what the model saw.

## Next steps

- [AI plugin](/guide/ai) — providers and the full `aiPlugin` reference
- [AI memory & RAG](/guide/ai-memory-rag) — per-user facts and answers from your documents
- [Conversation flows](/guide/flows) — the runtime that hosts confirmations
- [Bakery AI assistant example](https://github.com/andresayac/bot-wa-baileys/tree/main/examples/bakery-ai) — these practices in a runnable WhatsApp bot (Baileys or Twilio)
