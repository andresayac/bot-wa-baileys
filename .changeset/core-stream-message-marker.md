---
"@bot-wa/core": minor
---

The new messages `ctx.stream()` sends (the first message of an edit stream, sentence chunks, the final message after drafts) now carry `stream: 'message'` on the `before('send')` / `after('send')` payload, like live previews carry `'draft'` / `'edit'`, so send hooks can tell streamed output apart (e.g. a text-to-speech hook keeps it as text). New optional `BuildContextDeps.streamSend`.
