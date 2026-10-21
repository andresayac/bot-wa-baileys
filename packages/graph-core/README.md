# @bot-wa/graph-core

Shared **Meta Graph** helpers for the Meta transports of [`@bot-wa/core`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core):
[`@bot-wa/meta`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/meta-provider) (WhatsApp Cloud API), [`@bot-wa/messenger`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/messenger-provider) and
[`@bot-wa/instagram`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/instagram-provider). All three platforms verify the webhook the same way, sign the same way and
return the same Graph error codes; this package gathers that logic in one place so it is not
duplicated in every provider.

> **Internal package.** The providers use it; you do not need to import it to build a bot. It ships with the
> first alpha as a dependency of `@bot-wa/meta`, and it is not on npm yet.

## Installation

```bash
pnpm add @bot-wa/graph-core
```

No extra dependencies: only `@bot-wa/core` and Node ≥ 22's native `crypto`.

## What it includes

| Export | What it is for |
|---|---|
| `verifyChallenge(query, verifyToken)` | Webhook `GET` handshake. Returns the `hub.challenge` to answer (HTTP 200) or `null` when the token does not match (answer 403). |
| `verifySignature(rawBody, header, appSecret)` | Verifies `X-Hub-Signature-256` = HMAC-SHA256 of the body with the app secret, in constant time. `false` when the secret or header is missing, or they do not match. |
| `checkGraphSignature(body, headers, appSecret, logger?)` | Ingest guard: `{ ok: true }` or `{ ok: false, status }`. With an `appSecret` it requires the **raw** body (`string`/`Buffer`/`Uint8Array`) and rejects an already-parsed one with `400`; an invalid signature gives `403`. |
| `tryParseGraphBody<T>(body)` | Like `parseGraphBody`, but never throws: `{ ok: true, body }` or `{ ok: false, status: 400 }` when the body is not a JSON object. Use it in `ingest()` to answer 400 to a malformed body. |
| `parseGraphBody<T>(body)` | Turns the body (string, `Buffer`/`Uint8Array` or an already-parsed object) into `T`. Throws `SyntaxError` when the raw body is not JSON. |
| `toGraphError(err, { chatId?, retryAfterMs?, contentKind? })` | Translates a Graph error into the core's `ProviderError` subclasses. |

## Usage

This is how a provider uses it in its `ingest()`:

```ts
import { checkGraphSignature, tryParseGraphBody, verifyChallenge } from '@bot-wa/graph-core'

// GET /webhook: subscription handshake
const challenge = verifyChallenge(query, process.env.META_VERIFY_TOKEN!)
// challenge === null → 403

// POST /webhook: verify the signature and parse
const sig = checkGraphSignature(rawBody, headers, process.env.META_APP_SECRET, logger)
if (!sig.ok) return sig.status // 400 (body not raw) or 403 (invalid signature)
const parsed = tryParseGraphBody<MyWebhookBody>(rawBody)
if (!parsed.ok) return parsed.status // 400: not a JSON object
const payload = parsed.body
```

> **Signature over the raw bytes.** Meta signs exactly the bytes it sends. If you re-serialize the JSON
> (e.g. with `express.json()` without keeping the original body), the signature no longer matches. Always pass
> the raw body: `express.raw()`, or the `Buffer` you accumulate with `node:http`.

Without an `appSecret`, `checkGraphSignature` lets the request through. That is why the providers require an
`appSecret` and only accept omitting it with an explicit opt-in for local development
(`allowUnsignedWebhooks: true` on `CloudAPIProvider`).

## Error mapping

`toGraphError` covers both WhatsApp business codes and the generic Facebook/Instagram rate limits:

| Graph code | Core error |
|---|---|
| `131047`: outside the 24-hour window (WhatsApp) | `OutsideSessionWindowError` (send a template, `kind: 'template'`) |
| `131026`: recipient cannot receive | `RecipientUnreachableError` |
| `131030`: recipient outside the test number's allowed list (WhatsApp) | `RecipientUnreachableError` |
| `551`: the person is unavailable (Messenger/Instagram) | `RecipientUnreachableError` |
| `10` with subcode `2018278`: outside the messaging window (Messenger/Instagram) | `OutsideSessionWindowError` |
| `131051`: unsupported message type | `UnsupportedContentError` (`kind`: the send's `contentKind`, or `'native'`) |
| `131062`: the BSUID recipient does not accept this message (WhatsApp; *one-tap*, *zero-tap* and *copy code* authentication templates) | `UnsupportedContentError` (`kind`: the send's `contentKind`, or `'template'`); send it to the phone (`wa_id`) instead |
| `4`, `613`, `80007`, `36003`: rate limit | `RateLimitedError` (`retryAfterMs` or 60 s by default) |
| `130429`: Cloud API messages-per-second limit | `RateLimitedError` (`retryAfterMs` or 1 s) |
| `131056`: too many messages to the same user (*pair rate limit*) | `RateLimitedError` (`retryAfterMs` or 6 s) |
| `131048`: spam limit | `RateLimitedError` (`retryAfterMs` or 60 s) |
| anything else (including `147001`–`147005` from the username API) | `ProviderError` |

`contentKind` is the `kind` of the `OutboundContent` that failed. Pass it when you know it: that way
`UnsupportedContentError.kind` says which content Graph rejected instead of each code's default.

```ts
import { toGraphError } from '@bot-wa/graph-core'

const err = toGraphError({ code: 131047, message: 'Re-engagement message' }, { chatId })
// err instanceof OutsideSessionWindowError
```
