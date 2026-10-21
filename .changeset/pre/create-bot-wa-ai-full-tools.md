---
"create-bot-wa": minor
---

The `ai-full` template ships example AI tools: `ver_menu`, `mis_pedidos`, `crear_pedido`, `actualizar_pedido` and `cancelar_pedido`, with products validated as an `enum` of the menu keys, `confirm: true` on the order-changing tools and `dedupe` on `crear_pedido`. Orders are kept in `ctx.user`.
