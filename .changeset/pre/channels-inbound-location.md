---
"@bot-wa/baileys": minor
"@bot-wa/meta": minor
"@bot-wa/telegram": minor
---

Inbound locations fill the normalized `InboundMessage.location` (`ctx.sharedLocation`): Baileys `locationMessage` and `liveLocationMessage` (`live: true`; a live location's body is now its caption), Cloud API `location`, Telegram `location` (live when `live_period` is set) and `venue` (its title becomes the body; new `TelegramVenue` type).
