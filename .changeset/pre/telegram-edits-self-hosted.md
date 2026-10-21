---
"@bot-wa/telegram": minor
---

- Edited messages: `edited_message` keeps reaching the bot as a message with the new text and the original `ref.id` (replies, reactions and edits target the edited message); `ref.native.edit_date` is now set and the new `isEditedMessage(ctx)` helper tells an edit apart. New `editedMessages: 'deliver' | 'ignore'` option (default `'deliver'`): `'ignore'` stops requesting edits from `getUpdates` and drops them in webhook mode.
- Self-hosted Bot API servers: `downloadMedia` failures now reject with typed errors that never include the URL (it carries the bot token): `PayloadTooLargeError` over `mediaDownload.maxBytes`, and a `ProviderError` naming `mediaDownload.allowHttp` / `allowPrivateHosts` when the download guard refuses a plain-HTTP or private host. A server started with `--local` (absolute `file_path`) gets an explanatory `ProviderError`. Documented in the README and the channels guide.
