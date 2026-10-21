# @bot-wa/meta

## 0.2.0-alpha.0

### Minor Changes

- 0a2291f: `CloudAPIProviderConfig.logger` takes any core `LoggerLike` (pino, `console` or a `{ debug, info, warn, error }` object), not only pino's `Logger`.
- 9b97391: Inbound locations fill the normalized `InboundMessage.location` (`ctx.sharedLocation`): Baileys `locationMessage` and `liveLocationMessage` (`live: true`; a live location's body is now its caption), Cloud API `location`, Telegram `location` (live when `live_period` is set) and `venue` (its title becomes the body; new `TelegramVenue` type).
- f25b2af: Durable media references, so a replayed inbound message can still download its media. `IProvider` gains two optional hooks: `serializeMediaRef(ref)` returns a JSON-safe, versioned `{ v, data }` (or `undefined`), and `rehydrateMediaRef(stored, ref)` rebuilds the `MediaRef`. With `BotConfig.durability` on, the inbox journals that reference instead of the live media token. A replay (crash recovery, background retry, operator `replayInbound`) rebuilds it inside the chat's turn, so per-chat order is kept. When the media cannot be rebuilt, the message still runs and only its download fails: `loadMediaOf(ctx, { throwOnError: true })` rejects with the new `MediaUnavailableError` (a `ProviderError` whose `reason` is `'not-durable'`, `'provider-mismatch'` or `'rehydrate-failed'`). `durability.inbox.mediaRefs: false` keeps the previous encoding. A provider without the hooks, and records written before this change, behave exactly as before. New exports: `MediaUnavailableError` and the `SerializedMediaRef` and `MediaUnavailableReason` types.
  
  The providers implement the hooks. Baileys journals only the media content (CDN url, direct path, media key and hashes; no thumbnail, caption or quoted context) plus the message key that re-upload requests need. It skips view-once media unless `durableMedia: { viewOnce: true }` is set, and it returns the cached original message while it is still in memory. Cloud API journals the media id and Telegram the `file_id`. None of them journals credentials, and each validates the stored value when it reads it back.
- 2232f88: Native form labels follow the user's language. `ctx.form()` / `flow().form()` fill a missing `cta`, `submitLabel` and (without `intro`/`title`) body from the new `core.form.cta`, `core.form.submit` and `core.form.body` catalog entries (`es`/`en`) in `ctx.lang`, through the exported `withFormDefaults()`. `@bot-wa/meta` no longer hard-codes Spanish: its fallbacks use the same catalog and `toFlowJson(def, { lang })` (also `publishForm(def, { flowJson: { lang } })`) picks the language of the published Flow's default submit label (default `'es'`, unchanged).
- 522bcca: Support WhatsApp usernames / BSUIDs: parse every business-scoped user id field, keep one stable id per person (phone when known, else BSUID), learn phone ↔ BSUID pairs through a pluggable `identityMap` (`MemoryIdentityMap`), send to BSUIDs via `recipient`, expose `isBsuid()`, and drop events without usable ids instead of emitting `undefined` ids.
- 27620ef: Add a WhatsApp Cloud API 24 h customer-service window manager (`sessionWindow` option, `SessionWindowManager`, pluggable `SessionWindowStore`): reopen closed chats with an approved template and retry the original send when the user replies. Status events now carry the normalized `pricing`/`conversation` objects in `DeliveryStatus.platformData` (new optional field in core), and `provider.usage` aggregates per-chat/per-category usage and estimated cost. Window state is scoped per business number (`phoneNumberId`; shared managers via `forScope()`), and media is uploaded once before queueing so retries never re-read a drained stream or keep media bytes in memory.
- 4fc0560: Add native forms: `flow().form(definition, opts)` collects typed fields (text, number, email, date, select, multiselect, opt-in) with validation. Providers with the new `capabilities.forms: 'native'` receive an `OutboundContent` of kind `'form'` and reply with `'form'` inbound messages (`formReplyBody()` / `parseFormReply()`); every other provider gets field-by-field questions. `describe()` draws `form` nodes and `lint()` checks their timeouts and `c.state` key collisions. `@bot-wa/meta` renders forms as static WhatsApp Flows (`toFlowJson`, `toFlowMessage`, `publishForm()`, `config.flows`) and turns `nfm_reply` webhooks into form replies. Other providers reject the `form` kind with `UnsupportedContentError`. The new optional `IProvider.canRenderForm(form, { nativeId })` (exposed as `ctx.canRenderForm()`) lets a native provider say it has no native form for a definition; `CloudAPIProvider` implements it, so a form without a mapped Flow is asked field by field without first sending (and failing) a form message. Ambiguous grouped numbers (`1.500`, `1,500`) are rejected instead of being read as 1.5.

### Patch Changes

- 397c2be: Export types referenced by public signatures: `WAMediaUpload` and `DisconnectAction` (`@bot-wa/baileys`, whose `ChatId`/`UserId` are now core's), `GraphClientConfig` (`@bot-wa/meta`), and `TelegramMessageEntity`, `TelegramPhotoSize`, `TelegramLocation`, `TelegramContact`, `TelegramPoll` (`@bot-wa/telegram`).
- 7b00477: `@bot-wa/core`: new optional `ProviderCapabilities.textFormat` (`TextFormat`: `'whatsapp' | 'markdown' | 'html' | 'plain'`), the rich-text dialect a channel renders, so Markdown producers (e.g. `@bot-wa/ai`) can convert their text. `MockProvider` accepts `textFormat`.
  
  `@bot-wa/baileys` and `@bot-wa/meta` declare `textFormat: 'whatsapp'`; `@bot-wa/telegram` declares `'plain'` (text is sent without `parse_mode`).
- 1cc2146: A send rejected with `131051` (unsupported message type) or `131062` (BSUID recipient not supported) now reports the kind that was actually sent in `UnsupportedContentError.kind`, instead of the generic `'native'` / `'template'` fallback. `GraphClient.sendMessage` takes the content kind as an optional third argument.
- aa70898: Deprecate the unused `GraphErrorBody` type export (Graph responses go through `readGraphResponse()` from `@bot-wa/graph-core`); `GraphSendMessageResponse['error']` keeps the same shape.
- 7d00f20: - `ingest()` answers `400` for a body that is not a JSON object instead of throwing.
  - Template quick-reply buttons (`type: 'button'`) arrive as `button` interactions carrying the button `payload` (they were `unknown` messages with an empty body).
  - Replies expose the quoted message as `quoted.ref` (its `wamid`).
  - Statuses other than `sent` / `delivered` / `read` / `failed` (e.g. `deleted`, `warning`) are dropped instead of being reported as `failed`, which also kept them from triggering session-window fallbacks.
  - Location and contact messages get a readable `body`.
  - Buffer / stream / path media are uploaded with a real MIME type (document `mimetype`, file extension, magic bytes, then a per-kind default) instead of `application/octet-stream`, which the Cloud API rejects for images, audio, video and stickers; documents keep their `filename` in the upload.
  - Requests that never get a response (DNS, TLS, reset) reject with a `ProviderError`, including the media CDN download, where an SSRF refusal or timeout is a `ProviderError` and an oversized file a `PayloadTooLargeError`.
- ce7790f: Packaging: dependencies between `@bot-wa/*` packages are published as caret ranges (`^x.y.z`, from `workspace:^`) instead of exact versions, so npm dedupes a single `@bot-wa/core` instead of installing a second copy when one package lags a patch behind. Published READMEs use absolute GitHub links (relative links broke on npmjs.com), and `@bot-wa/core`/`@bot-wa/http` gain `repository.directory`, `homepage` and `bugs` metadata.
- efb1fa6: Native streaming of long/AI replies with `ctx.stream(source, opts)`. The strategy comes from the new `ProviderCapabilities.streaming` field (`'draft' | 'edit' | 'none'`): native drafts (Telegram `sendMessageDraft`, with `can_stop`/`keep_on_stop`), throttled message edits (Discord, Telegram groups) or sentence chunks with typing (WhatsApp). Updates are throttled, cancellation is supported (`signal`, the user's stop button) and no message exceeds `maxTextLength`. New exports: `streamText`, `resolveStreamStrategy`, `splitMessage`, `findSplitPoint` and their types; `IProvider.sendDraft`; `MockProvider({ streaming })`. `@bot-wa/ai` gains `AIClient.streamReplyInChat()` and the `stream` option for the autoresponder. The Telegram long-poll now also asks for `stopped_message_generation` updates. Live edits and drafts run the `before('send')` hooks (payload `stream: 'draft' | 'edit'`) and the message log keeps the final edited text; rate-limited edits back off for `retryAfterMs`; `onCancel: 'discard'` deletes the live message when the transport can. The streamed autoreply honours refusals (`refusalMessage`, not stored), replies `errorMessage` on an empty answer and, with `onCancel: 'discard'`, keeps a cancelled answer out of the context.
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
- Updated dependencies [522bcca]
- Updated dependencies [9ec06c8]
- Updated dependencies [8854c8e]
- Updated dependencies [b0034aa]
- Updated dependencies [1cc2146]
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
  - @bot-wa/graph-core@0.2.0-alpha.0
  - @bot-wa/http@0.2.0-alpha.0
