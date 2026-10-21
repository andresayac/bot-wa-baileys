---
"@bot-wa/ai": patch
---

The "already done, confirming will do it again" notice of a tool confirmation (`ai.tools.confirmRepeat`) is only shown when the new call has the same (validated) arguments as a previous successful run in the chat; a call with different arguments (e.g. changing an order from 3 to 2 units) is a new action and gets no notice. `ToolConfirmRequest.previous` follows the same rule. The result summary in that notice (and in `summarizeValue()`) leaves out fields too nested to read instead of rendering them as `…, …`.
