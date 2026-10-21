---
"create-bot-wa": minor
---

The CLI and `scaffold()` refuse a target directory inside a checkout of the bot-wa monorepo itself (a `pnpm-workspace.yaml` next to `packages/core` named `@bot-wa/core`), where the new project would join the framework workspace. Pass `--force` (`force: true`) to scaffold there anyway; other pnpm workspaces are not affected. New export: `findBotWaMonorepo()`.
