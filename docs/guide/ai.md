# AI plugin

`@bot-wa/ai` is a **separate package** that adds a multi-provider AI
autoresponder (Anthropic / OpenAI / Ollama) plus a `ctx.tools.ai` client you
can call from your own handlers, flows and conversations.

::: tip Separate package
Unlike `slashCommandsPlugin` (bundled with the core), `@bot-wa/ai` ships as
its own package so the core stays free of AI dependencies.
:::

## Install

```bash
pnpm add @bot-wa/ai @anthropic-ai/sdk
```

The second package is the SDK of whichever provider you use:

| Provider | SDK to install |
|---|---|
| `anthropic` (default) | `@anthropic-ai/sdk` |
| `openai` | `openai` |
| `ollama` | none — talks plain HTTP (`fetch`) to a local/remote Ollama server |

## Quickstart (autoresponder)

```ts
import { Bot } from '@bot-wa/bot-wa-baileys'
import { aiPlugin } from '@bot-wa/ai'

const bot = new Bot({ session: 'my-bot' })

bot.plug(aiPlugin({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  persona: 'You are a support assistant, answer briefly.',
}))

await bot.start()
```

This registers:
- A catch-all autoresponder (`bot.onMessage`) that answers any **text**
  message no other handler/command/conversation consumed, keeping a
  per-chat history (bounded window, 20 messages by default — see
  `context.maxMessages`).
- A `/reset` command that clears the chat's AI context and cancels the
  active conversation (opt out with `resetCommand: false`).

## Advanced: `ctx.tools.ai`

The plugin also does `bot.provide('ai', client)`, so `ctx.tools.ai` is
available in any `when()`, flow or conversation. Turn off the autoresponder
(`autoReply: false`) if that's all you want:

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  autoReply: false,
}))

bot.conversation('summary', async (c, ctx) => {
  await ctx.reply('📋 Paste the text to summarize:')
  const text = await c.waitText()
  const summary = await ctx.tools.ai.ask(`Summarize in 3 lines: ${text}`)
  await ctx.reply(summary)
})
```

`ctx.tools.ai` (an `AIClient`) exposes:

- `ask(prompt: string): Promise<string>` — a one-shot question, **without**
  chat history (does not read or write the saved context). Uses the
  `persona`/`model`/`maxTokens`/`effort` configured on `aiPlugin`.
- `generate(input: { messages, system?, model?, maxTokens?, effort?, signal? }): Promise<GenerateResult>` —
  full control: explicit messages and per-call overrides.
- `stream(input): AsyncIterable<string>` — same as `generate` but yields the
  text incrementally (`for await (const delta of ...)`).

## The 3 providers

### Anthropic (default)

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',                     // optional, it's the default
  apiKey: process.env.ANTHROPIC_API_KEY,     // or let the SDK read ANTHROPIC_API_KEY from env
  // model: 'claude-opus-4-8',               // default; consider 'claude-sonnet-5' or
                                              // 'claude-haiku-4-5' for high-volume chat (cheaper)
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

`baseUrl` is optional (OpenAI-compatible endpoints).

### Ollama (local, no API key)

```ts
bot.plug(aiPlugin({
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',   // default if omitted
  model: 'llama3.1',                   // REQUIRED: OllamaProvider has no default model
}))
```

::: warning `model` is required for openai and ollama
Neither provider ships a sensible default (too many valid model ids, and
they change often) — if you omit it, the provider throws an explicit error
on the first `generate`/`stream` call. `anthropic` does have a default
(`claude-opus-4-8`).
:::

If the chosen provider's SDK isn't installed, `aiPlugin` fails at install
time with an actionable error (it tells you which `pnpm add` to run) instead
of crashing in production on the first reply.

## Full `aiPlugin(config)` reference

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | `'anthropic' \| 'openai' \| 'ollama'` | `'anthropic'` | provider to resolve |
| `model` | `string` | provider-dependent | model to use (required for openai/ollama) |
| `apiKey` | `string` | — | API key (anthropic/openai; if omitted, the provider's SDK tries to read it from the environment) |
| `baseUrl` | `string` | — | endpoint override (openai `baseURL` / ollama host) |
| `persona` | `string` | — | system prompt |
| `maxTokens` | `number` | `1024` | output token limit (anthropic/openai; ollama currently ignores it) |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | — | reasoning effort (Anthropic only) |
| `context.maxMessages` | `number` | `20` | history window kept per chat |
| `autoReply` | `boolean` | `true` | registers the catch-all autoresponder |
| `resetCommand` | `boolean` | `true` | registers `/reset` |
| `errorMessage` | `string` | `'⚠️ Ahora no puedo responder, intenta luego.'` | reply sent if the provider fails |
| `refusalMessage` | `string` | `'No puedo ayudar con eso.'` | reply sent when the provider refuses (`stopReason === 'refusal'`) |
| `humanizeTyping` | `boolean` | `true` | sends "typing…" (`ctx.typing()`) before replying |

## `/reset` and `slashCommandsPlugin`

`aiPlugin` registers its own `/reset`: it clears the chat's AI context **and**
cancels the active conversation. Command registration is "last `plug()`
wins" (documented core behavior), so if you also use `slashCommandsPlugin`
(which ships its own `/reset` to cancel conversations), **install `aiPlugin`
after it** so its `/reset` takes precedence:

```ts
bot.plug(slashCommandsPlugin, { greeting: '🤖 Hi!' })
bot.plug(aiPlugin({ apiKey: process.env.ANTHROPIC_API_KEY })) // its /reset wins
```

## Testing

`MockAIProvider` implements `AIProvider` with fixed or scriptable replies and
no network calls — use it to test your own logic around `AIClient` without
hitting a real provider:

```ts
import { AIClient, ContextManager, MockAIProvider, type ConvStore, type AIMessage } from '@bot-wa/ai'

const memory = new Map<string, AIMessage[]>()
const store: ConvStore = {
  async getConversation(k) { return memory.get(k) },
  async setConversation(k, m) { memory.set(k, m) },
  async clearConversation(k) { memory.delete(k) },
}

const client = new AIClient(new MockAIProvider({ reply: 'mock reply' }), new ContextManager(store))

const answer = await client.ask('what time is it?')
// answer === 'mock reply'
```

## Roadmap

Non-goals of this first version, already accounted for in the
`AIProvider`/`ContextManager` design so they can be added later without
breaking the API:

- **Function/tool calling** — letting the AI trigger bot actions.
- **Auto-summarize / compaction** of the history (instead of trimming to a
  fixed message window).
- RAG / embeddings.
- Multi-persona per number.

## Next steps

- [Plugins](./plugins) — how `bot.plug()`/`definePlugin` work in general
- [Dependency injection](./di) — how `ctx.tools` is wired
