---
"@bot-wa/telegram": patch
---

Hardening: `callback_data` is cut to the Bot API's 64 **bytes** (UTF-8) without splitting a character, so buttons with accented or emoji ids no longer fail with `BUTTON_DATA_INVALID`. A `location` with `name` and `address` goes out as `sendVenue` instead of dropping them. `400 chat not found` / `user not found` / `bot is not a member` map to `RecipientUnreachableError`, and `413` / `file is too big` to `PayloadTooLargeError`. The long-poll loop stops with `sessionInvalid` when the token is revoked mid-run (it used to retry forever), and `stop()` → `start()` announces `ready` again.
