# @botmesh/email

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: its API may change. Use it from this monorepo (`workspace:*`); the `pnpm add @botmesh/email` below will work once it is published.

**Email** transport for [`@botmesh/core`](../core): **IMAP IDLE** to receive (or `ingest()` with the raw MIME from an inbound-email webhook) and **SMTP** to reply. Each email thread is a chat, so flows (`flow().ask()...`) work exactly as on WhatsApp or Telegram: the customer replies to the email and the bot continues the conversation in the same thread.

## Install

```bash
pnpm add @botmesh/core @botmesh/email
pnpm add imapflow nodemailer   # optional peers: IMAP (inbound) and SMTP (outbound)
```

`imapflow` and `nodemailer` are **optional** `peerDependencies` loaded lazily: if you only send, you do not need `imapflow`; if you only receive through `ingest()`, you need neither to receive.

## Usage

```ts
import { Bot, flow } from '@botmesh/core'
import { EmailProvider } from '@botmesh/email'

const provider = new EmailProvider({
  address: 'support@acme.com',
  fromName: 'Acme Support',
  imap: { host: 'imap.gmail.com', port: 993, user: 'support@acme.com', pass: process.env.IMAP_PASS! },
  smtp: { host: 'smtp.gmail.com', port: 465, user: 'support@acme.com', pass: process.env.SMTP_PASS! },
})

const bot = new Bot({ provider })
bot.use(
  flow('quote')
    .ask('How many units do you need?', 'qty')
    .say((_ctx, c) => `Great, I am preparing the quote for ${c.state.qty} units.`),
)
await bot.start()
```

With Gmail or Microsoft 365 use an app password or OAuth2 (`accessToken` instead of `pass`).

## How email is mapped

| Concept | Email |
| --- | --- |
| `senderId` | Normalized `From` address (lowercase, no `<>`). The same person → the same id. |
| `chatId` (`thread` mode, the default) | `thread:<root Message-ID>`: one chat per thread, resolved through `In-Reply-To` / `References` (plus an index of the Message-IDs the bot sent, so it works even when the client trims `References`). The chat belongs to whoever opened the thread: if another address replies in it (a "reply all" or a forged `In-Reply-To`), it gets its own chat. |
| `chatId` (`sender` mode) | The sender address: one chat per person, like a DM. |
| `body` | New text of the reply: quoted history (`On … wrote:`, `El … escribió:`, Outlook blocks, `>`) and the signature (`-- `) are stripped. If the email only has HTML it is converted to text. If nothing is left, the subject is used. The full text is in `ctx.raw.text`. |
| Attachments | `ctx.raw.attachments` (all) and `media` (the first non-inline one); `type` becomes `image`/`video`/`audio`/`document`. `provider.downloadMedia(ref)` returns the bytes (in-memory cache and, if evicted, requested again over IMAP only when the UID still points to the same message). |
| Replies | `In-Reply-To`, `References`, `Re: <subject>` and the `From` recipient (or `Reply-To` when it is on the same domain; see `replyTo`). |
| `send('person@x.com', ...)` | Starts a new thread with that address (`platformData.subject` for the subject). |
| Buttons / lists / cards | Degrade to numbered text. `poll`, `reaction` and `template` throw `UnsupportedContentError`. |
| `native` | `{ kind: 'native', provider: 'email', payload: { subject, text, html, cc, bcc, headers, attachments } }`. Attachments only accept `{ filename, content: Buffer \| Uint8Array, contentType, cid }` (for files or URLs use `image`/`document`, which go through `secureFetch`); threading and loop-protection headers cannot be overridden. |

`options.platformData` in `send()` accepts `subject` and `html`.

## Loop protection

A bot that replies to emails ends up talking to another robot. By default:

- Automatic emails are not processed (RFC 3834): `Auto-Submitted` other than `no`, `List-Id`/`List-Unsubscribe`, `Precedence: bulk|junk|list`, `X-Autoreply`/`X-Autorespond`, `X-Auto-Response-Suppress`, `Return-Path: <>` and system senders (`mailer-daemon`, `postmaster`, `no-reply`).
- Emails from the bot itself are ignored.
- Per-sender cap: 30 messages per hour (`loopProtection.maxPerSender`).
- Everything the bot sends carries `Auto-Submitted: auto-replied` and `X-Auto-Response-Suppress: All` (disable with `autoSubmitted: false`).

```ts
new EmailProvider({ ..., loopProtection: { ignore: ['mailing-list'], maxPerSender: { max: 10, windowMs: 600_000 } } })
```

## Bounces

Non-delivery reports (DSN `multipart/report`, and "legacy" bounces with `X-Failed-Recipients`) **do not** reach handlers: they are emitted as a `status` event with `status: 'failed'`, the original email `ref`, `recipient` and `error: { code: '5.1.1', message }`. Permanently bounced addresses are suppressed: `send()` to them throws `RecipientUnreachableError` until `provider.unsuppress(address)` (`suppressBounced: false` disables it).

A bounce only counts when it refers to an email the **bot sent** (its Message-ID is in the outbound index) and the failed recipient is that thread's; legacy bounces must additionally come from `MAILER-DAEMON`/`postmaster`. That way nobody can block an address by sending a fake bounce.

## Security: the sender is not authenticated

Email does not authenticate `From`: anyone can write to the bot pretending to be another address. Therefore:

- A thread belongs to whoever opened it; another address replying in it gets its own chat and can neither see nor redirect the conversation.
- `Reply-To` only changes the recipient when it is on the same domain as `From` (`replyTo: 'always'` to always trust it, `'never'` to ignore it).
- With `requireAuthentication: { authservId: 'mx.your-domain.com' }` only emails with `dmarc=pass` (or `dkim=pass` aligned with the `From` domain) in an `Authentication-Results` header written by **your** MTA are accepted; the rest are ignored, because the sender can add whatever headers it wants. Everything else is discarded with `reason: 'unauthenticated'`.

Without `requireAuthentication`, treat `senderId` as a declared, unverified address: do not reveal a user's data (`ctx.user`, CRM) just because they write "from" their address. The per-sender cap can also be exhausted with forged senders.

## Persisting threads

Thread state (who to reply to, subject, `References` chain) lives in memory by default. To keep replying after a restart, store it in any store with cursors:

```ts
import { Bot } from '@botmesh/core'
import { SQLiteStore } from '@botmesh/sqlite-store'
import { cursorThreadStore, EmailProvider } from '@botmesh/email'

const store = new SQLiteStore({ file: './bot.db' })
const provider = new EmailProvider({ ..., threadStore: cursorThreadStore(store) })
const bot = new Bot({ provider, store })
```

`cursorThreadStore` also stores the mailbox **UID cursor** (`getMailboxCursor`/`setMailboxCursor`, optional in `EmailThreadStore`): after a restart the bot continues after the last UID it processed, so with `markSeen: false` it never delivers anything twice, and an email that arrived while the bot was stopped and that someone already read in their client is still processed. If the mailbox `UIDVALIDITY` changed, the cursor is invalid and the bot starts from `UIDNEXT`. With no stored cursor, `processExisting` applies. Across `stop()` and `start()` of the same instance the cursor is always kept.

## IMAP IDLE

The bot selects the mailbox and stays in IDLE: the server notifies every new email and the bot downloads it by UID. `imapflow` enters IDLE after a period without commands; the provider lowers it to 1 s (`autoIdleDelay: 1000`, the `imapflow` value is 15 s) so new email arrives right away. It can be changed with `imap.options.autoIdleDelay`.

## Inbound email webhook

Without IMAP, `ingest()` accepts the raw MIME (Buffer/string) from SES, Mailgun ("raw MIME"), a Postfix pipe, etc., and returns `{ status, accepted, reason? }` (`413` when it exceeds `maxInboundBytes`; also limit the body in your HTTP server):

```ts
app.post('/inbound-email', async (req, res) => {
  const result = await provider.ingest(req.rawBody)
  res.sendStatus(result.status)
})
```

## Typed errors

| SMTP | Error |
| --- | --- |
| 550/551/553, `5.1.x`, rejected recipient | `RecipientUnreachableError` |
| 552, `5.3.4`, attachments > `maxAttachmentBytes` (25 MiB) | `PayloadTooLargeError` |
| 4xx (421, 450, 451, 452) | `RateLimitedError` (`retryAfterMs` 60 s) |
| Authentication (`EAUTH`, 535) and the rest | `ProviderError` |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `address` | `smtp.user`/`imap.user` when they are addresses | Bot address (`From` and `selfId`). |
| `fromName` | — | Display name in `From`. |
| `imap` | — | `{ host, port=993, secure, user, pass \| accessToken, mailbox='INBOX', options }`. |
| `smtp` | — | `{ host, port=465, secure, user, pass \| accessToken, verify=false, options }`. |
| `threading` | `'thread'` | `'thread'` or `'sender'`. |
| `threadStore` | memory | `MemoryThreadStore` or `cursorThreadStore(store)`. |
| `processExisting` | `'unseen'` | On the first start (no stored UID cursor): process unread messages or start from now (`'none'`). |
| `markSeen` | `true` | Mark processed emails as read. |
| `stripQuotes` | `true` | Strip quoted history and signature from `body`. |
| `defaultSubject` | `'(no subject)'` | Subject for new threads without one. |
| `loopProtection` | enabled | `false` or `{ ignore, maxPerSender }`. |
| `autoSubmitted` | `'auto-replied'` | Outgoing `Auto-Submitted` value, or `false`. |
| `suppressBounced` | `true` | Reject sends to permanently bounced addresses. |
| `maxAttachmentBytes` | 25 MiB | Attachment limit per outgoing email. |
| `attachmentCacheBytes` | 32 MiB | Inbound attachment cache for `downloadMedia`. |
| `maxInboundBytes` | 40 MiB | Maximum size of an inbound email. Over IMAP it is discarded without downloading (and marked as read when `markSeen`); `ingest()` responds `413`. |
| `replyTo` | `'same-domain'` | When to reply to `Reply-To` instead of `From`: `'same-domain'`, `'always'` or `'never'`. |
| `requireAuthentication` | — | `{ authservId }`: accept only emails authenticated by your MTA (`Authentication-Results`). |
| `reconnect` | `{ baseMs: 1000, maxMs: 60000 }` | IMAP reconnection backoff. |
| `http` | — | `secureFetch` options for attachments by URL. |
| `createImapClient` / `smtpTransport` | — | Inject your own clients (or fakes in tests). |

## Integration tests

The `tests/*.test.ts` tests are hermetic: in-memory fake IMAP and SMTP. `tests/integration.test.ts` loads the real peers (`imapflow` and `nodemailer`, `devDependencies` of the package) and talks IMAP IDLE + SMTP to a real server, [GreenMail](https://greenmail-mail-test.github.io/greenmail/), in Docker. It is skipped unless you set `BOTWA_TEST_EMAIL`:

```bash
docker run -d --name botwa-it-greenmail \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
  -p 127.0.0.1:3025:3025 -p 127.0.0.1:3143:3143 greenmail/standalone:2.1.3

BOTWA_TEST_EMAIL=1 pnpm --filter @botmesh/email test

docker rm -f botwa-it-greenmail
```

In PowerShell: `$env:BOTWA_TEST_EMAIL = '1'`. The host and ports are changed with `BOTWA_TEST_EMAIL_HOST` (`127.0.0.1`), `BOTWA_TEST_EMAIL_SMTP_PORT` (`3025`) and `BOTWA_TEST_EMAIL_IMAP_PORT` (`3143`), the non-TLS GreenMail ports. With `greenmail.auth.disabled` any login works and mailboxes are created on the fly; each test uses fresh addresses, so it can be repeated against the same container.

What it covers: inbound over IMAP IDLE with stable `chatId`/`senderId`; threads by `Message-ID`/`In-Reply-To`/`References`; replies that reach the user's mailbox with `In-Reply-To`, `References`, `Re:` and `Auto-Submitted`; attachments as `MediaRef` and `downloadMedia` (from the cache and requested again over IMAP); HTML to text; discarding automatic replies, lists and `Precedence: bulk`; restarts without redelivering email (with `markSeen` and with the persisted UID cursor); and a `Bot` `ask()` flow answered by email.
