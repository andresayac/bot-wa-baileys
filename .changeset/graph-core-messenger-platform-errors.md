---
"@bot-wa/graph-core": patch
---

`toGraphError` maps the Messenger Platform send errors: window subcodes 2018278 / 2534022 to `OutsideSessionWindowError`, and code 551 plus subcodes 1545041 / 2018001 / 2534014 to `RecipientUnreachableError` (with the `chatId`).
