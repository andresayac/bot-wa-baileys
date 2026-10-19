---
"@bot-wa/baileys": patch
---

- Wrapped messages (disappearing mode, view once, document with caption) are unwrapped before classification, so they arrive with their real `type`, `body` and `media` instead of `'unknown'`.
- Reply context and mentions are read from image, video and document captions too, not only from text messages; `quoted.ref` now points at the quoted message (a WAMessage-shaped `native`, usable as `quoted` to reply in thread), and a quoted media caption fills `quoted.body`.
- `timestamp` is always a plain number (protobuf `Long` timestamps were passed through as objects); location and contact messages get a readable `body`; template button replies map to `type: 'buttons'`.
- `stop()` cancels a pending reconnect, so a later `start()` no longer races a stale backoff timer into a second socket.
- `downloadMedia()` rejects with a `ProviderError` when disconnected or when the download fails (was a `TypeError` / raw Baileys error); `markRead()` and `deleteMessage()` accept refs without a native key (rebuilt from `chatId` + `id`), and `deleteMessage()` rejects when disconnected instead of silently doing nothing.
