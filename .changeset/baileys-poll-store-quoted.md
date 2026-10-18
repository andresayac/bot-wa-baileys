---
"@bot-wa/baileys": minor
---

- New `pollStore` option (`PollStore` / `StoredPoll` types): persist polls so their votes can still be decrypted after a restart. The in-memory cache of 500 polls stays in front of it; a failing store is logged and never breaks a send or receive. The stored entry holds the poll secret, so treat it like the session folder.
- `ctx.quoted.senderId` is canonical (LID → PN when known), like mentions, so `ctx.quoted?.senderId === provider.selfId` detects a reply to a bot message.
- Messages of ignored chats (status, broadcast lists, newsletters) no longer take room in the 2000-message resend cache.
