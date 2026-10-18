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
      description: 'Create an order for the customer',
      schema: z.object({ items: z.array(z.string()), customer: z.string() }),
      confirm: true, // ask the user "yes/no" before running it
      confirmMessage: (a) => `Shall I create the order for ${a.items.join(', ')}? (yes/no)`,
      timeoutMs: 10_000,
      handler: async (args, { ctx }) => db.orders.create({ ...args, chat: ctx?.from }),
    }),
  },
}))
```

Each entry of `tools` is an `AITool`; the key is the name the model sees.

| Field | Type | Description |
|---|---|---|
| `description` | `string` | What the tool does. The model reads it to decide when to call it. |
| `schema` | JSON Schema or `safeParse` validator | Arguments. Omitted means no arguments. |
| `jsonSchema` | JSON Schema | Model-facing schema override (useful with `safeParse` validators). |
| `handler` | `(args, tctx) => unknown` | Runs the tool. Strings go back to the model as-is, `undefined` as `'ok'`, anything else JSON-serialized. |
| `confirm` | `boolean` | Require human confirmation before running it (see [below](#human-confirmation)). |
| `confirmMessage` | `string \| (args) => string` | Custom confirmation prompt. |
| `timeoutMs` | `number` | Per-tool timeout, overrides `toolTimeoutMs`. |

`defineTool<TArgs>(tool)` is an identity helper: it only infers the argument
type for the handler, so your editor autocompletes `args`.

### Schemas

- **JSON Schema**: sent to the model as is and validated with a built-in
  subset (`type`, `required`, `properties`, `enum`, `const`, `items`,
  `additionalProperties: false`).
- **`safeParse` validators** (zod and similar): the arguments are validated with
  `safeParse()` and the handler receives the parsed `data`. The model-facing
  schema comes from the validator's `toJSONSchema()` when it has one (zod v4);
  otherwise pass `jsonSchema` yourself.

Invalid arguments never reach the handler: the model gets an error result and
can retry.

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
| `toolConfirm` | `{ timeout: '2m' }` | `{ yes?, timeout? }` for `confirm: true` tools in the autoreply. |
| `onToolEvent` | — | Audit callback for every loop event. |

::: tip Tools and streaming
A turn with tools is never streamed: with `tools` configured, the
autoresponder ignores the [`stream`](/guide/streaming#with-bot-wa-ai) option
and replies in one message, and `streamReplyInChat()` does not run tools.
:::

## Human confirmation

A tool with `confirm: true` only runs after a person approves it.

**In the autoresponder** the plugin asks the user itself. The question
(`confirmMessage`, or a default built from the description and the arguments)
is asked inside a runtime conversation, so the handler returns and the chat's
FIFO queue is released: the user's answer reaches the conversation and the
loop resumes. It never deadlocks the chat.

- An affirmative answer runs the tool; anything else declines it and the model
  is told not to retry it. Answers are compared ignoring case, accents and
  punctuation; the default "yes" words are `si`, `s`, `yes`, `y`, `ok`,
  `okay`, `confirmo`, `confirmar`, `dale`, `claro`, `de acuerdo`, `acepto` and
  `1` (`DEFAULT_YES`). Change them with `toolConfirm.yes`.
- `toolConfirm.timeout` (default `'2m'`) bounds the wait. A timeout or `/reset`
  cancels the turn **silently**; `/reset` also cancels it after the approval,
  so the stale turn neither replies nor writes into the history it just
  cleared.
- Turns of the same chat are serialized: a new message waits for a detached
  turn to finish. A confirmation never replaces a conversation the user
  started meanwhile; the turn is cancelled instead and does not reply on top of
  that flow.

The default prompt is the localized `ai.tools.confirm` message: Spanish
(`Voy a ejecutar «…». ¿Confirmas? (sí/no)`) by default and English
(`About to run «…». Do you confirm? (yes/no)`) when `ctx.lang` is `en` (see
[i18n](/guide/i18n#built-in-messages)). Override it per language with
`bot.locale('en', { ai: { tools: { confirm: 'Run {tool}?{args}' } } })`, or set
`confirmMessage` on the tool.

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

`confirmWith(c, { yes, timeout })` resolves `'approved'` or `'denied'`. A
conversation control error (timeout, cancel, replaced conversation) propagates
out of the loop as usual, so the runtime handles it.

**Without a confirmer** (for example a bare `ctx.tools.ai.ask()`), `confirm:
true` tools are denied and the model is told human confirmation was not
available.

You can also write your own `ToolConfirmer`: an async function that receives
`{ tool, callId, args, description, prompt }` and resolves `'approved'`,
`'denied'` or `'cancelled'`. `'cancelled'` aborts the whole turn: the loop
throws `AIToolCancelledError` (with the `tool` name).

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
