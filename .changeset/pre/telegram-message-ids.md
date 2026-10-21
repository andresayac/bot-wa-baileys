---
"@bot-wa/telegram": patch
---

Inbound events never carry an empty id: callbacks on inline-mode messages use `inline_message_id` as `ref.id`, ephemeral messages (Bot API 10.2) use `eph:<ephemeral_message_id>`, and events without an addressable message get `upd:<update_id>` (stable across webhook retries). Edits, deletes and quotes resolve the right Bot API target from the ref; ephemeral messages are never quoted from a regular send.
