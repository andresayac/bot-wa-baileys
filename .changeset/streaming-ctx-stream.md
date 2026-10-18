---
"@bot-wa/core": minor
"@bot-wa/telegram": minor
"@bot-wa/baileys": patch
"@bot-wa/meta": patch
"@bot-wa/ai": minor
---

Native streaming of long/AI replies with `ctx.stream(source, opts)`. The strategy comes from the new `ProviderCapabilities.streaming` field (`'draft' | 'edit' | 'none'`): native drafts (Telegram `sendMessageDraft`, with `can_stop`/`keep_on_stop`), throttled message edits (Discord, Telegram groups) or sentence chunks with typing (WhatsApp). Updates are throttled, cancellation is supported (`signal`, the user's stop button) and no message exceeds `maxTextLength`. New exports: `streamText`, `resolveStreamStrategy`, `splitMessage`, `findSplitPoint` and their types; `IProvider.sendDraft`; `MockProvider({ streaming })`. `@bot-wa/ai` gains `AIClient.streamReplyInChat()` and the `stream` option for the autoresponder. The Telegram long-poll now also asks for `stopped_message_generation` updates. Live edits and drafts run the `before('send')` hooks (payload `stream: 'draft' | 'edit'`) and the message log keeps the final edited text; rate-limited edits back off for `retryAfterMs`; `onCancel: 'discard'` deletes the live message when the transport can. The streamed autoreply honours refusals (`refusalMessage`, not stored), replies `errorMessage` on an empty answer and, with `onCancel: 'discard'`, keeps a cancelled answer out of the context.
