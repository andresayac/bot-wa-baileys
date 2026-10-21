# Security

What the framework verifies for you on each untrusted surface, what you still
have to configure, and the risks that remain. The section below is the result
of the October 2026 audit of the newer surfaces (webhook ingress, the manager
REST API, the newer channels and plugins). To report a vulnerability, follow
[`SECURITY.md`](https://github.com/andresayac/botmesh/blob/main/SECURITY.md).

## Security audit (2026-10)

**Scope:** `@botmesh/server`, `twilio`, `gohighlevel`, `gupshup`, `evolution`,
`wppconnect`, `email`, `tiktok`, `chatwoot`, `voice`, `rag`, `manager` (`/v1`
REST and the older `createManagerApi`), `dialogflow`, `moderation`, the webhook
paths of `meta`/`messenger`/`instagram` (`@botmesh/graph-core`) and `telegram`,
plus the shared HTTP client `@botmesh/http`.

Every issue fixed during the audit has a regression test (look for
`security-audit` in the package tests).

### Webhook authentication

| Channel | Mechanism | Raw bytes | Constant time | Replay window |
| --- | --- | --- | --- | --- |
| Meta (Cloud API, Messenger, Instagram) | `X-Hub-Signature-256` HMAC-SHA256 with `appSecret`; `GET` handshake with `verifyToken` | yes (a parsed body is rejected) | yes (handshake token too) | Meta sends no signed timestamp — dedupe by message id |
| Telegram | `X-Telegram-Bot-Api-Secret-Token` (`webhookSecret`) | n/a (shared secret) | yes | none from the platform |
| Twilio | `X-Twilio-Signature` HMAC-SHA1 over the exact URL + sorted params; JSON bodies through `bodySHA256` | yes | yes | none from the platform |
| TikTok | `TikTok-Signature: t=…,s=…` HMAC-SHA256 over `t.rawBody` | yes | yes | **yes**, ±300 s (`signatureToleranceSec`) |
| HighLevel | `X-GHL-Signature` Ed25519 (legacy RSA `X-WH-Signature` only when you configure its key) | yes | n/a (signature verify) | none enforced; see residual risks |
| Gupshup, WPPConnect | shared token in the callback URL or a header (they do not sign) | n/a | yes | none |
| Evolution | shared header secret or HS256 JWT (`exp` required, ±30 s skew) | n/a | yes | JWT `exp` |
| Chatwoot | shared token and/or HMAC-SHA256 (`x-chatwoot-signature`, optional `x-chatwoot-timestamp` ±300 s) | yes | yes | only when the timestamp header is sent |

Every provider refuses to start without credentials unless you set
`allowUnsignedWebhooks: true` (or `insecureNoWebhookAuth` in Chatwoot), and
then logs a warning. Inbound ids are deduplicated by the core (`chatId` +
message id), which also absorbs replays of an already-seen message while it
is in the dedupe window.

### Verified

- **Raw-body signatures.** Signatures are computed over the received bytes,
  never over re-serialized JSON. `@botmesh/server` reads the raw body itself
  and answers `500` if a body parser consumed it first.
- **Ingress limits** (`@botmesh/server`): body size (`413`, checked against
  `Content-Length` and while streaming), body and ingest timeouts (`408`/`503`),
  a concurrency cap (`503` + `Retry-After`), header-injection-safe response
  headers (CR/LF/NUL rejected) and logs with metadata only (no bodies,
  no error messages that could quote a body).
- **Outbound SSRF.** Every fetch to a URL that comes from a webhook or a user
  (media downloads, attachments, STT/TTS, embeddings, Dialogflow) goes through
  `secureFetch`: HTTPS only by default, no credentials in the URL, DNS answers
  checked against private ranges and the socket pinned to the checked IP
  (no DNS rebinding), every redirect re-validated, timeouts and size limits.
  Rejections are a `SecureHttpError` whose `code` says why: `INVALID_URL`,
  `INVALID_OPTIONS`, `UNSAFE_URL`, `UNSAFE_HOST`, `TIMEOUT`,
  `RESPONSE_TOO_LARGE`, `TOO_MANY_REDIRECTS`, or `HTTP_STATUS` (a non-2xx from
  `fetchBuffer`, with the code in `error.status`).
- **Manager REST `/v1`.** Mandatory tokens (≥ 16 chars, compared as SHA-256
  digests without early exit), per-route scopes, tenant isolation (other
  tenants' bots answer `404`), token-bucket rate limiting, `1 MiB` JSON body
  limit, `415` for non-JSON, allowlisted fields, length-capped strings,
  secrets redacted from echoed config and generic `500` messages. Bot and
  tenant ids are restricted to `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}` (no `..`)
  before they become file names.
- **JSON flow expressions.** A recursive-descent parser: no `eval`/`Function`,
  no regexes, whitelisted functions only, `__proto__`/`prototype`/`constructor`
  rejected, own-property paths only, at most 1000 chars / 256 tokens / depth 32.
  Templates (`{{ path }}`) only resolve paths.
- **Email.** Native `headers` must be single-line and cannot override the
  provider's own (`From`, `To`, `Message-ID`, loop protection...); native
  attachments must be in memory (no `path`/`href` that nodemailer would read
  or fetch itself).
- **RAG loaders** read only operator-given paths, skip symlinks and dotfiles
  while walking directories and cap each file (20 MiB).
- **Logging.** Grepped every `logger.*` call in the audited packages: no tokens,
  QR payloads, message bodies or addresses; errors are logged by class or by
  provider-reported reason.

### Fixed during the audit

- **`@botmesh/http`: IPv6 SSRF bypass.** `isPrivateAddress` did not understand
  IPv6 that embeds an IPv4: `https://[::ffff:7f00:1]/` (the form `URL`
  normalizes `::ffff:127.0.0.1` to), `::127.0.0.1`, NAT64 (`64:ff9b::/96`),
  6to4 (`2002::/16`) and Teredo reached internal addresses. It now expands
  IPv6 and judges the embedded IPv4; unparseable literals fail closed.
- **`@botmesh/http`: redirects.** Cross-origin hops now also drop
  credential-looking headers (`apikey`, `x-api-key`, `xi-api-key`,
  `x-auth-token`...), not only `Authorization`/`Cookie`; a `303` (and a
  `301`/`302` after `POST`) continues as a body-less `GET`, like `fetch`.
- **`@botmesh/manager`: SSRF through `send`.** `POST /v1/bots/{id}/send`
  accepted any `https` media URL, and transports such as Baileys download
  `{ url }` media themselves (outside `secureFetch`). Hosts that are or resolve
  to internal addresses are now rejected with `400`
  (`allowPrivateMediaHosts: true` to opt out, `mediaHostResolver` for tests).
- **`@botmesh/baileys`: SSRF through redirects.** Baileys downloaded `{ url }`
  media with plain `fetch`, which follows redirects without checking them, so a
  public URL answering `302` to `http://169.254.169.254/…` got past the REST
  host check. The provider now downloads remote media itself through
  `@botmesh/http` (every hop vetted, socket pinned to the vetted address, 64 MiB
  and 60 s caps) and hands Baileys a Buffer. Tune it with `remoteMedia`
  (`maxBytes`, `timeoutMs`, `allowHttp`); `remoteMedia.allowPrivateHosts: true`
  restores the old pass-through for media served from your own network.
- **`@botmesh/manager`: error leak.** The older `createManagerApi` returned the
  error message on `500`; it now answers `"start failed"`/`"stop failed"` and
  hands the error to `onError`.
- **`@botmesh/graph-core`: verify token.** The `GET` handshake compared the
  token with `===` and accepted an empty configured token; now constant-time,
  non-empty and string-only.
- **`@botmesh/email`: header injection.** Subjects and display names decoded
  from RFC 2047 could carry CR/LF into the reply's `Subject`/`To`; they are
  collapsed to one line. Native `cc`/`bcc` must be plain addresses.
- **`@botmesh/gohighlevel`: cross-location replay.** HighLevel signs every
  app's webhooks with one platform key, so a body signed for another location
  verified here too; events without (or with another) `locationId` are ignored.
- **`@botmesh/chatwoot`: agent attachments.** Only absolute `http(s)` URLs are
  forwarded (Baileys reads any other `{ url }` from the local disk), file names
  lose path separators and a malformed `%` no longer drops the whole message.
- **`@botmesh/moderation`: quadratic link scan.** `findLinks` compared every bare
  invite with every link (≈2.5 s on a 200 KB message); it is linear now.

### Residual risks

- **No platform replay window** for Meta, Telegram, Twilio, HighLevel, Gupshup
  and WPPConnect: they sign no timestamp (or HighLevel's is not enforced, since
  its retries may reuse it). A captured, valid request can be replayed; the
  core's id dedupe only covers its in-memory window. Keep webhook endpoints on
  HTTPS so requests cannot be captured.
- **Tokens in URLs** (Gupshup, WPPConnect, Chatwoot `?token=`) end up in
  reverse-proxy and access logs. Prefer the header form where the platform
  allows it, and scrub query strings from your logs.
- **Twilio URL reconstruction.** Without `webhookUrl`, the signed URL is
  rebuilt from `X-Forwarded-Host`/`Host`. Set `webhookUrl` (or use
  `ingestRequest` with the exact URL) behind proxies you do not control.
- **Operator-written regexes.** `moderation` word filters and invite patterns
  accept `RegExp`s and run them on every message: a catastrophic-backtracking
  pattern is a ReDoS. Use plain strings, or linear patterns only.
- **String media sources are local paths.** In `ctx.send`/`bot.sendTo`, a
  string or `{ path }` media source is read from disk, and Baileys reads a
  non-`http` `{ url }` from disk too. Never pass user-controlled text as a media
  source; the REST API and Chatwoot already restrict it to `http(s)` URLs.
- **Transports that fetch by themselves.** Evolution and WPPConnect pass
  `{ url }` media to their own server, which downloads it (and follows
  redirects) from its network; Cloud API, Messenger, Instagram, Twilio, Gupshup
  and HighLevel hand the link to the platform. The REST API vets the first host,
  but a redirect is resolved by that other server, outside `secureFetch`. Host
  those servers where an internal redirect target is unreachable, or send
  Buffers. Baileys is covered (it downloads through `@botmesh/http`) unless you
  set `remoteMedia.allowPrivateHosts: true`.
- **In-memory state grows with contacts**: LID/PN identity maps (Evolution,
  WPPConnect, Baileys), moderation warning counters and the email suppression
  list are not capped. Other per-chat maps are bounded.
- **Upstream error text.** STT/TTS/Dialogflow errors include the provider's
  short error message (≤ 200 chars); providers mask keys there, but it is
  third-party text.
- **Legacy `createManagerApi`** is unauthenticated unless you pass `auth`
  (it warns once). Prefer `createRestApi`.
- **Windows device names.** Bot ids like `con` or `nul` pass the id pattern;
  avoid them if you persist bots on Windows.
