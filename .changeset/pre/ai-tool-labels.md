---
"@bot-wa/ai": minor
---

Tools can render their confirmation for humans without a full custom message: `labels` maps argument values to human labels per argument key (`{ producto: { pan_de_bono: 'Pan de bono' } }` → `• 2 × Pan de bono`, also inside list items), and `confirmLines(args)` replaces the argument lines with your own (e.g. prices and a total computed in code) inside the localized `ai.tools.confirm` wrapper. The model and the handler keep the raw values. `argLines()` and `summarizeValue()` accept the labels as an optional extra argument; new exported type `AIToolLabels`. Defaults are unchanged.
