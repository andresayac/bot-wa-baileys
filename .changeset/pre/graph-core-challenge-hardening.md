---
"@bot-wa/graph-core": patch
---

Security: `verifyChallenge` compares `hub.verify_token` in constant time and rejects an empty configured token and non-string query values; `checkGraphSignature` finds `X-Hub-Signature-256` case-insensitively and `verifySignature` validates the hex digest format.
