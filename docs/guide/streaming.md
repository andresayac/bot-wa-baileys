# Streaming replies (`ctx.stream`)

`ctx.stream(source, opts)` sends a reply that is still being generated (LLM
tokens, a long report) while it is produced, with the best strategy the
channel supports: native drafts on Telegram, live edits on Discord, and
sentence-sized messages with "typing…" on WhatsApp. The same handler works on
every channel.

```ts
bot.when('story', async (ctx) => {
  const result = await ctx.stream(
    ctx.tools.ai.stream({ messages: [{ role: 'user', content: 'Tell a short story' }] }),
  )
  result.text       // full text received
  result.messages   // every message sent
  result.strategy   // 'draft' | 'edit' | 'chunk' | 'buffer'
})
```

The source can be any `AsyncIterable` of strings or bytes (an async
generator, a Node `Readable`), a web `ReadableStream`, or a plain `Iterable`
of strings. Byte chunks are decoded as UTF-8.

## Strategies per channel

The provider declares `capabilities.streaming` (`'draft' | 'edit' | 'none'`)
and `ctx.stream()` picks the strategy from it:

| Strategy | What the user sees | Used by default on |
|---|---|---|
| `'draft'` | A native ephemeral preview updated in place, then one final message. | Telegram private chats (`sendMessageDraft`) |
| `'edit'` | The first text is sent, then that message is edited as text arrives. | Discord; Telegram groups |
| `'chunk'` | No live preview: sentence-sized messages, with typing between them. | WhatsApp (Baileys and Cloud API), Messenger, Instagram, and any provider without `streaming` |
| `'buffer'` | Typing while everything is collected, then one send (split if long). | Only when requested |

- Drafts are only attempted in private chats. If the transport refuses a
  draft at runtime, the stream degrades to edits (when the channel can edit)
  or to chunks.
- `strategy` forces a choice; an unsupported one degrades
  `draft` → `edit` → `chunk`. `'chunk'` and `'buffer'` are always available.
- No message ever exceeds `maxLength` (default `capabilities.maxTextLength`,
  else 4096): long text is split at natural boundaries (paragraphs, lines,
  sentences, words) and continues in a new message.

## Options

| Option | Default | Description |
|---|---|---|
| `strategy` | `'auto'` | `'auto' \| 'draft' \| 'edit' \| 'chunk' \| 'buffer'`. |
| `throttleMs` | `400` (draft), `1000` (edit) | Minimum ms between two live updates. |
| `signal` | — | `AbortSignal` that cancels the stream. |
| `onCancel` | `'flush'` | On cancel, `'flush'` sends what was produced; `'discard'` sends nothing more and removes the live preview (see below). |
| `maxLength` | `capabilities.maxTextLength`, else 4096 | Max characters per message. |
| `minChunkChars` | `160` | `'chunk'`: minimum characters before a chunk is sent at a sentence boundary. |
| `maxChunkChars` | `min(maxLength, 1500)` | `'chunk'`: hard size of a chunk with no sentence boundary. |
| `typing` | `true` | Show typing while waiting (chunk, buffer, and edit before its first message). |
| `typingIntervalMs` | `8000` | Interval to refresh the typing indicator. |
| `cursor` | `''` | Suffix shown on in-progress drafts and edits (e.g. `' ▌'`), never in the final text. |
| `canStop` | `false` | Draft: show a stop button (Telegram `can_stop`). |
| `keepOnStop` | — | Draft: keep the draft visible when the user stops it (Telegram `keep_on_stop`). |
| `sendOptions` | — | Options for the first message sent (e.g. `{ quoted: ctx.ref }`). |
| `draftPlatformData` | — | Transport passthrough for draft calls (e.g. Telegram `message_thread_id`). |

`ctx.stream()` resolves with a `StreamResult`: `text`, `messages`,
`strategy` (the one actually used, after any fallback), `cancelled` and
`stoppedByUser`. It rejects with the source's error (after flushing what was
produced) or with the first send error.

## Cancellation

A stream stops when `signal` aborts or, on Telegram drafts with
`canStop: true`, when the user presses the stop button (`stoppedByUser:
true`). Reading stops and the source's `return()` is called, so an AI request
is aborted too. `bot.stop()` also cancels every running `ctx.stream()` (after the `drain`, if
any), but sends nothing more: no final flush, edit or deletion, whatever `onCancel` says.

- `onCancel: 'flush'` (default) sends the text produced so far.
- `onCancel: 'discard'` sends nothing more: a draft simply expires and, with
  the edit strategy, the message being edited is deleted (when the channel can
  delete; otherwise only the cursor is removed). Messages already completed
  before the cancel stay.

The Telegram long-poll asks for `stopped_message_generation` updates, which
carry the stop button presses.

## Rate limits

Live updates are throttled and never run concurrently. When the transport
answers with a `RateLimitedError`, live updates pause for its `retryAfterMs`.
The final edit (which removes the cursor and shows the full text) waits out
the back-off and retries a rate limit up to three times.

## Hooks and the message log

Everything `ctx.stream()` outputs goes through the `before('send')`
[hooks](/guide/hooks), so a hook that redacts, translates or aborts replies
also covers streamed text. The payload carries a `stream` marker:

| `payload.stream` | What it is | Hooks |
|---|---|---|
| `'draft'` | A live draft preview. | `before('send')` only |
| `'edit'` | A live edit of the message being streamed. | `before('send')` only |
| `'message'` | A new message the stream sends: the first message of an edit stream, each chunk, the final message after drafts. | `before('send')` and `after('send')` |

```ts
bot.before('send', async (payload, next) => {
  if (payload.stream === 'draft' || payload.stream === 'edit') {
    // live preview: cheap transforms only, it runs on every update
  }
  await next()
})
```

A hook that aborts a draft or an edit skips that update. The message log keeps
the final edited text of each message.

## With `@botmesh/ai`

The AI autoresponder streams its answer with the `stream` option:

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',
  persona,
  stream: true,                                        // default StreamOptions
  // stream: { cursor: ' ▌', canStop: true, onCancel: 'discard' },
}))
```

- `stream` takes `true` or the `StreamOptions` above (without `signal` and
  `sendOptions`), plus `enabled: false` to turn it off while keeping the
  options. Default: off (one message at the end).
- Typing follows `humanizeTyping` unless you set `typing` yourself.
- A refusal replies `refusalMessage` and is not stored; an empty answer
  replies `errorMessage`, as does a stream that fails.
- With `onCancel: 'discard'`, a cancelled answer is also kept out of the AI
  context, since the user never saw it in full.
- With `tools` configured, turns are not streamed: the
  [tool loop](/guide/ai-tools) needs the whole answer, so the autoresponder
  falls back to one message.

In your own handlers, `ctx.tools.ai.streamReplyInChat()` is the streaming
twin of `replyInChat()`: it reads and stores the chat history, applies
[memory and RAG](/guide/ai-memory-rag) and yields the answer piece by piece.

```ts
import { chatKeyOf } from '@botmesh/ai'

bot.when('explain', async (ctx) => {
  await ctx.stream(
    ctx.tools.ai.streamReplyInChat(chatKeyOf(ctx), ctx.body, { userId: ctx.sender, isGroup: ctx.isGroup }),
    { cursor: ' ▌' },
  )
})
```

Stopping the stream aborts the provider request; the partial answer is stored
unless you pass `keepPartial: false` (pair it with `onCancel: 'discard'`).
The plugin's `timeoutMs` applies as an idle timeout: no chunk for that long
throws `AITimeoutError`.

With [`@botmesh/voice`](/guide/voice) and `autoReplyWithVoice`, streamed output
always stays text.

## Custom sinks

`ctx.stream()` is `streamText()` bound to the current chat. For other targets
(a web widget, a test) use it directly with a `StreamTarget`:

```ts
import { streamText, splitMessage } from '@botmesh/core'

const result = await streamText({
  capabilities: { streaming: 'edit', maxTextLength: 2000 },
  send: async (content) => widget.post(content),
  edit: async (ref, content) => widget.update(ref, content),
}, source, { throttleMs: 500 })

for (const part of splitMessage(longText, 4096)) await ctx.reply(part)
```

`resolveStreamStrategy(target, requested)` tells you which strategy a target
would get, and `findSplitPoint(text, max)` where text would be cut.

## Testing

`MockProvider` simulates each mode with its `streaming` option:

```ts
import { vi } from 'vitest'
import { createTestBot } from '@botmesh/core/testing'

const { bot, chat, provider } = await createTestBot({}, { provider: { streaming: 'edit' } })
let done = false
bot.when('hi', async (ctx) => {
  await ctx.stream(['Hello', ' there'], { throttleMs: 0 })
  done = true
})

await chat.send('hi')
await vi.waitFor(() => expect(done).toBe(true)) // the stream outlives chat.send()
provider.outbox // the first message
provider.edits  // the live and final edits
```

`streaming: 'edit'` also exposes `editMessage` (recorded in `edits`) and
`deleteMessage` (`deleted`); `streaming: 'draft'` adds `sendDraft` (recorded
in `drafts`). `maxTextLength` simulates the length limit, and `supports`
enables or hides each seam individually.

## Next steps

- [AI plugin](/guide/ai) — the autoresponder and `ctx.tools.ai`
- [Messages & media](/guide/messages) — edits, typing and per-transport support
- [Hooks](/guide/hooks) — the `send` pipeline
