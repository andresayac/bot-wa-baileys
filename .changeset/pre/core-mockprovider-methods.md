---
"@bot-wa/core": patch
---

`MockProvider.editMessage` / `deleteMessage` / `sendDraft` are real class methods again, so a subclass that defines them as methods typechecks (no TS2425). The new `supports: { edit, delete, drafts }` option chooses which ones are exposed (defaults follow `streaming`); a disabled one reads `undefined` on the instance so the bot treats it as unsupported, and an explicit `false` also hides a subclass override.
