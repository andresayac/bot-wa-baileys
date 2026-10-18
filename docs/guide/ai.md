# AI plugin

`@bot-wa/ai` is a **separate package** that adds a multi-provider AI
autoresponder (Anthropic / OpenAI / Ollama / Gemini plus nine
OpenAI-compatible presets) and a `ctx.tools.ai` client you can call from
your own handlers, flows and conversations.

::: tip Separate package
Unlike `slashCommandsPlugin` (bundled with the core), `@bot-wa/ai` ships as
its own package so the core stays free of AI dependencies.
:::

## WhatsApp AI policy (since 2026-01-15)

::: warning General-purpose AI assistants are not allowed on the WhatsApp Business Platform
Since **January 15, 2026**, Meta's terms for the WhatsApp Business Platform
(the *AI Providers* section) **prohibit general-purpose AI assistants**:
open-ended, ChatGPT-style chatbots whose main purpose is the AI itself.
Using AI **in service of the business** (customer support, sales, bookings,
order tracking) is still allowed.
:::

What that means for `aiPlugin`:

- Write a `persona` **scoped to your business** (what you sell, opening
  hours, policies) that politely declines anything unrelated — see the
  [quickstart](#quickstart-autoresponder) below.
- Offer a way to reach a human and don't market the bot as an
  "ask me anything" assistant.
- The rule comes from the official Cloud API terms (`@bot-wa/meta`). Baileys
  is an unofficial WhatsApp Web client and is also subject to WhatsApp's
  terms.

This is practical guidance, not legal advice — check the
[current terms](https://www.whatsapp.com/legal/business-solution-terms)
before going live.

## Install

::: warning Alpha — first npm publish pending
`@bot-wa/ai` is part of the first alpha, which is **not on npm yet**. Until
it is published, use it from the monorepo (`workspace:*`); the commands
below are the ones that will work once it is.
:::

```bash
pnpm add @bot-wa/ai @anthropic-ai/sdk
```

The second package is the SDK of whichever provider you use:

| Provider | SDK to install |
|---|---|
| `anthropic` (default) | `@anthropic-ai/sdk` |
| `openai` | `openai` |
| `gemini` | `@google/generative-ai` |
| `ollama` | none — talks plain HTTP (`fetch`) to a local/remote Ollama server |
| `deepseek`, `qwen`, `glm`, `kimi`, `groq`, `openrouter`, `mistral`, `grok`, `together` | `openai` — they're OpenAI-compatible presets reached through the `openai` SDK with a custom `baseURL` |

## Quickstart (autoresponder)

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { aiPlugin } from '@bot-wa/ai'

const bot = new Bot({ provider: new BaileysProvider({ session: 'my-bot' }) })

// Business-scoped persona (see "WhatsApp AI policy" above).
const persona = [
  'You are the customer-support assistant of La Espiga Bakery.',
  'You only answer about its products, prices, opening hours (Mon-Sat 7:00-20:00), orders and pre-orders.',
  'If asked about anything unrelated to the bakery, politely say you can only help with that',
  'and offer to hand the chat over to a person. Answer briefly; never make up facts.',
].join(' ')

bot.plug(aiPlugin({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  persona,
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

bot.conversation('complaint', async (c, ctx) => {
  await ctx.reply('📝 Tell us what went wrong with your order:')
  const text = await c.waitText()
  const summary = await ctx.tools.ai.ask(
    `Summarize this customer complaint in 3 lines for the support team: ${text}`,
  )
  await ctx.reply(`✅ We logged your complaint:\n${summary}`)
})
```

`ctx.tools.ai` (an `AIClient`) exposes:

- `ask(prompt, opts?): Promise<string>` — a one-shot question, **without**
  chat history (does not read or write the saved context). Uses the
  `persona`/`model`/`maxTokens`/`effort` configured on `aiPlugin` (and the
  [tools](/guide/ai-tools), when configured).
- `replyInChat(chatKey, text, opts?): Promise<string>` — answers inside a
  chat's history (reads it and stores the turn), the same way the
  autoresponder does. `opts` takes `{ userId, isGroup }` for
  [memory](/guide/ai-memory-rag) and `{ ctx, confirm, signal }` for tools; use
  `chatKeyOf(ctx)` as the key. `replyInChatDetailed()` also returns the
  citations and facts of the turn.
- `streamReplyInChat(chatKey, text, opts?)` — the streaming twin of
  `replyInChat`, to feed [`ctx.stream()`](/guide/streaming).
- `runTools(input, opts?)` — runs the [tool loop](/guide/ai-tools) and returns
  its full result.
- `memory()`, `memoryFacts()`, `remember()`, `forget()`, `extractMemory()` —
  the [long-term memory](/guide/ai-memory-rag) API; `idle()` waits for
  background extraction.
- `generate(input: { messages, system?, model?, maxTokens?, effort?, signal? }): Promise<GenerateResult>` —
  full control: explicit messages and per-call overrides.
- `stream(input): AsyncIterable<string>` — same as `generate` but yields the
  text incrementally (`for await (const delta of ...)`).

**Typing (TypeScript).** Importing `@bot-wa/ai` augments the core's
`DefaultTools` interface, so `ctx.tools.ai` is already an `AIClient` in
`when()`, `onMessage()` and `command()` handlers (and in
`bot.injectTools.ai`), with no casts. The type does not check that the plugin
is installed: without `bot.plug(aiPlugin(...))` (or after `unplug()`),
`ctx.tools.ai` is `undefined` at runtime.

## The providers

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

### Gemini

Requires `@google/generative-ai` (optional peer, lazy-loaded). Note: Google has
since published a newer SDK (`@google/genai`); this provider still targets
`@google/generative-ai` — migration is tracked separately.

```ts
bot.plug(aiPlugin({
  provider: 'gemini',
  apiKey: process.env.GEMINI_API_KEY,  // or GOOGLE_API_KEY in the environment
  // model: 'gemini-2.0-flash',        // default if omitted
}))
```

### Ollama (local, no API key)

```ts
bot.plug(aiPlugin({
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',   // default if omitted
  model: 'llama3.1',                   // REQUIRED: OllamaProvider has no default model
}))
```

### Presets — DeepSeek, Qwen, GLM, Kimi, Groq, OpenRouter, Mistral, Grok, Together

Every preset is an OpenAI-compatible endpoint reached through the `openai`
SDK with a custom `baseURL` — zero extra dependencies beyond `openai`, and
each ships a default model and its conventional env var for the API key:

```ts
bot.plug(aiPlugin({ provider: 'deepseek' }))  // reads DEEPSEEK_API_KEY, model deepseek-chat
```

| Preset | Env var | Default model |
|---|---|---|
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `qwen` | `DASHSCOPE_API_KEY` | `qwen-plus` |
| `glm` | `ZHIPUAI_API_KEY` | `glm-4-plus` |
| `kimi` | `MOONSHOT_API_KEY` | `moonshot-v1-8k` |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter/auto` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-small-latest` |
| `grok` | `XAI_API_KEY` | `grok-2-latest` |
| `together` | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |

`apiKey` and `model` override the defaults:

```ts
bot.plug(aiPlugin({
  provider: 'groq',
  apiKey: process.env.GROQ_API_KEY,
  model: 'llama-3.3-70b-versatile',
}))
```

::: warning `model` is required for openai and ollama
Neither provider ships a sensible default (too many valid model ids, and
they change often) — if you omit it, the provider throws an explicit error
on the first `generate`/`stream` call. `anthropic` (`claude-opus-4-8`),
`gemini` and the presets do have defaults.
:::

If the provider is misconfigured (SDK not installed, unknown provider, missing
API key), `aiPlugin` **does not crash the process**: `install` is synchronous
and resolves the provider lazily. At startup a "warmup" logs the problem to the
error log (with the `pnpm add` hint when an SDK is missing), and from then on
each message replies the configured `errorMessage` instead of taking the bot
down.

## Full `aiPlugin(config)` reference

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | `'anthropic' \| 'openai' \| 'ollama' \| 'gemini' \| 'deepseek' \| 'qwen' \| 'glm' \| 'kimi' \| 'groq' \| 'openrouter' \| 'mistral' \| 'grok' \| 'together'` | `'anthropic'` | provider to resolve |
| `model` | `string` | provider-dependent | model to use (required for openai/ollama) |
| `apiKey` | `string` | env var fallback | API key (if omitted, each provider tries its conventional env var) |
| `baseUrl` | `string` | preset-dependent | endpoint override (openai `baseURL` / ollama host) |
| `persona` | `string` | — | system prompt |
| `maxTokens` | `number` | `4096` (anthropic) / `1024` (openai, presets, gemini) | output token limit (not sent to ollama) |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | — | reasoning effort (Anthropic only) |
| `timeoutMs` | `number` | `60000` | per-call timeout for non-streaming calls; on expiry the request is aborted and rejects, so a hung provider can't block the chat's queue (`0` disables it — not recommended) |
| `context.maxMessages` | `number` | `20` | history window kept per chat |
| `autoReply` | `boolean` | `true` | registers the catch-all autoresponder |
| `resetCommand` | `boolean` | `true` | registers `/reset` |
| `errorMessage` | `string` | `'⚠️ Ahora no puedo responder, intenta luego.'` | reply sent if the provider fails |
| `refusalMessage` | `string` | `'No puedo ayudar con eso.'` | reply sent when the provider refuses (`stopReason === 'refusal'`) |
| `humanizeTyping` | `boolean` | `true` | sends "typing…" (`ctx.typing()`) while the answer is generated; the reply then skips the `BotConfig.typing` pacer, so the indicator shows once |
| `tools` | `Record<string, AITool>` | — | functions the model may call (see [Tool calling](#tool-calling)) |
| `maxSteps` | `number` | `5` | max model calls per turn in the tool loop |
| `toolTimeoutMs` | `number` | `15000` | default per-tool timeout (`0` disables it) |
| `maxStepsMessage` | `string` | localized `ai.tools.maxSteps` (es: `'No pude completar la solicitud. Intenta de nuevo con más detalle.'`) | reply when the tool loop hits `maxSteps` |
| `toolConfirm` | `{ yes?: string[]; timeout?: number \| string }` | `{ timeout: '2m' }` | confirmation dialog of `confirm: true` tools |
| `onToolEvent` | `(event: AIToolEvent) => void` | — | audit hook for every tool loop event (also emitted as `bot.on('ai.tool')`) |
| `memory` | `boolean \| AIMemoryConfig` | — | long-term per-user memory (see [Memory and RAG](#memory-and-rag)) |
| `rag` | `AIRetriever \| AIRagConfig` | — | answers grounded in your documents (see [Memory and RAG](#memory-and-rag)) |
| `stream` | `boolean \| AIStreamConfig` | off | stream the autoreply with `ctx.stream()` (see [Streaming](#streaming)) |

## Tool calling

With `tools`, the model can call your bot's functions through native tool /
function calling (Anthropic, OpenAI and the compatible presets, Gemini,
Ollama), in a multi-step loop with per-tool timeouts, errors fed back to the
model, human confirmation for `confirm: true` tools and audit events:

```ts
bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  tools: {
    search_product: {
      description: 'Search the catalog by text',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      handler: async ({ q }: { q: string }) => db.products.search(q),
    },
  },
}))
```

Full guide: [AI tool calling](/guide/ai-tools).

## Memory and RAG

`memory` remembers facts about each user across conversations (stored in
`ctx.user`, injected into the autoreply, optionally extracted by the model in
the background). `rag` answers from your documents with numbered citations,
using any retriever, such as `createRag()` from the experimental
`@bot-wa/rag` package.

```ts
bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  memory: { autoExtract: true, ttl: '90d' },
  rag: { retriever: createRag({ documents: ['./docs/faq.md'] }), appendSources: true },
}))
```

Full guide: [AI memory & RAG](/guide/ai-memory-rag).

## Streaming

`stream: true` sends the autoreply while it is generated: native drafts on
Telegram, live edits on Discord, sentence chunks with typing on WhatsApp.
Turns with tools are not streamed. Full guide:
[Streaming replies](/guide/streaming#with-bot-wa-ai).

## Voice notes

The autoresponder answers text messages only. With the experimental
[`@bot-wa/voice`](/guide/voice) plugin, voice notes are transcribed before
routing (use `autoTranscribe: { asText: true }` so the AI answers them) and
`autoReplyWithVoice` can send the answer back as audio.

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

`reply` can also be a function of the request that returns `{ toolCalls }`
to script tool calls (see [Testing in the tool calling guide](/guide/ai-tools#testing)),
and `mock.calls` records every request the client sent.

## Roadmap

Non-goals of this first version, already accounted for in the
`AIProvider`/`ContextManager` design so they can be added later without
breaking the API:

- **Auto-summarize / compaction** of the history (instead of trimming to a
  fixed message window).
- Multi-persona per number.

## Next steps

- [AI tool calling](/guide/ai-tools) — let the model call your bot's functions
- [AI memory & RAG](/guide/ai-memory-rag) — per-user facts and answers from your documents
- [Streaming replies](/guide/streaming) — `ctx.stream()` per channel
- [Voice](/guide/voice) — transcribe voice notes and answer with audio
- [Plugins](./plugins) — how `bot.plug()`/`definePlugin` work in general
- [Dependency injection](./di) — how `ctx.tools` is wired
