---
"@bot-wa/ai": minor
---

The built-in user-facing texts are localizable: the `confirm: true` tool prompt, the `maxSteps` reply and the `rag.appendSources: true` line now come from the `ai.*` catalog (`AI_MESSAGES`, `AI_LOCALES` with `es` and `en`) resolved through `ctx.t`, so they follow `ctx.lang` and can be overridden with `bot.locale('en', { ai: { tools: { confirm: '…' } } })`. Without i18n (or without a message context) the Spanish texts are unchanged. `defaultConfirmPrompt()` and `formatSources()` take an optional context, `streamReplyInChat()` accepts `ctx`, and the `toolConfirm.yes` doc now lists the real `DEFAULT_YES` words.
