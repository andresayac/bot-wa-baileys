# create-bot-wa

Scaffold a new [@bot-wa](https://github.com/andresayac/bot-wa-baileys) bot project in seconds — no runtime dependencies (only `node:` builtins).

> **Alpha — first npm publish pending.** `create-bot-wa` and the `@bot-wa/*` packages it stamps into
> generated projects are part of the first alpha, which is **not on npm yet**. Until it is, `npm create bot-wa`
> will not resolve and a generated project cannot `npm install` its dependencies from the public registry;
> run the CLI from this monorepo instead (`pnpm --filter create-bot-wa build && node packages/create-bot-wa/lib/cli.js my-bot`).

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

### The `ai` template and Meta's AI policy

Since **2026-01-15** the Meta terms for the WhatsApp Business Platform prohibit **general-purpose AI assistants**
(open-ended, ChatGPT-style chatbots whose main purpose is the AI itself). AI that serves the business's own
customers — support, sales, bookings — is allowed. The `ai` template therefore ships a persona scoped to one
business (`BUSINESS_NAME` in `.env`, `PERSONA` in `src/bot.js`) that declines unrelated requests; keep it that way,
especially if you move the bot to the official Cloud API (`@bot-wa/meta`). See the
[current terms](https://www.whatsapp.com/legal/business-solution-terms) and the
[AI plugin guide](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/guide/ai.md).

## What gets generated

```
my-bot/
├── package.json      # type: module, @bot-wa/core + the transport, start/dev scripts
├── src/bot.js        # runnable bot: provider + bot.when('hola', …) + a small flow
├── .env.example      # the env vars the bot reads (copy to .env)
├── .gitignore        # node_modules/, sessions/, .env, *.qr.png
└── README.md         # how to run this specific bot
```

Then:

```bash
cd my-bot
npm install
cp .env.example .env   # fill in your credentials
npm start              # or: npm run dev (auto-reload)
```

## CLI options

```
create-bot-wa <dir> [options]

  -t, --template <t>  baileys | meta | telegram | ai   (default: baileys when non-interactive)
  --name <name>       package name (default: derived from the directory name)
  -y, --yes           skip prompts; use defaults for anything missing
  --overwrite         allow scaffolding into a non-empty directory
  -h, --help          show help
```

`scaffold()` is also importable programmatically:

```ts
import { scaffold, TEMPLATE_NAMES } from 'create-bot-wa'

const result = await scaffold({ targetDir: './my-bot', template: 'telegram' })
console.log(result.files) // ['.env.example', '.gitignore', 'README.md', 'package.json', 'src/bot.js']
```

It refuses to write into a non-empty target directory unless `overwrite: true` is passed.

## Development

```bash
pnpm --filter create-bot-wa build   # tsc → lib/ (keeps the bin shebang)
pnpm --filter create-bot-wa test    # hermetic vitest suite (temp dirs, no network)
```
