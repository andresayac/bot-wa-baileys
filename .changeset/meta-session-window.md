---
"@bot-wa/meta": minor
"@bot-wa/core": minor
---

Add a WhatsApp Cloud API 24 h customer-service window manager (`sessionWindow` option, `SessionWindowManager`, pluggable `SessionWindowStore`): reopen closed chats with an approved template and retry the original send when the user replies. Status events now carry the normalized `pricing`/`conversation` objects in `DeliveryStatus.platformData` (new optional field in core), and `provider.usage` aggregates per-chat/per-category usage and estimated cost.
