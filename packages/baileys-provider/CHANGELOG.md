# @bot-wa/baileys

## 0.2.0-alpha.0

### Minor Changes

- 0a2291f: `BaileysProviderConfig.logger` takes any core `LoggerLike` (pino, `console` or a `{ debug, info, warn, error }` object), not only pino's `Logger`. Baileys' own functions receive a `BaileysLogger` through the new `toBaileysLogger()`: a pino-shaped logger passes through untouched; anything else is wrapped (`trace` forwarded when present, else a no-op; `level` falls back to `'info'`; `child()` wraps `logger.child()` when available). Also exported: `isBaileysLogger()` and the `BaileysLogger` type.
- 31fcc2e: - New `pollStore` option (`PollStore` / `StoredPoll` types): persist polls so their votes can still be decrypted after a restart. The in-memory cache of 500 polls stays in front of it; a failing store is logged and never breaks a send or receive. The stored entry holds the poll secret, so treat it like the session folder.
  - `ctx.quoted.senderId` is canonical (LID → PN when known), like mentions, so `ctx.quoted?.senderId === provider.selfId` detects a reply to a bot message.
  - Messages of ignored chats (status, broadcast lists, newsletters) no longer take room in the 2000-message resend cache.
- 522bcca: - Pin `@whiskeysockets/baileys` to `7.0.0-rc14`.
  - Decrypt poll votes and emit the `poll` event with the aggregated tally; votes are bound to their poll's chat and creator and counted once.
  - Canonical (LID → PN) ids on reactions, poll votes, group, call and presence events, inbound mentions and `selfId`; calls go through the same identity canonicalisation as messages and group calls carry `chatId`/`isGroup`.
  - Leave the `browser` identity unset by default (Baileys' own macOS/Chrome), warn on custom tuples.
  - Fix: reactions report the reactor, not the message author; device-qualified PNs from `getPNForLID` are normalised; errors log under pino's `err` key; `RateLimiterTimeout` maps to `RateLimitedError`; sent messages answer resend requests.
- 147163f: Security: outbound `{ url }` / `https://…` media is now downloaded by the provider through `@bot-wa/http` (every redirect hop vetted, private and link-local hosts refused, socket pinned to the vetted address, 64 MiB and 60 s caps) and sent to Baileys as a Buffer. Baileys' own `fetch` followed redirects blindly, so a public URL redirecting to an internal address was an SSRF. New `remoteMedia` option (`maxBytes`, `timeoutMs`, `allowHttp`, `maxRedirects`, `resolver`, `fetch`); `remoteMedia.allowPrivateHosts: true` restores the previous pass-through. An unsafe or failing URL rejects with `UnsupportedContentError`, an oversized one with `PayloadTooLargeError`.
- 9b97391: Inbound locations fill the normalized `InboundMessage.location` (`ctx.sharedLocation`): Baileys `locationMessage` and `liveLocationMessage` (`live: true`; a live location's body is now its caption), Cloud API `location`, Telegram `location` (live when `live_period` is set) and `venue` (its title becomes the body; new `TelegramVenue` type).
- f25b2af: Durable media references, so a replayed inbound message can still download its media. `IProvider` gains two optional hooks: `serializeMediaRef(ref)` returns a JSON-safe, versioned `{ v, data }` (or `undefined`), and `rehydrateMediaRef(stored, ref)` rebuilds the `MediaRef`. With `BotConfig.durability` on, the inbox journals that reference instead of the live media token. A replay (crash recovery, background retry, operator `replayInbound`) rebuilds it inside the chat's turn, so per-chat order is kept. When the media cannot be rebuilt, the message still runs and only its download fails: `loadMediaOf(ctx, { throwOnError: true })` rejects with the new `MediaUnavailableError` (a `ProviderError` whose `reason` is `'not-durable'`, `'provider-mismatch'` or `'rehydrate-failed'`). `durability.inbox.mediaRefs: false` keeps the previous encoding. A provider without the hooks, and records written before this change, behave exactly as before. New exports: `MediaUnavailableError` and the `SerializedMediaRef` and `MediaUnavailableReason` types.
  
  The providers implement the hooks. Baileys journals only the media content (CDN url, direct path, media key and hashes; no thumbnail, caption or quoted context) plus the message key that re-upload requests need. It skips view-once media unless `durableMedia: { viewOnce: true }` is set, and it returns the cached original message while it is still in memory. Cloud API journals the media id and Telegram the `file_id`. None of them journals credentials, and each validates the stored value when it reads it back.

### Patch Changes

- 397c2be: Export types referenced by public signatures: `WAMediaUpload` and `DisconnectAction` (`@bot-wa/baileys`, whose `ChatId`/`UserId` are now core's), `GraphClientConfig` (`@bot-wa/meta`), and `TelegramMessageEntity`, `TelegramPhotoSize`, `TelegramLocation`, `TelegramContact`, `TelegramPoll` (`@bot-wa/telegram`).
- 7e09c69: - Wrapped messages (disappearing mode, view once, document with caption) are unwrapped before classification, so they arrive with their real `type`, `body` and `media` instead of `'unknown'`.
  - Reply context and mentions are read from image, video and document captions too, not only from text messages; `quoted.ref` now points at the quoted message (a WAMessage-shaped `native`, usable as `quoted` to reply in thread), and a quoted media caption fills `quoted.body`.
  - `timestamp` is always a plain number (protobuf `Long` timestamps were passed through as objects); location and contact messages get a readable `body`; template button replies map to `type: 'buttons'`.
  - `stop()` cancels a pending reconnect, so a later `start()` no longer races a stale backoff timer into a second socket.
  - `downloadMedia()` rejects with a `ProviderError` when disconnected or when the download fails (was a `TypeError` / raw Baileys error); `markRead()` and `deleteMessage()` accept refs without a native key (rebuilt from `chatId` + `id`), and `deleteMessage()` rejects when disconnected instead of silently doing nothing.
- 99251ef: Declare `capabilities.exclusiveSession` (Baileys always, Telegram in long-polling mode), so with multi-replica coordination only the elected replica connects the session.
- 7b00477: `@bot-wa/core`: new optional `ProviderCapabilities.textFormat` (`TextFormat`: `'whatsapp' | 'markdown' | 'html' | 'plain'`), the rich-text dialect a channel renders, so Markdown producers (e.g. `@bot-wa/ai`) can convert their text. `MockProvider` accepts `textFormat`.
  
  `@bot-wa/baileys` and `@bot-wa/meta` declare `textFormat: 'whatsapp'`; `@bot-wa/telegram` declares `'plain'` (text is sent without `parse_mode`).
- 4d95812: `create-bot-wa` stamps `@bot-wa/*` dependency ranges derived at build time from each public package's current version (`^<exact version>`, e.g. `^2.0.0-alpha.2` or `^0.1.1-alpha.0`), instead of hand-written constants like `^0.1.0` that npm does not resolve to a prerelease — freshly scaffolded projects install while the packages are on the `alpha` line. The `@bot-wa/baileys` README links its example on GitHub (the relative link broke on npmjs.com).
- ce7790f: Packaging: dependencies between `@bot-wa/*` packages are published as caret ranges (`^x.y.z`, from `workspace:^`) instead of exact versions, so npm dedupes a single `@bot-wa/core` instead of installing a second copy when one package lags a patch behind. Published READMEs use absolute GitHub links (relative links broke on npmjs.com), and `@bot-wa/core`/`@bot-wa/http` gain `repository.directory`, `homepage` and `bugs` metadata.
- efb1fa6: Native streaming of long/AI replies with `ctx.stream(source, opts)`. The strategy comes from the new `ProviderCapabilities.streaming` field (`'draft' | 'edit' | 'none'`): native drafts (Telegram `sendMessageDraft`, with `can_stop`/`keep_on_stop`), throttled message edits (Discord, Telegram groups) or sentence chunks with typing (WhatsApp). Updates are throttled, cancellation is supported (`signal`, the user's stop button) and no message exceeds `maxTextLength`. New exports: `streamText`, `resolveStreamStrategy`, `splitMessage`, `findSplitPoint` and their types; `IProvider.sendDraft`; `MockProvider({ streaming })`. `@bot-wa/ai` gains `AIClient.streamReplyInChat()` and the `stream` option for the autoresponder. The Telegram long-poll now also asks for `stopped_message_generation` updates. Live edits and drafts run the `before('send')` hooks (payload `stream: 'draft' | 'edit'`) and the message log keeps the final edited text; rate-limited edits back off for `retryAfterMs`; `onCancel: 'discard'` deletes the live message when the transport can. The streamed autoreply honours refusals (`refusalMessage`, not stored), replies `errorMessage` on an empty answer and, with `onCancel: 'discard'`, keeps a cancelled answer out of the context.
- 4fc0560: Add native forms: `flow().form(definition, opts)` collects typed fields (text, number, email, date, select, multiselect, opt-in) with validation. Providers with the new `capabilities.forms: 'native'` receive an `OutboundContent` of kind `'form'` and reply with `'form'` inbound messages (`formReplyBody()` / `parseFormReply()`); every other provider gets field-by-field questions. `describe()` draws `form` nodes and `lint()` checks their timeouts and `c.state` key collisions. `@bot-wa/meta` renders forms as static WhatsApp Flows (`toFlowJson`, `toFlowMessage`, `publishForm()`, `config.flows`) and turns `nfm_reply` webhooks into form replies. Other providers reject the `form` kind with `UnsupportedContentError`. The new optional `IProvider.canRenderForm(form, { nativeId })` (exposed as `ctx.canRenderForm()`) lets a native provider say it has no native form for a definition; `CloudAPIProvider` implements it, so a form without a mapped Flow is asked field by field without first sending (and failing) a form message. Ambiguous grouped numbers (`1.500`, `1,500`) are rejected instead of being read as 1.5.
- Updated dependencies [2e16743]
- Updated dependencies [397c2be]
- Updated dependencies [0a2291f]
- Updated dependencies [ddfb1e9]
- Updated dependencies [ee5777c]
- Updated dependencies [522bcca]
- Updated dependencies [588fa34]
- Updated dependencies [a33cb08]
- Updated dependencies [909fa96]
- Updated dependencies [9cb6621]
- Updated dependencies [99251ef]
- Updated dependencies [7cc66b2]
- Updated dependencies [39a8149]
- Updated dependencies [31fcc2e]
- Updated dependencies [40fdab4]
- Updated dependencies [4bbd0ad]
- Updated dependencies [f8c1d4f]
- Updated dependencies [231cbd2]
- Updated dependencies [ca25eb7]
- Updated dependencies [18958c6]
- Updated dependencies [40ec0bd]
- Updated dependencies [fd07c8c]
- Updated dependencies [0149d66]
- Updated dependencies [9c94d93]
- Updated dependencies [08a933f]
- Updated dependencies [1a81406]
- Updated dependencies [64fb59f]
- Updated dependencies [2549ffe]
- Updated dependencies [a4e9429]
- Updated dependencies [310db8d]
- Updated dependencies [2bab262]
- Updated dependencies [6ea4442]
- Updated dependencies [136caa5]
- Updated dependencies [634993f]
- Updated dependencies [b866fbd]
- Updated dependencies [c6a4292]
- Updated dependencies [7b00477]
- Updated dependencies [6504335]
- Updated dependencies [ce42173]
- Updated dependencies [1984f6f]
- Updated dependencies [522bcca]
- Updated dependencies [02a21cc]
- Updated dependencies [23371fb]
- Updated dependencies [9b97391]
- Updated dependencies [f25b2af]
- Updated dependencies [2232f88]
- Updated dependencies [c5f5090]
- Updated dependencies [1af5d4c]
- Updated dependencies [9ec06c8]
- Updated dependencies [27620ef]
- Updated dependencies [e4574e6]
- Updated dependencies [ce7790f]
- Updated dependencies [b95b523]
- Updated dependencies [5196990]
- Updated dependencies [2c4f9f0]
- Updated dependencies [efb1fa6]
- Updated dependencies [f8c1d4f]
- Updated dependencies [4fc0560]
  - @bot-wa/core@2.0.0-alpha.2
  - @bot-wa/http@0.2.0-alpha.0
