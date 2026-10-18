/**
 * `AGENTS.md` for generated projects: tells AI coding agents (Claude Code,
 * Codex, Cursor, Copilot…) which @bot-wa API is current, which v1 idioms do
 * NOT exist, and which commands to run. Pure string builder.
 */

export interface AgentsMdInfo {
  /** Project (package) name. */
  name: string
  /** Template label, e.g. `WhatsApp · Baileys`. */
  label: string
  /** `@bot-wa/*` (and other) runtime dependencies of the project. */
  dependencies: string[]
  /** Template-specific notes (one markdown line each). */
  notes?: string[]
}

/** Build the AGENTS.md of a generated project. */
export function agentsMd(info: AgentsMdInfo): string {
  const fence = '```'
  return [
    '# AGENTS.md',
    '',
    'Instructions for AI coding agents working on **' + info.name + '** (template: ' + info.label + ').',
    'This bot uses the **@bot-wa v2 API**. Read this file before writing or changing bot code.',
    '',
    '## Commands',
    '',
    fence + 'bash',
    'npm install            # install dependencies (or: pnpm install)',
    'npm run dev            # bot-wa dev: chat with the bot in the terminal (simulated provider, hot reload)',
    'npm start              # connect the real transport (reads .env via node --env-file)',
    'node --check src/bot.js  # quick syntax check',
    fence,
    '',
    'Prefer `npm run dev` to try changes: it never touches a real chat. Do not run `npm start` unless asked —',
    'it connects a real account.',
    '',
    '## Project layout',
    '',
    '- `src/bot.js` — `export default defineBot((provider) => { const bot = new Bot({ provider }); …; return bot })`.',
    '  Register handlers/flows **inside the factory**. The `if (isMainModule(import.meta)) { … }` block at the bottom',
    '  builds the real provider and calls `bot.start()`; the factory itself must never call `bot.start()`.',
    '- `.env` — secrets (copy from `.env.example`). Never commit `.env`, `sessions/` or `*.db` files, and never print tokens.',
    '- Dependencies: ' + info.dependencies.map((d) => '`' + d + '`').join(', ') + '.',
    '',
    '## The v2 API (use this)',
    '',
    fence + 'js',
    "import { Bot, defineBot, flow, isMainModule } from '@bot-wa/core'",
    '',
    "bot.when('hola', async (ctx) => { await ctx.reply('¡Hola!') })          // keyword handler",
    "bot.command('ayuda', async (ctx) => { await ctx.reply('…') })           // /ayuda",
    'bot.use(',
    "  flow('pedido')                                                       // flow DSL",
    "    .say('Vamos a tomar tu pedido')",
    "    .ask('¿Cuántas unidades?', 'qty', { timeout: '5m', validate: (t) => /^\\d+$/.test(t) || 'Solo números' })",
    "    .choose('¿Entrega?', { '1': 'Domicilio', '2': 'Recoger' }, 'delivery')",
    "    .do(async (ctx, c) => { await ctx.user.set('lastOrder', c.state) })",
    "    .say((_ctx, c) => 'Listo: ' + c.state.qty)",
    "    .timeout('10m'),",
    ')',
    "bot.conversation('juego', async (c, ctx) => {                         // free-form async conversation",
    "  const answer = await c.ask('¿Piedra, papel o tijera?', { timeout: '2m' })",
    "  await ctx.reply('Elegiste ' + answer)",
    "}, { trigger: 'jugar' })",
    fence,
    '',
    '- Flow steps: `.say`, `.ask(text, stateKey, opts)`, `.do`, `.choose`, `.media`, `.goto`, `.timeout`, `.persistent`.',
    '  Answers land in `c.state[stateKey]`.',
    '- Per-user data that must survive restarts: `ctx.user.get/set/update/delete` (`ctx.user.ns(\'feature\')` to namespace;',
    '  inside flow steps use `userOf(ctx)` from `@bot-wa/core`). Do **not** keep per-user state in module-level',
    '  `Map`s/objects or a `globalState` — it is lost on restart and leaks between users.',
    '- Triggers compare by **normalized equality** (`\'hola\'` matches "Hóla " but not "hola amigo"). For substring',
    "  matching use `{ pattern: 'precio', match: 'contains' }` or a RegExp. Never use an empty trigger (`''`, `[]`).",
    '- Every `.ask()` / `c.ask()` / `c.waitText()` should have a `timeout` (or the flow a `.timeout(...)`), so an',
    '  abandoned conversation does not stay open forever.',
    '- Scheduler: `bot.every(\'1h\', fn)`, `bot.schedule(\'0 9 * * 1-5\', fn)`, `bot.delay(\'10m\', fn)`.',
    '- Human handoff: `await ctx.handoff({ reason })` and `bot.resume(chatId)`.',
    '',
    '## Does NOT exist (v1 / other frameworks) — never generate it',
    '',
    '| Wrong (v1 / builderbot) | Right (v2) |',
    '| --- | --- |',
    '| `addKeyword(...).addAnswer(...)` | `flow(...).say(...)` / `.ask(...)` |',
    '| `{ capture: true }` | `.ask(text, stateKey)` or `await c.ask(text)` |',
    '| `.addAction(...)` | `.do(async (ctx, c) => …)` |',
    '| `flowDynamic(...)` | `ctx.reply(...)` or a `.say((ctx, c) => …)` step |',
    '| `gotoFlow(x)` | `.goto(\'name\')` or `c.goto(\'name\')` |',
    '| `endFlow()` / `.end()` | return from the step/conversation (or `c.end()`) |',
    '| `createBot({ flow, provider, database })` | `new Bot({ provider, store })` inside `defineBot` |',
    '| `globalState` / `state.update` | `ctx.user.set(...)` (persistent) or `c.state` (per conversation) |',
    '',
    '## Rules',
    '',
    '- ESM only (`"type": "module"`): `import`, never `require()`. Relative imports keep the `.js` extension.',
    '- A handler that starts a conversation with the low-level runtime must **not** await it',
    '  (`void runtime.enter(...).catch(...)`); awaiting blocks that chat\'s message queue.',
    '- A plugin\'s `install()` must be **synchronous**; do async setup lazily on first use.',
    '- Use `bot.logger` (pino-compatible) instead of `console.*` and never log message bodies, tokens or QR payloads.',
    '- IDs (`ctx.from`, `ctx.sender`) are opaque strings: never parse them (no `@s.whatsapp.net` / `@g.us` logic).',
    ...(info.notes && info.notes.length ? ['', '## This template', '', ...info.notes] : []),
    '',
  ].join('\n')
}
