---
"@bot-wa/core": minor
---

`flow().form()` defaults are localizable: the field-by-field hints, the skip word, the native "fill in the form" reminder and every validation error now come from the built-in `core.form.*` catalog (`CORE_MESSAGES.form*`, `es` and `en`) in the subject's `ctx.lang`. A `schema` rejection without its own message uses `core.wait.invalid` (`DEFAULT_SCHEMA_MESSAGE` is deprecated). `parseFieldAnswer()` and `validateFormValues()` take an optional translator (default: Spanish, unchanged output). Multiselect answers also accept `and` as a separator.
