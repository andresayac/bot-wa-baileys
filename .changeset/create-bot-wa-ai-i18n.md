---
"create-bot-wa": minor
---

The `ai` and `ai-full` templates answer in Spanish and pin the built-in texts to it (`i18n: { defaultLocale: 'es', locales: ['es'] }`), so slash commands and the AI confirmation prompts always match the persona. The `ai-full` tools gain a `title` each, product `labels`, a `confirmLines` on `cancelar_pedido` (`• Pedido: P-…` instead of `• Id: …`), `maxItems` on the order lines, case/space-tolerant order ids and an `onToolEvent` audit log with metadata only.
