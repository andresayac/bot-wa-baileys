---
"@bot-wa/core": minor
---

Testing: `MockProvider` takes `buttons: false` to simulate a channel without native buttons and records interaction acks in `acks` (new `acknowledgeInteraction`); `createTestBot`'s `chat.replies()` / `expectReply()` also see the text of buttons and list messages.
