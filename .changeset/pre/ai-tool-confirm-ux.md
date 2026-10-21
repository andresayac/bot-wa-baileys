---
"@bot-wa/ai": minor
---

Tool confirmations that read like a person wrote them, and fewer duplicated side effects:

- The default confirmation prompt shows the tool `title` (new optional field; default: the humanized name, `crear_pedido` → `Crear pedido`) and the arguments as short lines (`• 5 × torta_chocolate`), never the model-facing description nor raw JSON. The `ai.tools.confirm` default text changes to `Voy a: {tool}{args}\n¿Confirmas? (sí/no)` (en: `About to: {tool}{args}\nDo you confirm? (yes/no)`).
- An answer that is not a clear yes/no (e.g. "sí pero cambia a 5 unidades") no longer counts as a denial: the tool is not run and the model gets `{ executed: false, reason: 'user_replied', userReply }` so it can re-propose. New `classifyConfirmation()`, `DEFAULT_NO`, `toolConfirm.no`, `ToolConfirmReply`, event `tool.confirm.replied`; `DEFAULT_YES` gains a few words.
- A localized system prompt note lists the tools the system confirms itself, so the model does not ask before calling them (`toolConfirm.systemNote`, `AIClientOptions.toolNote`).
- Successful runs of `confirm`/`dedupe` tools are remembered per chat (in memory, cleared by `/reset` / `clearToolHistory()`): a repeated call is flagged in the confirmation prompt (`ai.tools.confirmRepeat`, `ToolConfirmRequest.previous`) and in the system prompt, and the new per-tool `dedupe: 'args' | { windowMs }` blocks an identical re-run (`{ executed: false, reason: 'duplicate', previous }`, event `tool.duplicate`).
- The JSON Schema validator also checks `minimum`/`maximum`, `minLength`/`maxLength` and `minItems`/`maxItems`; invalid arguments (including `enum` inside `items`) are rejected before any confirmation.
- The autoreply converts the model's Markdown to the channel's format from `capabilities.textFormat` (WhatsApp `*bold*`, stripped on plain channels), also when streaming. New `format` option and `formatMarkdown()` / `formatMarkdownStream()` exports.
