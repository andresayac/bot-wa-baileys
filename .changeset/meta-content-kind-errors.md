---
"@bot-wa/meta": patch
---

A send rejected with `131051` (unsupported message type) or `131062` (BSUID recipient not supported) now reports the kind that was actually sent in `UnsupportedContentError.kind`, instead of the generic `'native'` / `'template'` fallback. `GraphClient.sendMessage` takes the content kind as an optional third argument.
