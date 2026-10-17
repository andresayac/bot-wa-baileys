---
"@bot-wa/core": minor
"@bot-wa/meta": minor
"@bot-wa/baileys": patch
"@bot-wa/telegram": patch
---

Add native forms: `flow().form(definition, opts)` collects typed fields (text, number, email, date, select, multiselect, opt-in) with validation. Providers with the new `capabilities.forms: 'native'` receive an `OutboundContent` of kind `'form'` and reply with `'form'` inbound messages (`formReplyBody()` / `parseFormReply()`); every other provider gets field-by-field questions. `describe()` draws `form` nodes and `lint()` checks their timeouts and `c.state` key collisions. `@bot-wa/meta` renders forms as static WhatsApp Flows (`toFlowJson`, `toFlowMessage`, `publishForm()`, `config.flows`) and turns `nfm_reply` webhooks into form replies. Other providers reject the `form` kind with `UnsupportedContentError`.
