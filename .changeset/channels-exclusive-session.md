---
"@bot-wa/baileys": patch
"@bot-wa/telegram": patch
---

Declare `capabilities.exclusiveSession` (Baileys always, Telegram in long-polling mode), so with multi-replica coordination only the elected replica connects the session.
