# create-bot-wa

Scaffold a new [@bot-wa](https://github.com/andresayac/bot-wa-baileys) bot project in seconds — no runtime dependencies (only `node:` builtins).

> **Alpha — first npm publish pending.** `create-bot-wa` and the `@bot-wa/*` packages it stamps into
> generated projects are part of the first alpha, which is **not on npm yet**. Until it is, `npm create bot-wa`
> will not resolve and a generated project cannot `npm install` its dependencies from the public registry;
> run the CLI from this monorepo instead, targeting a directory **outside** the repo
> (`pnpm --filter create-bot-wa build && node packages/create-bot-wa/lib/cli.js ../my-bot`). A target inside the
> bot-wa monorepo is refused (it would join the framework workspace) unless you pass `--force`.

## Usage

```bash
npm create bot-wa@latest my-bot
# or
pnpm create bot-wa my-bot
```

You'll be prompted for a template (in a TTY), or pass everything up front:

```bash
npm create bot-wa@latest my-bot -- --template telegram --yes
```

## Templates

| Template   | Transport                          | What you need                       |
| ---------- | ---------------------------------- | ----------------------------------- |
| `baileys`  | WhatsApp via Baileys socket        | nothing — scan a QR code to link    |
| `meta`     | WhatsApp via Meta Cloud API        | `META_TOKEN`, `META_PHONE_ID`, `META_VERIFY_TOKEN`, `META_APP_SECRET` + a public webhook URL |
| `telegram` | Telegram Bot API (long-polling)    | a bot token from @BotFather         |
| `ai`       | Baileys + `@bot-wa/ai` business-scoped customer-support autoresponder | `ANTHROPIC_API_KEY` (Claude), `BUSINESS_NAME` |

### Use-case templates

All of them run on WhatsApp via Baileys (scan a QR), use the v2 API (`flow()`, `bot.conversation()`, `ctx.user`)
and work in `npm run dev` with no phone.

| Template     | What it does |
| ------------ | ------------ |
| `games`      | Guess the number, hangman, trivia, tic-tac-toe and rock-paper-scissors; scores in `ctx.user.ns('games')` |
| `support`    | Tickets per user, FAQ menu, human handoff (`agente` → `ctx.handoff()`, `/bot` resumes) |
| `store`      | Catalog, per-user cart with a 7-day TTL, checkout flow (name → address → payment → confirm) |
| `restaurant` | Menu, delivery/pickup orders, "repeat my last order", table reservations |
| `clinic`     | Appointment booking (specialty → working day → time), list/cancel appointments, sites, emergency notice |
| `ai-full`    | Business-scoped AI (`@bot-wa/ai`) + regex intents + SQLite store + scheduler + slash commands + handoff (`ANTHROPIC_API_KEY`) |

### The `ai` template and Meta's AI policy

Since **2026-01-15** the Meta terms for the WhatsApp Business Platform prohibit **general-purpose AI assistants**
(open-ended, ChatGPT-style chatbots whose main purpose is the AI itself). AI that serves the business's own
customers — support, sales, bookings — is allowed. The `ai` template therefore ships a persona scoped to one
business (`BUSINESS_NAME` in `.env`, `PERSONA` in `src/bot.js`) that declines unrelated requests; keep it that way,
especially if you move the bot to the official Cloud API (`@bot-wa/meta`). See the
[current terms](https://www.whatsapp.com/legal/business-solution-terms) and the
[AI plugin guide](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/guide/ai.md).

Both AI templates (`ai`, `ai-full`) answer in Spanish and pin the built-in texts to it
(`i18n: { defaultLocale: 'es', locales: ['es'] }` in `new Bot(...)`), so the slash commands and the AI's
confirmation prompts (`¿Confirmas?`, `Sí`/`No`) always match the persona, even for a client that reports
another language. To serve more languages, list them there and translate `PERSONA`. The `ai-full` tools follow the
[side-effecting tools best practices](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/guide/ai-tools.md):
a `title` on every tool, product `labels`, `confirmLines` with code-computed totals, `dedupe` on create, and an
`onToolEvent` audit log with metadata only.

## What gets generated

```
my-bot/
├── package.json      # type: module, @bot-wa/core + the transport, start/dev scripts (dev = bot-wa dev terminal simulator)
├── src/bot.js        # runnable bot: provider + bot.when('hola', …) + a small flow
├── .env.example      # the env vars the bot reads (copy to .env)
├── .gitignore        # node_modules/, sessions/, .env, *.qr.png, *.db, *.db-*
├── README.md         # how to run this specific bot
└── AGENTS.md         # instructions for AI coding agents: the v2 API, what does NOT exist (addAnswer, capture…), commands
```

Then:

```bash
cd my-bot
npm install
cp .env.example .env   # fill in your credentials
npm run dev            # chat in the terminal: simulated provider, hot reload
npm start              # connect the real channel
```

## CLI options

```
create-bot-wa <dir> [options]

  -t, --template <t>  baileys | meta | telegram | ai | games | support | store | restaurant | clinic | ai-full
                      (default: baileys when non-interactive)
  --name <name>       package name, scoped names included (default: derived from the directory name)
  -y, --yes           skip prompts; use defaults for anything missing
  --overwrite         allow scaffolding into a non-empty directory
  --force             allow a directory inside the bot-wa monorepo itself
  -h, --help          show help
```

`scaffold()` is also importable programmatically:

```ts
import { scaffold, TEMPLATE_NAMES } from 'create-bot-wa'

const result = await scaffold({ targetDir: './my-bot', template: 'telegram' })
console.log(result.files) // ['package.json', 'src/bot.js', '.env.example', '.gitignore', 'README.md', 'AGENTS.md']
```

It refuses to write into a non-empty target directory unless `overwrite: true` is passed.

## Development

```bash
pnpm --filter create-bot-wa build   # tsc → lib/ (keeps the bin shebang)
pnpm --filter create-bot-wa test    # hermetic vitest suite (temp dirs, no network)
```
