---
'create-botmesh': patch
---

The `ai-full` template stamps the same `better-sqlite3` range as the `@botmesh/sqlite-store` peer (`^11.7.0 || ^12.0.0 || ^13.0.0`), so a fresh project on Node 24 installs a major with prebuilt binaries instead of compiling 11.x from source.
