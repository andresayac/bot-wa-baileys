# create-bot-wa

## 0.2.0-alpha.0

### Minor Changes

- 8b5ee35: The `ai-full` template adds a `cotizar_pedido` tool (prices, subtotals and total computed in code) and tells the model to use it instead of doing the math. The `crear_pedido` / `actualizar_pedido` confirmations show product names and the code-computed total (`confirmLines`) instead of menu keys, and an unknown order id returns `{ error }` instead of throwing.
- 668e8d9: The `ai-full` template ships example AI tools: `ver_menu`, `mis_pedidos`, `crear_pedido`, `actualizar_pedido` and `cancelar_pedido`, with products validated as an `enum` of the menu keys, `confirm: true` on the order-changing tools and `dedupe` on `crear_pedido`. Orders are kept in `ctx.user`.
- 14bcd28: The `ai` and `ai-full` templates answer in Spanish and pin the built-in texts to it (`i18n: { defaultLocale: 'es', locales: ['es'] }`), so slash commands and the AI confirmation prompts always match the persona. The `ai-full` tools gain a `title` each, product `labels`, a `confirmLines` on `cancelar_pedido` (`• Pedido: P-…` instead of `• Id: …`), `maxItems` on the order lines, case/space-tolerant order ids and an `onToolEvent` audit log with metadata only.
- c385f40: The CLI and `scaffold()` refuse a target directory inside a checkout of the bot-wa monorepo itself (a `pnpm-workspace.yaml` next to `packages/core` named `@bot-wa/core`), where the new project would join the framework workspace. Pass `--force` (`force: true`) to scaffold there anyway; other pnpm workspaces are not affected. New export: `findBotWaMonorepo()`.
- 522bcca: - Generated projects use the `defineBot` + `isMainModule` factory pattern and add `npm run dev` (`bot-wa dev src/bot.js --env-file .env`) to chat with the bot in the terminal.
  - The `ai` template ships a business-scoped customer-support persona (`BUSINESS_NAME`), per the WhatsApp Business AI policy in force since 2026-01-15.
- ea3fd2a: - New use-case templates: `games`, `support`, `store`, `restaurant`, `clinic` and `ai-full` (AI + regex intents + SQLite store + scheduler + slash commands + handoff). All of them use the v2 API, the `defineBot` factory and `npm run dev`.
  - Every generated project now ships an `AGENTS.md` for AI coding agents: the current v2 API, the v1 idioms that do not exist (`addAnswer`, `capture`, `flowDynamic`…) and the commands to run. Exported as `agentsMd()`.
  - The demo `menu` flow of the transport templates now has a `.timeout('5m')`, and `.gitignore` also ignores `*.db` files.

### Patch Changes

- 14bcd28: CLI: `--template`/`-t` and `--name` without a value (or followed by another option, as in `-t --yes`) now fail with "Option --template needs a value" instead of silently falling back to the default template. `--name @acme/support-bot` keeps its scope (it used to become `support-bot`), names are capped at npm's 214 characters, and "Next steps" lists `npm run dev` and prints an absolute `cd` path when the project is outside the current directory.
- 4d95812: `create-bot-wa` stamps `@bot-wa/*` dependency ranges derived at build time from each public package's current version (`^<exact version>`, e.g. `^2.0.0-alpha.2` or `^0.1.1-alpha.0`), instead of hand-written constants like `^0.1.0` that npm does not resolve to a prerelease — freshly scaffolded projects install while the packages are on the `alpha` line. The `@bot-wa/baileys` README links its example on GitHub (the relative link broke on npmjs.com).
- 31fcc2e: The Baileys-based templates no longer write the QR pairing payload to the logger (anyone reading the logs could link a device while the QR is valid); the `qr` handler only logs a hint, since the provider already draws the QR in the terminal.
