---
"@bot-wa/ai": patch
---

A failing typing indicator no longer turns the autoreply into `errorMessage`: the `ctx.typing()` shown while the answer is generated is ignored when it fails (one-shot, tool and streamed paths).
