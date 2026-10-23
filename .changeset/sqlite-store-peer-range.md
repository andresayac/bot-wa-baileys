---
'@botmesh/sqlite-store': patch
---

The `better-sqlite3` peer range now covers `^11.7.0`, `^12.0.0` and `^13.0.0`; the store was run against 12.11.1 and 13.0.3 (chats, contacts, messages, checkpoints with compare-and-set, conversations, cursors, per-user data and persistence across instances) with the same results as 11.x. Installing the latest `better-sqlite3` no longer warns about an unmet peer. `./package.json` is exported again.
