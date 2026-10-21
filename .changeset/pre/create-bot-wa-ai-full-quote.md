---
"create-bot-wa": minor
---

The `ai-full` template adds a `cotizar_pedido` tool (prices, subtotals and total computed in code) and tells the model to use it instead of doing the math. The `crear_pedido` / `actualizar_pedido` confirmations show product names and the code-computed total (`confirmLines`) instead of menu keys, and an unknown order id returns `{ error }` instead of throwing.
