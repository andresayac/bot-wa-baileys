# @botmesh/ai

Multi-provider AI plugin (Anthropic / OpenAI / Ollama / Gemini + 9
OpenAI-compatible presets) for
[`@botmesh/core`](https://github.com/andresayac/botmesh). A single
`bot.plug(aiPlugin(...))` gives you a catch-all autoresponder with per-chat
conversation memory; `ctx.tools.ai` gives you the full client to use wherever
you want (flows, conversations, commands).

> **Alpha — first npm publish pending.** `@botmesh/ai` ships with the first
alpha but is **not on npm yet**: until then, use it from this monorepo
>(`workspace:*`). The `pnpm add` commands below are the ones that will work
>once it is published.

## WhatsApp AI policy (since 2026-01-15)

Since **January 15, 2026**, Meta's terms for the **WhatsApp Business
Platform** (the *AI Providers* section) **forbid general-purpose AI
assistants**: open ChatGPT-style chatbots whose main purpose is the AI itself.
Using AI in the service of the business itself is still **allowed**: customer
support, sales, bookings, order tracking.

In practice, with `aiPlugin`:

- Write a `persona` **scoped to your business** (what you sell, opening hours,
  policies) that politely declines anything unrelated. See the
  [Quickstart](#quickstart-beginner-mode).
- Offer a way out to a human and do not present the bot as an assistant
  "for everything".
- The rule comes from the official Cloud API terms (`@botmesh/meta`). Baileys is an
  unofficial WhatsApp Web client and is also subject to WhatsApp's terms.

This is practical guidance, not legal advice: review the
[current terms](https://www.whatsapp.com/legal/business-solution-terms)
before going to production.

## Installation

```bash
pnpm add @botmesh/ai@alpha @anthropic-ai/sdk
```

The second package is the SDK of the provider you are going to use — install the
right one:

| Provider | SDK to install |
|---|---|
| `anthropic` (default) | `@anthropic-ai/sdk` |
| `openai` | `openai` |
| `ollama` | none (it speaks HTTP directly with `fetch` against an Ollama server) |
| `gemini` | `@google/generative-ai` |
| `deepseek` · `qwen` · `glm` · `kimi` · `groq` · `openrouter` · `mistral` · `grok` · `together` | `openai` (they are OpenAI-compatible; they use their own `baseURL`, **no extra SDK**) |

Requires **Node >= 22** and `@botmesh/core` already installed in your project.

## Quickstart (beginner mode)

```ts
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'
import { aiPlugin } from '@botmesh/ai'

const bot = new Bot({ provider: new BaileysProvider({ session: 'my-bot' }) })

// Persona scoped to the business (see "WhatsApp AI policy" above).
const persona = [
  'You are the customer-support assistant of Panadería La Espiga.',
  'You only answer about its products, prices, opening hours (Mon-Sat 7:00-20:00), orders and catering.',
  'If you are asked about anything unrelated to the bakery, politely say you can only help with that',
  'and offer to hand the conversation to a person. Answer briefly and in English; do not invent data.',
].join(' ')

bot.plug(aiPlugin({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  persona,
}))

await bot.start()
```

With this the plugin registers:
- A catch-all autoresponder (`bot.onMessage`) that answers any **text** message
  no other handler/command/conversation consumed, keeping the history per chat
  (bounded window, 20 messages by default, see `context.maxMessages`).
- A `/reset` command that clears the chat's AI context and cancels the active
  conversation (opt out with `resetCommand: false`).

## Advanced: `ctx.tools.ai`

The plugin also does `bot.provide('ai', client)`, so you can use
`ctx.tools.ai` inside your own `when()`, flows or conversations.
Turn the autoresponder off (`autoReply: false`) if that is all you want:

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  autoReply: false,
}))

bot.conversation('complaint', async (c, ctx) => {
  await ctx.reply('📝 Tell us what happened with your order:')
  const text = await c.waitText()
  const summary = await ctx.tools.ai.ask(
    `Summarize in 3 lines this customer complaint for the support team: ${text}`,
  )
  await ctx.reply(`✅ We logged your complaint:\n${summary}`)
})
```

`ctx.tools.ai` (the `AIClient` class) exposes:

- `ask(prompt: string, opts?): Promise<string>` — standalone question, **without**
  chat history (it neither reads nor writes the stored context). It uses the
  `persona`/`model`/`maxTokens`/`effort` configured on `aiPlugin` (and the tools, if any).
- `replyInChat(chatKey, text, opts?): Promise<string>` — replies inside a
  chat's history (reads it and stores the turn), like the autoresponder.
  `opts`: `{ userId, isGroup }` (memory) and `{ ctx, confirm, signal }` (tools).
`replyInChatDetailed()` also returns `citations` and `facts`.
- `streamReplyInChat(chatKey, text, opts?)` — streaming twin of
  `replyInChat`, for `ctx.stream()` (see [Streaming](#streaming)).
- `runTools(input, opts?)` — runs the tool loop and returns its full result
  (`text`, `steps`, `toolResults`, `maxStepsReached`).
- `memory()` / `memoryFacts()` / `remember()` / `forget()` / `extractMemory()` /
  `idle()` — long-term memory (see [Memory](#long-term-memory-per-user)).
- `generate(input: { messages, system?, model?, maxTokens?, effort?, signal? }): Promise<GenerateResult>` —
  full control: explicit messages and per-call overrides.
- `stream(input): AsyncIterable<string>` — like `generate` but
  yielding the text in chunks (`for await (const delta of ...)`).

**Typing (TypeScript).** Importing `@botmesh/ai` augments the `DefaultTools`
interface of `@botmesh/core` (*module augmentation*), so `ctx.tools.ai` is
already an `AIClient` in the handlers of `when()`, `onMessage()` and
`command()` (and in `bot.injectTools.ai`), with no casts:

```ts
bot.when('summary', async (ctx) => {
  const text = await ctx.tools.ai.ask(`Summarize in one line: ${ctx.body}`) // string
  await ctx.reply(text)
})
```

The type does not check that the plugin is installed: without
`bot.plug(aiPlugin(...))` (or after `unplug()`), `ctx.tools.ai` is
`undefined` at runtime.

## Providers

### Anthropic (default)

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',                     // optional, it is the default
  apiKey: process.env.ANTHROPIC_API_KEY,     // or let the SDK read ANTHROPIC_API_KEY from the environment
  // model: 'claude-opus-4-8',               // default; consider 'claude-sonnet-5' or
                                              // 'claude-haiku-4-5' for high-volume chats (cheaper)
}))
```

### OpenAI

```ts
bot.plug(aiPlugin({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-5.1',   // REQUIRED: OpenAIProvider has no default model
}))
```

`baseUrl` is optional (endpoints compatible with the OpenAI API).

### Ollama (local, no API key)

```ts
bot.plug(aiPlugin({
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',   // default when omitted
  model: 'llama3.1',                   // REQUIRED: OllamaProvider has no default model
}))
```

### OpenAI-compatible presets (DeepSeek, Qwen, GLM, Kimi, Groq, OpenRouter, Mistral, Grok, Together)

All of them speak the OpenAI protocol, so they are resolved with the
`openai` SDK pointed at their endpoint — **nothing extra to install**. Each preset
brings a default model and reads the API key from its conventional environment
variable:

```ts
bot.plug(aiPlugin({ provider: 'deepseek' }))              // DEEPSEEK_API_KEY, model deepseek-chat
bot.plug(aiPlugin({ provider: 'qwen', model: 'qwen-max' })) // DASHSCOPE_API_KEY, model override
bot.plug(aiPlugin({ provider: 'groq' }))                  // GROQ_API_KEY, llama-3.3-70b-versatile
bot.plug(aiPlugin({ provider: 'openrouter' }))            // OPENROUTER_API_KEY, openrouter/auto
```

| Preset | Default model | API key env |
|---|---|---|
| `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `qwen` | `qwen-plus` | `DASHSCOPE_API_KEY` |
| `glm` | `glm-4-plus` | `ZHIPUAI_API_KEY` |
| `kimi` | `moonshot-v1-8k` | `MOONSHOT_API_KEY` |
| `groq` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| `openrouter` | `openrouter/auto` | `OPENROUTER_API_KEY` |
| `mistral` | `mistral-small-latest` | `MISTRAL_API_KEY` |
| `grok` | `grok-2-latest` | `XAI_API_KEY` |
| `together` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | `TOGETHER_API_KEY` |

You can override `model` and `baseUrl` on any preset.

### Gemini (native)

```ts
bot.plug(aiPlugin({
  provider: 'gemini',
  // model: 'gemini-2.0-flash',   // default
}))
```

Requires `@google/generative-ai`. The API key is read from `apiKey`, `GEMINI_API_KEY`
or `GOOGLE_API_KEY`.

> **`model` is required for `openai` and `ollama`.** neither of them brings a
> reasonable default (there are too many valid models and they change often); if you omit
> it, the provider throws an explicit error on the first `generate`/`stream`.
> `anthropic` (`claude-opus-4-8`), `gemini` (`gemini-2.0-flash`) and every
> **preset** do bring a default.

If the provider is misconfigured (SDK not installed, unknown provider, missing
API key), `aiPlugin` **does not take the process down**: `install` is synchronous
and resolves the provider lazily. On startup a "warmup" logs the problem to the
error log (with the hint of which `pnpm add` to run), and from then on every
message answers the configured `errorMessage` instead of crashing the bot.

## Full `aiPlugin(config)` reference

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | `'anthropic' \| 'openai' \| 'ollama' \| 'gemini' \| 'deepseek' \| 'qwen' \| 'glm' \| 'kimi' \| 'groq' \| 'openrouter' \| 'mistral' \| 'grok' \| 'together'` | `'anthropic'` | provider to resolve (the presets are OpenAI-compatible) |
| `model` | `string` | per provider | model to use (required for openai/ollama; presets/gemini/anthropic bring a default) |
| `apiKey` | `string` | preset env | API key; on presets it falls back to its conventional env (e.g. `DEEPSEEK_API_KEY`) |
| `baseUrl` | `string` | preset endpoint | endpoint override (`baseURL` of openai/presets/anthropic / ollama host) |
| `instance` | `AIProvider` | — | already-built provider (`MockAIProvider` in tests, or your own): skips resolving `provider`/`apiKey`/`model` and the lazy SDK load |
| `persona` | `string` | — | system prompt |
| `maxTokens` | `number` | `4096` (anthropic) / `1024` (openai) | output token limit (on ollama only if you set it, as `options.num_predict`; the 1024 cap of memory extraction does not apply there). On reasoning models it includes the thinking tokens |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | — | reasoning effort (only Anthropic uses it; it is not sent to models that reject it, such as Claude Haiku 4.5) |
| `thinking` | `'auto' \| 'adaptive' \| 'off' \| { budgetTokens }` | `'auto'` | Anthropic thinking: `'auto'` uses adaptive thinking only on models that support it (Opus/Sonnet 4.6+, Haiku 5+); on `claude-haiku-4-5` and older it sends nothing. `{ budgetTokens }` = budgeted thinking on older models. A 400 mentioning `thinking`/`effort` is retried once without the parameter |
| `timeoutMs` | `number` | `60000` | timeout per non-streaming call; when it expires it aborts the request and rejects, so a hung provider cannot block the chat queue (`0` disables it, not recommended) |
| `context.maxMessages` | `number` | `20` | stored history window per chat (always starts with a user turn; empty answers are not stored) |
| `autoReply` | `boolean` | `true` | registers the catch-all autoresponder |
| `resetCommand` | `boolean` | `true` | registers `/reset` |
| `errorMessage` | `string` | `'⚠️ Ahora no puedo responder, intenta luego.'` | answer when the provider fails or the model replies empty |
| `refusalMessage` | `string` | `'No puedo ayudar con eso.'` | answer when the provider refuses (`stopReason === 'refusal'`: Anthropic refusal, OpenAI `refusal`, Gemini safety block) |
| `humanizeTyping` | `boolean` | `true` | sends "typing…" (`ctx.typing()`) while the answer is generated; the reply then skips `BotConfig.typing`, so the indicator shows up once |
| `tools` | `Record<string, AITool>` | — | tools the model may call (see [Tool calling](#tool-calling)) |
| `maxSteps` | `number` | `5` | maximum model calls per turn in the tool loop |
| `toolTimeoutMs` | `number` | `15000` | default timeout of each tool (`0` disables it) |
| `maxStepsMessage` | `string` | localized `ai.tools.maxSteps` message (es: `'No pude completar la solicitud…'`) | answer when `maxSteps` runs out |
| `toolConfirm` | `{ yes?: string[]; no?: string[]; timeout?: number \| string; buttons?: boolean; systemNote?: boolean \| string }` | `{ timeout: '2m', buttons: true }` | confirmation dialog for `confirm: true` tools (Yes/No buttons where the channel shows them) |
| `onToolEvent` | `(e: AIToolEvent) => void` | — | audit: receives every event of the loop (also emitted as `bot.on('ai.tool')`) |
| `memory` | `boolean \| AIMemoryConfig` | — | long-term memory per user (see [Memory](#long-term-memory-per-user)) |
| `rag` | `AIRetriever \| AIRagConfig` | — | RAG: passages from your documents with citations (see [RAG](#rag-answers-from-your-documents)) |
| `stream` | `boolean \| AIStreamConfig` | off | streams the autoresponder with `ctx.stream()` (see [Streaming](#streaming)) |
| `format` | `'auto' \| TextFormat \| false` | `'auto'` | converts the model's Markdown to the chat format, `ctx.textFormat` (the provider's `textFormatFor(chatId)`, e.g. WhatsApp or SMS on Twilio; otherwise `capabilities.textFormat`): `*bold*` on WhatsApp, no markup on SMS/Telegram/Messenger/Instagram, untouched on Discord; `false` sends it as is. The history keeps the original text. `formatMarkdown()` / `formatMarkdownStream()` are exported |

## Tool calling

The model can run bot functions through each provider's native
*tool/function calling* (Anthropic, OpenAI and compatible presets, Gemini and
Ollama). You declare each tool once:

```ts
import { aiPlugin, defineTool } from '@botmesh/ai'
import { z } from 'zod' // optional: any schema with safeParse()

bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  tools: {
    buscar_producto: {
      description: 'Searches catalog products by text',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      handler: async ({ q }: { q: string }) => db.products.search(q),
    },
    crear_pedido: defineTool({
      title: 'Crear pedido', // what the user sees when confirming
      description: 'Creates an order. items: menu keys and quantities', // for the model only
      schema: z.object({
        items: z.array(z.object({ producto: z.enum(['pan_centeno', 'croissant']), cantidad: z.number().int().min(1) })).min(1),
      }),
      confirm: true, // asks the user "yes/no" before running
      dedupe: 'args', // does not repeat the same order twice in a row
      timeoutMs: 10_000,
      handler: async (args, { ctx }) => db.orders.create({ ...args, chat: ctx?.from }),
    }),
  },
}))
```

- **Multi-step loop**: while the model asks for tools they are run and their
  result is returned, up to `maxSteps` (default 5). Tools the model asks for in
  the last allowed call are not run (it would never see the result):
  the turn answers `maxStepsMessage`.
- **Errors to the model**: a handler exception, invalid arguments, an
  unknown tool, a timeout or a user refusal are returned to the
  model as a failed result; they never reach the user as a crash.
- **Schemas**: JSON Schema (validated with a subset: `type`, `required`,
  `properties`, `enum`, `const`, `items`, `additionalProperties: false`,
  `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`) or any
  validator with `safeParse()`. With zod v4 its `toJSONSchema()` is used; otherwise
  pass `jsonSchema` by hand. Arguments are validated **before** asking for
  confirmation: the user never approves an invalid call (use `enum` for
  product keys) and the error goes back to the model.
- **Human confirmation** (`confirm: true`): the autoresponder asks the
  user inside a runtime conversation and returns the chat's FIFO queue, so the
  answer arrives without blocking. `/reset` or the timeout
  silently cancel the turn; `/reset` also cancels it after
  approval (it neither answers nor writes to the freshly cleared history). After a confirmation the turn stays out of
  the queue, but turns of the same chat are serialized (a new message
  waits for it to finish) and a second confirmation never replaces a flow the
  user opened meanwhile: the turn is silently cancelled and does not
  answer on top of that flow.

  The default question is readable: the tool's `title` (or its humanized
  name) and one line per argument, never the description or JSON
  (`Voy a: Crear pedido` / `• 5 × torta_chocolate` / `¿Confirmas? (sí/no)`).
  A clear yes runs it, a clear no refuses it and **any other answer**
  (`sí pero cambia a 5 unidades`) does not run: the model receives
  `{ executed: false, reason: 'user_replied', userReply }` and proposes again
  (`classifyConfirmation()`, `toolConfirm.yes` / `toolConfirm.no`). The system
  prompt tells the model which tools the system confirms, so it does not
  ask itself first (`toolConfirm.systemNote`, `false` turns it off).

  **Yes/No buttons**: on channels with native buttons (`capabilities.buttons`:
  Telegram, WhatsApp Cloud API, Discord, Messenger, Instagram…) the question goes
  out as a button message with localized labels (`ai.tools.button.yes` /
  `.no`) and the summary without the `(sí/no)` suffix (`ai.tools.confirmButtons`).
  Pressing is equivalent to typing yes/no (typing still works), the interaction
  is recognized and, if the provider edits (Telegram), the buttons are removed. A
  press on an already answered, replaced or expired confirmation is
  ignored. On channels without buttons (Baileys, Twilio, SMS…) the question is text;
  `toolConfirm.buttons: false` always forces that.

  **Readable values and totals**: `labels` translates argument values per
  key (`labels: { producto: { pan_de_bono: 'Pan de bono' } }` → `• 2 × Pan de bono`,
  also inside lists) and `confirmLines(args)` replaces the argument
  lines with yours (e.g. prices and the total computed in code), without
  losing the localized wrapper. The model and the handler still receive the
  raw keys.

  **Repetitions**: successful runs of `confirm`/`dedupe` tools are
  remembered per chat (in memory, 30 min, `/reset` clears them): if the tool is
  called again, the question warns ("Heads up: I already made «Crear pedido» a
  moment ago…") and the system prompt lists what was already done; with `dedupe: 'args'`
  (or `{ windowMs }`) a call with the same arguments is neither run nor
  asked and the model receives `{ executed: false, reason: 'duplicate', previous }`.
  A handler returning `{ error }` does not count as a completed run.

  Inside your own conversation use `confirmWith(c)`:

  ```ts
  bot.conversation('support', async (c, ctx) => {
    const text = await c.ask('How can I help you?')
    await ctx.reply(await ctx.tools.ai.replyInChat(chatKeyOf(ctx), text, { ctx, confirm: confirmWith(c) }))
  })
  ```

  Without a confirmer (e.g. a bare `ctx.tools.ai.ask()`), `confirm: true`
  tools are denied.
- **Audit**: `bot.on('ai.tool', (e) => ...)` or `onToolEvent` receive
  `tool.call`, `tool.confirm.*` (also `tool.confirm.replied`), `tool.duplicate`,
  `tool.result`, `tool.error`, `tool.timeout`, `tool.invalid_args`, `tool.unknown`,
  `tool.truncated` (call cut by the token cap: it is not run, the model is told
  and the plugin logs a warning) and `loop.max_steps`, with `step`,
  `callId`, `chatKey` and `durationMs`. The events include `args`: treat them
  as personal data. The logger only records metadata.
- The persisted history is still plain user/assistant text; the
  intermediate tool turns are not stored. Streaming does not use tools.

### Best practices for tools with side effects

They come from live tests with real models on WhatsApp: without them the model
computes a total wrong in free text, shows keys such as `pan_de_bono` or says
it "replaced" an order with no tool to do so.

1. **Never let the model compute money**: an effect-free quote
   tool (`cotizar_pedido`) for "how much is it?", the total recomputed in
   the handler that stores it and shown in the confirmation with `confirmLines` (or
   `confirmMessage`), and returned in the result so the model repeats it.
2. **Validate catalog values with `enum`** (they are validated before
   confirming) and pair them with `labels` so the user sees names.
3. **Every create tool brings the change, cancel and list ones**; if it can only
   create, the model "fixes" it by creating another order or invents changes.
4. **`dedupe: 'args'` on the create ones**, so the same thing is not registered twice.
5. **Explicit `{ error }` for unknown ids** (`{ error: 'Order P-123 does not exist. Check my_orders.' }`),
   never a silent `ok`; it is not remembered as done.
6. **`confirm: true` on everything with side effects**; read-only ones do not need it.
7. **Leave the system note on** (`toolConfirm.systemNote`): it forbids the
   model from claiming actions no tool confirmed, asking for confirmation
   itself, mentioning the confirmation process or computing amounts.

```ts
const MENU = { pan_de_bono: { name: 'Pan de bono', price: 2500 }, cafe: { name: 'Café', price: 4000 } }
const quote = (items) => {
  const lines = items.map((i) => ({ ...i, nombre: MENU[i.producto].name, subtotal: MENU[i.producto].price * i.cantidad }))
  return { items: lines, total: lines.reduce((s, l) => s + l.subtotal, 0) }
}
const ITEMS = {
  type: 'array', minItems: 1,
  items: {
    type: 'object',
    properties: { producto: { type: 'string', enum: Object.keys(MENU) }, cantidad: { type: 'integer', minimum: 1 } },
    required: ['producto', 'cantidad'],
  },
}

tools: {
  cotizar_pedido: {
    description: 'Computes prices and total without registering anything.',
    schema: { type: 'object', properties: { items: ITEMS }, required: ['items'] },
    handler: ({ items }) => quote(items),
  },
  crear_pedido: {
    title: 'Crear pedido',
    description: 'Registers a new order.',
    schema: { type: 'object', properties: { items: ITEMS }, required: ['items'] },
    confirm: true,
    dedupe: 'args',
    confirmLines: ({ items }) => {
      const q = quote(items)
      return [...q.items.map((l) => `• ${l.cantidad} × ${l.nombre}: $${l.subtotal}`), `Total: $${q.total}`]
    },
    handler: async ({ items }, { ctx }) => db.orders.create({ chat: ctx?.from, ...quote(items) }),
  },
  // + actualizar_pedido, cancelar_pedido ({ error } when the id does not exist) and mis_pedidos
}
```

The full bakery example is in the
[AI tools](https://github.com/andresayac/botmesh/blob/main/docs/guide/ai-tools.md#best-practices-for-tools-with-side-effects)
guide and the `ai-full` template of `create-botmesh` ships the same tools.

For tests, `MockAIProvider` accepts turns with tool calls:

```ts
new MockAIProvider({
  reply: (input) => input.messages.at(-1)?.role === 'tool'
    ? 'Done'
    : { toolCalls: [{ name: 'buscar_producto', args: { q: 'pan' } }] },
})
```

## `/reset` and `slashCommandsPlugin`

`aiPlugin` registers its own `/reset`: it clears the chat's AI context **and**
cancels the active conversation. Command registration is "last `plug()`
wins" (core behaviour), so if you also use
`slashCommandsPlugin` (which brings its own `/reset` to cancel
conversations), **plug `aiPlugin` after it** so its `/reset` prevails:

```ts
bot.plug(slashCommandsPlugin, { greeting: '🤖 Hello!' })
bot.plug(aiPlugin({ apiKey: process.env.ANTHROPIC_API_KEY })) // its /reset wins
```

## Testing

`MockAIProvider` implements `AIProvider` with fixed or programmable answers
and zero network — use it to test your own logic around `AIClient` without
calling a real provider:

```ts
import { AIClient, ContextManager, MockAIProvider, type ConvStore, type AIMessage } from '@botmesh/ai'

const memory = new Map<string, AIMessage[]>()
const store: ConvStore = {
  async getConversation(k) { return memory.get(k) },
  async setConversation(k, m) { memory.set(k, m) },
  async clearConversation(k) { memory.delete(k) },
}

const client = new AIClient(new MockAIProvider({ reply: 'hello from the mock' }), new ContextManager(store))

const answer = await client.ask('what time is it?')
// answer === 'hello from the mock'
```

## Long-term memory per user

With `memory`, the plugin remembers facts about each person across conversations and
restarts. They are stored in the persistent `ctx.user` profile (namespace
`'ai.memory'`, key `facts`), by `ctx.sender`: the same person shares
memory between their private chat and groups. For privacy, facts are **not**
injected into group answers (the whole group reads them) unless you set
`injectInGroups: true`.

```ts
bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  memory: {
    maxFacts: 50,        // the oldest are dropped
    ttl: '90d',          // each fact expires after 90 days (re-affirming it renews it)
    autoExtract: true,   // after each answer, the model extracts facts (strict JSON)
  },
}))

bot.when('what do you know about me', async (ctx) => {
  const facts = await ctx.tools.ai.memory(ctx.sender)
  // → ['Prefers service in Spanish', 'Is from Bogotá']
  await ctx.reply(facts.join('\n') || 'Nothing yet')
})

await bot.injectTools.ai.remember(userId, 'VIP customer')  // by hand
await bot.injectTools.ai.forget(userId, 'VIP customer')    // one
await bot.injectTools.ai.forget(userId)                    // all
await bot.deleteSubject(userId)                            // right to be forgotten: clears memory too
```

`autoExtract` runs **in the background** (it does not block the chat queue) and only
accepts exactly `{"facts": string[]}`; any other answer is discarded.
It accepts `{ model, maxTokens, maxFactsPerTurn, instructions, filter }`. `/reset`
clears the chat context, not the long-term memory. If the user's data is deleted
(`bot.deleteSubject()` or `forget(userId)`) while an extraction
is in flight, its facts are discarded: they never show up again.

## RAG (answers from your documents)

`rag` accepts any object with `retrieve(query)`; the
[`@botmesh/rag`](https://github.com/andresayac/botmesh/tree/main/packages/rag) package ships a ready one (loaders, chunking, embeddings and index):

```ts
import { createRag } from '@botmesh/rag'

bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  rag: {
    retriever: createRag({ documents: ['./docs/faq.md', './docs/productos.pdf'], embeddings: 'openai', chunkSize: 1000, topK: 3 }),
    appendSources: true, // adds "Sources: [1] faq.md › Shipping" (keeps the cited [n])
  },
}))
```

The passages are injected numbered into the system prompt and the model cites with
`[1]`. `ctx.tools.ai.replyInChatDetailed()` also returns `citations` and
`facts`. If retrieval fails or takes longer than `rag.timeoutMs` (10 s by
default, including the first index build), it is logged and the
answer continues without context, without blocking the chat queue.

## Streaming

With `stream`, the autoresponder sends the answer while it is generated with
`ctx.stream()` from `@botmesh/core`: native drafts on Telegram, live edits on
Discord and sentence chunks with "typing…" on WhatsApp.

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',
  stream: true, // or { cursor: ' ▌', canStop: true, onCancel: 'discard' }
}))
```

- It accepts `true` or the core's `StreamOptions` (without `signal` or
  `sendOptions`), plus `enabled: false`. It is off by default.
- A refusal answers `refusalMessage` (not stored); an empty answer or a
  failing stream answers `errorMessage`. With `onCancel: 'discard'`, a
  cancelled answer does not enter the context either.
- With `tools` configured the turns are **not** streamed (the tool loop
  answers in a single message).

In your handlers, `streamReplyInChat()` applies history, memory and RAG:

```ts
await ctx.stream(ctx.tools.ai.streamReplyInChat(chatKeyOf(ctx), ctx.body, { userId: ctx.sender, isGroup: ctx.isGroup }))
```

Stopping the stream aborts the request; the partial answer is stored unless
`keepPartial: false`. `timeoutMs` works as an inactivity timeout between
chunks.

## Roadmap

Non-goals of this first version, already accounted for in the design of
`AIProvider`/`ContextManager` so they can be added later without breaking the API:

- **Auto-summarize / compaction** of the history (instead of trimming by a
  fixed message window).
- Multi-persona per number.

## More documentation

- [Site guide (EN)](https://github.com/andresayac/botmesh/blob/main/docs/guide/ai.md) ·
  [Site guide (ES)](https://github.com/andresayac/botmesh/blob/main/docs/es/guide/ai.md)
- [`@botmesh/core`](https://github.com/andresayac/botmesh/blob/main/packages/core/README.md) — the base framework (plugins,
  DI, conversations)
