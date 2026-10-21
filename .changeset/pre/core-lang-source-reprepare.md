---
"@bot-wa/core": minor
---

New `ctx.langSource` (`'user' | 'provider' | 'detector' | 'default'`) and `I18n.resolveDetailed()`. When a `before('message')` hook rewrites `ctx.body` (e.g. a voice transcript) and the language came from the detector or the default, the dispatcher re-resolves it after the hooks so an i18n `detect` sees the final text; a `ctx.lang` assigned by the hook is kept.
