---
"@bot-wa/core": minor
"@bot-wa/telegram": minor
"@bot-wa/baileys": patch
"@bot-wa/meta": patch
"@bot-wa/ai": minor
---

Native streaming of long/AI replies with `ctx.stream(source, opts)`. The strategy comes from the new `ProviderCapabilities.streaming` field (`'draft' | 'edit' | 'none'`): native drafts (Telegram `sendMessageDraft`, with `can_stop`/`keep_on_stop`), throttled message edits (Discord, Telegram groups) or sentence chunks with typing (WhatsApp). Updates are throttled, cancellation is supported (`signal`, the user's stop button) and no message exceeds `maxTextLength`. New exports: `streamText`, `resolveStreamStrategy`, `splitMessage`, `findSplitPoint` and their types; `IProvider.sendDraft`; `MockProvider({ streaming })`. `@bot-wa/ai` gains `AIClient.streamReplyInChat()` and the `stream` option for the autoresponder. The Telegram long-poll now also asks for `stopped_message_generation` updates.
