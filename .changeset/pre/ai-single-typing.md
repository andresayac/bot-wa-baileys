---
"@bot-wa/ai": patch
---

The one-shot autoreply no longer shows the typing indicator twice when `BotConfig.typing` is on: with `humanizeTyping` the indicator is shown while the answer is generated and the reply is sent with `typing: false`.
