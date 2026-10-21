---
"@bot-wa/http": patch
---

`secureFetch` rejects right away (without any request) when the caller's `signal` is already aborted; before, the request went out ignoring it. A followed redirect's body is now released instead of left unread, and the per-hop connections are destroyed at the end: a server answering a redirect with a body that never ends could stall `secureFetch` forever (past `timeoutMs`).
