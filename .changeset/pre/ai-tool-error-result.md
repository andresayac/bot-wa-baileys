---
"@bot-wa/ai": patch
---

A side-effecting tool (`confirm` / `dedupe`) whose handler returns an object with a non-empty `error` (e.g. `{ error: 'No existe el pedido P-1' }`) is no longer remembered as a done action: it does not trigger the repeat notice, the "actions already done" system note or a `dedupe` block.
