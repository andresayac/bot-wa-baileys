# @botmesh/tiktok

> **Experimental, not yet published on npm.** The package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`).

**TikTok** transport for [`@botmesh/core`](../core) built on the **official TikTok API for Business (v1.3)**. It works through webhooks (`pushIngress`) and opens no socket. It covers two surfaces:

| Surface | Inbound (webhook) | Reply | Requirements |
|---|---|---|---|
| **Comments** on your own videos or photos | `comment.update` (`event_type: COMMENT` subscription) | `POST /business/comment/reply/create/` | `comment.list` scope + "Manage Account Comment" |
| **Direct messages** (Business Messaging API) | `im_receive_msg` (`event_type: DIRECT_MESSAGE` subscription) | `POST /business/message/send/` | Approved Business Messaging access, account with Advanced Access or Verified Business, account owner over 18 |
| **High-intent comments** (Comment-to-Message) | `im_receive_high_intent_comment` | `/business/message/send/` with `direct_reply` | Only accounts registered in Vietnam, Indonesia or Thailand |

Every webhook POST is validated with **`TikTok-Signature`** (HMAC-SHA256 of `${t}.${rawBody}` with the app secret and an anti-replay window). Every outbound request goes through [`@botmesh/http`](../http)'s `secureFetch`, which requires HTTPS, blocks private hosts and applies timeouts and size limits.

## Usage

```ts
import { Bot } from '@botmesh/core'
import { TikTokProvider } from '@botmesh/tiktok'
import express from 'express'

const provider = new TikTokProvider({
  accessToken: process.env.TIKTOK_TOKEN!,          // or an async function that refreshes it
  businessId: process.env.TIKTOK_BUSINESS_ID!,     // open_id from /tt_user/oauth2/token/
  appSecret: process.env.TIKTOK_APP_SECRET!,       // verifies TikTok-Signature
  selfUniqueIdentifier: process.env.TIKTOK_SELF_UID!, // account unique_identifier (required for comments)
})

const bot = new Bot({ provider })

// Comments: the chat is the comment thread (ctx.isGroup === true)
bot.when('price', async (ctx) => {
  await ctx.reply('Thanks for your comment! We will DM you 🙌')
})

// DMs: Q&A card menu (1 to 3 buttons; more become a numbered text menu)
bot.when('hello', async (ctx) => {
  await ctx.buttons('What do you need?', [
    { id: 'prices', title: 'Prices' },
    { id: 'hours', title: 'Hours' },
  ])
})

await bot.start()

// YOUR server serves the webhook. Pass the RAW body: the signature is computed over those bytes.
const app = express()
app.post('/tiktok/webhook', express.raw({ type: '*/*' }), (req, res) => {
  res.sendStatus(provider.ingest(req.body, req.headers))
})
app.listen(3000)
```

Register the webhook URL once per app (not per account):

```bash
curl -X POST https://business-api.tiktok.com/open_api/v1.3/business/webhook/update/ \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"…","secret":"…","event_type":"COMMENT","callback_url":"https://your.host/tiktok/webhook"}'
# and the same with "event_type":"DIRECT_MESSAGE" if you have Business Messaging
```

`ingest()` returns the HTTP status you must respond with: `200` when it accepts it (also when the event is ignored), `400` when the body is not raw or not JSON, and `403` when the signature is invalid, missing or outside the window. TikTok retries for 72 h on any non-200 response, so respond fast; handlers run in the background.

## Configuration

| Field | Default | Description |
|---|---|---|
| `accessToken` | required | Account token (`Access-Token` header). Accepts a `string` or `() => string \| Promise<string>`, because account tokens expire after 24 h and refreshing is up to you. |
| `businessId` | required | Account `open_id`, sent as `business_id`. Webhooks from other accounts authorized in the same app are ignored. |
| `appSecret` | required* | App secret; verifies `TikTok-Signature`. |
| `allowUnsignedWebhooks` | `false` | Isolated local development: accepts unsigned webhooks. |
| `signatureToleranceSec` | `300` | Anti-replay window (maximum difference between `t` and the local clock). |
| `selfUniqueIdentifier` | — | The account's own `unique_identifier`. **Required to receive comments**: its comments (including bot replies seen by another instance or after a restart) arrive with `fromMe: true` and are not dispatched. Without it, comment webhooks are ignored; DMs work the same. |
| `apiBaseUrl` / `apiVersion` | `https://business-api.tiktok.com/open_api` / `v1.3` | API endpoint. |
| `http` | — | `secureFetch` options (`timeoutMs`, `maxBytes`, `resolver`, `fetch`…). |
| `logger` / `debug` | pino `error` | pino-compatible logger. |

## Chat model and identity

- **`senderId` = `unique_identifier`**, TikTok's global identifier, which stays the same across APIs. The same person has the same `senderId` in comments and DMs.
- Chat ids are opaque to the core. The provider builds them like this:
  - `dm:<conversation_id>`: DM conversation (`kind: 'dm'`).
  - `comment:<video_id>:<comment_id>`: thread of a top-level comment (`kind: 'group'`, `isGroup: true`). Replies to a comment land in its `parent_comment_id` thread, and conversations are per participant.
  - `hic:<comment_id>`: high-intent comment (reply by DM).
    TikTok allows **one** direct reply per comment. After sending it, the provider links the `hic:` chat to the DM conversation that opens (learned from the API response, the `im_send_msg` echo or the comment author's first DM). While there is activity in the following 48 h, that conversation's DMs arrive in the same `hic:` chat, so a flow started from the comment (`.ask()`, `choose()`) receives the answer. Later sends to `hic:` go to the conversation (text, images, buttons). A second send before the conversation is known fails with `RecipientUnreachableError`. The link lives in memory: after a restart, DMs arrive at `dm:<conversation_id>`.
- `ctx.chat.platformData.surface` is `'comment'`, `'dm'` or `'high-intent-comment'`. With `scope: 'dm'` / `scope: 'group'` in a trigger you separate DMs from comments.
- TikTok comment ids are 64-bit integers that arrive as JSON numbers. They are parsed **losslessly** (`parseJsonLossless`) and treated as strings.

## What it supports

| Content | DM | Comment | High intent |
|---|---|---|---|
| `text` | ✅ (≤ 6000 characters; `ctx.quote()` quotes the message) | ✅ (≤ 150 characters) | ✅ (the first send is the direct reply; later ones go to the linked DM, with everything from the DM column) |
| `image` | ✅ (Buffer, `{path}` and URL are uploaded with `/business/message/media/upload/`; `{ native: { mediaId } }` reuses an existing `media_id`) | ❌ | ❌ |
| `buttons` | ✅ `QA_BUTTON_CARD` (1 to 3, titles ≤ 20) or `QA_LINK_CARD` (titles ≤ 40); question ≤ 40. When it does not fit (more than 3, URL buttons, longer texts), numbered text menu | ✅ numbered text menu (≤ 150 characters) | ✅ numbered text menu in the direct reply |
| `list` | ✅ `QA_LINK_CARD` when there are at most 3 rows in total; more become a numbered text menu | ✅ numbered text menu (≤ 150 characters) | ✅ numbered text menu in the direct reply |
| `native` (`provider: 'tiktok'`) | ✅ (merged into the `message/send` body, e.g. `SHARE_POST`) | ✅ (merged into `reply/create`, e.g. `image_uri`) | ❌ |
| Everything else (`audio`, `video`, `document`, `location`, `poll`, `reaction`…) | `UnsupportedContentError` | `UnsupportedContentError` | `UnsupportedContentError` |

Inbound (DM): text, image and video (`ctx.media` with `downloadMedia` through `/business/message/media/download/`), stickers, shared posts (`type: 'unknown'`, with the embed URL in `body`), quoted messages (`ctx.quoted`), reactions (`reaction` events) and Q&A card clicks (`button` interaction with `data` equal to the button `id`). `im_send_msg` is emitted as a `sent` status.

Actions: `typing()` sends `SENDER_ACTION TYPING`, which disappears after 5 s. `markRead()` sends `MARK_READ` per conversation. On comments both are no-ops.

## Limits (imposed by TikTok)

- **You cannot start a conversation**: you only reply to users who wrote first.
- **48 h window** in conversations without mutual follow: up to 10 messages in the 48 h after the user's first message; unlimited for 48 h after each of their replies, and at most 3 outside the window. Rejections map to `OutsideSessionWindowError`.
- **EEA, Switzerland and the United Kingdom**: TikTok does not deliver the content. The `im_receive_msg_eu` event is discarded.
- `comment.update` arrives **up to 5 minutes late** and carries no author name or username. Only `comment_action: 'insert'` is processed; deletions, hides and visibility changes are ignored.
- Replies the bot itself sends generate their own `comment.update`. The loop protection is the author: with `selfUniqueIdentifier`, every comment from the account arrives as `fromMe: true` (works after a restart and across instances). In addition, the process remembers the `comment_id`s it created and does not re-emit them. Without `selfUniqueIdentifier`, comments are discarded.
- API calls **do not follow redirects**: the token goes in the `Access-Token` header, which a cross-origin redirect would carry along. A 3xx response fails with `TikTokApiError`.
- Images in DMs only work where TikTok allows attachments; check with `/business/message/capabilities/get/`.

## Typed errors

| Situation | Error |
|---|---|
| HTTP 429 or `code` 40016 / 40100 / 40132 / 40133 | `RateLimitedError` (honours `Retry-After`) |
| Message window or quota | `OutsideSessionWindowError` |
| `code` 40007 (conversation or comment does not exist), or invalid chat id | `RecipientUnreachableError` |
| Text over the limit, also a degraded menu (checked before calling the API) | `PayloadTooLargeError` |
| Unsupported content type | `UnsupportedContentError` |
| Any other `code` ≠ 0 or non-2xx HTTP | `TikTokApiError` (`code`, `requestId`, `httpStatus`) |
