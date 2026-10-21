---
"@bot-wa/graph-core": minor
---

New `readGraphResponse(res, { chatId, contentKind, retryAfterMs })`: the single Graph response check shared by the Cloud API, Messenger and Instagram clients. It resolves to the JSON body, or rejects with the typed error `toGraphError` maps it to (honouring `Retry-After`), so the Messenger Platform window / unreachable codes live in one place.
