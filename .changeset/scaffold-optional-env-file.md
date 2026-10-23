---
'create-botmesh': patch
---

Scaffolded projects no longer crash before reading a single line of code: `start` and `dev` use `--env-file-if-exists`, so a fresh clone with only `.env.example` boots with the defaults instead of failing with `node: .env: not found`. Generated `engines.node` is `>=22.12` (the flag shipped in Node 22.9).
