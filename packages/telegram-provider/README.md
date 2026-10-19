# @bot-wa/telegram

Telegram Bot API transport ([`IProvider` v2](https://github.com/andresayac/bot-wa-baileys/blob/main/packages/core/src/core/provider.ts)) for
[@bot-wa/core](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core). Plain HTTP over Node's global `fetch` — no extra
runtime dependencies beyond `@bot-wa/core` and `pino`.

- **Ingress:** long-polling (`getUpdates`, default) **or** webhook (`ingest()`).
- **Outbound:** text, photo, video, audio, voice, document, sticker, location,
  contact, **native polls**, reactions, inline keyboards (buttons; lists degrade
  to a keyboard), card, and a `native` passthrough to any Bot API method.
- **Actions:** `editMessageText`, `deleteMessage`, `sendChatAction` (typing),
  `answerCallbackQuery` (interaction ack), media download via `getFile`.
- Media sources: public URL, Telegram `file_id` (reuse via `{ native: file_id }`),
  `Buffer`, file path, or stream (uploaded as multipart/form-data).

## Install

In the monorepo the workspace package is already available. From an app:

```bash
pnpm add @bot-wa/core @bot-wa/telegram
```

Create a bot with [@BotFather](https://t.me/BotFather) and keep the token.

## Config

```ts
interface TelegramProviderConfig {
  token: string        // bot token from @BotFather (required)
  baseUrl?: string     // default 'https://api.telegram.org'
  polling?: boolean    // default true; false = webhook mode (host calls ingest())
  selfId?: string      // bot's own user id; resolved via getMe() when omitted
  pollTimeout?: number // getUpdates server timeout (s), default 30
  errorBackoffMs?: number  // backoff after a failed poll round, default 1000
  pollIdleMs?: number      // pause after an empty batch, default 250
  debug?: boolean
  logger?: Logger      // pino-compatible
}
```

## Usage — long-poll (default)

```ts
import { Bot } from '@bot-wa/core'
import { TelegramProvider } from '@bot-wa/telegram'

const provider = new TelegramProvider({ token: process.env.TG_TOKEN! })

const bot = new Bot({ provider })
bot.when(/^hola/i, async (ctx) => {
  await ctx.reply(`¡Hola ${ctx.pushName ?? ''}! 👋`)
  await ctx.poll('¿Color favorito?', ['Rojo', 'Azul'])          // native poll
  await ctx.buttons('Elige', [                                   // inline keyboard
    { id: 'yes', title: 'Sí' },
    { id: 'no', title: 'No' },
  ])
  await ctx.acknowledge?.('recibido')                            // callback ack
})
await bot.start()   // resolves selfId via getMe, then polls getUpdates
```

`callback_query` updates arrive as interactions; `ctx.interaction` is set and
`ctx.acknowledge(text?)` calls `answerCallbackQuery`.

## Usage — webhook (Express)

```ts
import express from 'express'
import { Bot } from '@bot-wa/core'
import { TelegramProvider } from '@bot-wa/telegram'

const provider = new TelegramProvider({ token: process.env.TG_TOKEN!, polling: false })
const bot = new Bot({ provider })
bot.when('hola', async (ctx) => await ctx.reply('¡Hola!'))
await bot.start()

const app = express()
app.post(`/telegram/${process.env.TG_TOKEN}`, express.json(), (req, res) => {
  // Verify the secret token header you passed to setWebhook:
  if (req.header('X-Telegram-Bot-Api-Secret-Token') !== process.env.TG_SECRET) {
    return res.sendStatus(403)
  }
  res.sendStatus(provider.ingest(req.body) as number) // 200 accepted / 400 bad body
})
app.listen(3000)
// Register once: POST /bot<token>/setWebhook { url, secret_token }
```

`ingest(rawUpdate)` accepts the parsed body **or** the raw JSON string and
returns the HTTP status to answer with (Telegram retries anything non-2xx).

## Media

```ts
await ctx.photo('https://example.com/i.png', 'caption')  // URL — Telegram fetches it
await ctx.photo({ native: 'AgACAgEAAx...' })             // reuse an existing file_id
await ctx.file(Buffer.from(bytes), 'report.pdf')         // multipart upload
await ctx.file('/tmp/report.pdf')                        // local path → upload

// Inbound media is lazy:
if (ctx.media) {
  const bytes = await provider.downloadMedia!(ctx.quoted?.ref ? /* MediaRef */ (ctx as any).media : undefined)
}
```

`downloadMedia(ref)` resolves `file_id → getFile → file_path` and fetches
`{baseUrl}/file/bot{token}/{file_path}` (20 MB Bot API limit).

## Capabilities

| Capability               | Value  | Notes                                             |
| ------------------------ | ------ | ------------------------------------------------- |
| `buttons`                | ✅     | inline keyboard (`callback_data` = button id)     |
| `lists`                  | ❌     | degrades to an inline keyboard                    |
| `polls`                  | ✅     | native `sendPoll`                                 |
| `reactions`              | ✅     | `setMessageReaction`                              |
| `edit`                   | ✅     | `editMessageText` (text only)                     |
| `typing`                 | ✅     | `sendChatAction` (typing / record_voice)          |
| `presence`               | ❌     | bots cannot read presence                         |
| `readReceipts`           | ❌     | bots get no read receipts (`markRead` is a no-op) |
| `groups`                 | ✅     | group / supergroup / channel classification       |
| `templates`              | ❌     | use `text`/`buttons`/`native`                     |
| `interactionsRequireAck` | ❌     | `answerCallbackQuery` stops the spinner; no hard deadline |
| `pushIngress`            | ✅     | webhook supported; long-poll also owned           |

## Error mapping

Bot API errors become typed `@bot-wa/core` errors:

| HTTP | Maps to                                              |
| ---- | ---------------------------------------------------- |
| 429  | `RateLimitedError` (`retryAfterMs` from `retry_after`) |
| 403  | `RecipientUnreachableError` (blocked / chat not found) |
| 400 *message is too long* | `PayloadTooLargeError` (4096 chars) |
| 401  | `ProviderError` + connection `sessionInvalid`        |
| 409 conflict (two pollers) | connection `sessionTakenOver`, poll loop stops |

## Notes

- Identity is resolved inside the provider: `chatId = String(chat.id)`,
  `senderId = String(from.id)` (fallbacks: `sender_chat.id`, then `chat.id`).
  Timestamps are emitted as epoch **milliseconds**.
- Long-poll and webhook share one ingress path; never run two pollers on the
  same token (Telegram returns 409 and the provider stops deliberately).
- ESM only (`"type": "module"`); relative imports carry `.js` extensions.
