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
| `toolConfirm` | `{ timeout: '2m' }` | `{ yes?, no?, timeout?, systemNote? }` for `confirm: true` tools in the autoreply. |
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
[i18n](/guide/i18n#built-in-messages)). Override it per language with
`bot.locale('en', { ai: { tools: { confirm: 'Run {tool}?{args}' } } })`
(`{tool}` is the title, `{args}` a newline plus the `• ` lines, or empty), or
set `confirmMessage` on the tool.

**Inside your own conversation** pass `confirmWith(c)`: it asks with `c.ask()`,
which never blocks the queue either.

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

`confirmWith(c, { yes, no, timeout })` classifies the answer like the
autoresponder: `'approved'`, `'denied'` or `{ reply }`. A
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

- **Confirmation notice**: when a `confirm: true` tool already ran in the chat,
  the prompt starts with a localized line (`ai.tools.confirmRepeat`):
  `Ojo: ya hice «Crear pedido» hace un momento (resultado: …). Si confirmas, se
  hará otra vez.` The confirmer also receives it as `previous`.
- **System prompt**: the next turns list the actions already run
  (`ai.tools.doneNote`), asking the model not to repeat them unless the user
  asks explicitly.
- **`dedupe`** (opt-in per tool): a call with the same validated arguments as a
  successful run within the window is not run and not confirmed; the model gets
  `{ "executed": false, "reason": "duplicate", "previous": { "result", "secondsAgo" } }`.
  `dedupe: 'args'` uses a 10-minute window; `dedupe: { windowMs: 60_000 }` sets
  your own. It also works for tools without `confirm`.

`toolConfirm.systemNote: false` also turns off the system prompt list.

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
