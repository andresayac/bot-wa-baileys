---
"create-bot-wa": minor
---

- New use-case templates: `games`, `support`, `store`, `restaurant`, `clinic` and `ai-full` (AI + regex intents + SQLite store + scheduler + slash commands + handoff). All of them use the v2 API, the `defineBot` factory and `npm run dev`.
- Every generated project now ships an `AGENTS.md` for AI coding agents: the current v2 API, the v1 idioms that do not exist (`addAnswer`, `capture`, `flowDynamic`…) and the commands to run. Exported as `agentsMd()`.
- The demo `menu` flow of the transport templates now has a `.timeout('5m')`, and `.gitignore` also ignores `*.db` files.
