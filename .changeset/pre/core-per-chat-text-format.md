---
"@bot-wa/core": minor
"@bot-wa/ai": patch
---

`@bot-wa/core`: new optional `IProvider.textFormatFor(chatId)` for providers that serve several channels with different markup through one instance (e.g. Twilio WhatsApp + SMS). It wins over `capabilities.textFormat` (the fallback when it returns `undefined`) and reaches handlers as `ctx.textFormat`. `MockProvider` accepts `textFormatFor`; `ChaosProvider` forwards it.

`@bot-wa/ai`: the autoreply (one-shot and streamed) formats Markdown with the chat's `ctx.textFormat` instead of the provider-wide `capabilities.textFormat`.
