# create-bot-wa

Scaffold a new [@bot-wa](https://github.com/andresayac/bot-wa-baileys) bot project in seconds — no runtime dependencies (only `node:` builtins).

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
| `meta`     | WhatsApp via Meta Cloud API        | `META_TOKEN`, `META_PHONE_ID` + webhook URL |
| `telegram` | Telegram Bot API (long-polling)    | a bot token from @BotFather         |
| `ai`       | Baileys + `@bot-wa/ai` autoresponder | `ANTHROPIC_API_KEY` (Claude)      |

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
