---
"@bot-wa/core": minor
"@bot-wa/meta": minor
---

Native form labels follow the user's language. `ctx.form()` / `flow().form()` fill a missing `cta`, `submitLabel` and (without `intro`/`title`) body from the new `core.form.cta`, `core.form.submit` and `core.form.body` catalog entries (`es`/`en`) in `ctx.lang`, through the exported `withFormDefaults()`. `@bot-wa/meta` no longer hard-codes Spanish: its fallbacks use the same catalog and `toFlowJson(def, { lang })` (also `publishForm(def, { flowJson: { lang } })`) picks the language of the published Flow's default submit label (default `'es'`, unchanged).
