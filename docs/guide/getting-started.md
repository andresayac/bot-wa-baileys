# Getting Started

## Requirements

- **Node.js** 22+ ([download](https://nodejs.org/))
- **pnpm** (recommended) or npm/yarn
- A phone with WhatsApp (for the Baileys transport)

::: tip Don't have pnpm?
Install it with:
```bash
npm install -g pnpm
```
:::

::: warning ESM-only packages
`@botmesh/core` and the transport packages ship as **pure ESM** — there is
no CommonJS build. Your project needs `"type": "module"` in its
`package.json` (or a `.mjs` file extension). On Node **>= 22.12** you can
also `require()` them via Node's experimental `require(esm)` support, but
the examples below use plain `import`.
:::

::: warning Alpha — first npm publish pending
botmesh is in **alpha** and **no `@botmesh/*` package is on npm yet**: the
first publish is being prepared. The `pnpm add` commands on this site are the
ones that will work once it ships, with the **`@alpha` tag** (`changeset
publish` creates the `alpha` dist-tag, not `latest`, so an install without a
tag will not resolve). Until then, clone
[the repository](https://github.com/andresayac/botmesh) and use the
packages from the pnpm workspace (`workspace:*`).
:::

## Scaffold a project with create-botmesh

The fastest start is the `create-botmesh` CLI, which generates a runnable
project (it is part of the same alpha, so until the first publish run it from
the monorepo, pointing it **outside** the repo:
`pnpm --filter create-botmesh build && node packages/create-botmesh/lib/cli.js ../my-bot`;
a target inside the botmesh monorepo is refused unless you pass `--force`):

```bash
npm create botmesh@alpha my-bot
npm create botmesh@alpha my-bot -- --template telegram --yes
```

| Template | What you get |
| --- | --- |
| `baileys` (default) | WhatsApp via Baileys: scan a QR to link |
| `meta` | WhatsApp Cloud API (webhook; needs Meta credentials and a public URL) |
| `telegram` | Telegram Bot API (long-polling; needs a @BotFather token) |
| `ai` | Baileys + `@botmesh/ai` business-scoped support autoresponder (`ANTHROPIC_API_KEY`) |
| `games` | Guess the number, hangman, trivia, tic-tac-toe, rock-paper-scissors; scores in `ctx.user` |
| `support` | Tickets per user, FAQ menu and human handoff |
| `store` | Catalog, per-user cart with a 7-day TTL and a checkout flow |
| `restaurant` | Menu, delivery/pickup orders, "repeat my last order", table reservations |
| `clinic` | Appointment booking (specialty, day, time), list/cancel appointments |
| `ai-full` | Business-scoped AI + keyword/regex intents + SQLite store + scheduler + slash commands + handoff (`ANTHROPIC_API_KEY`) |

The use-case templates (`games` to `ai-full`) run on Baileys.

| Flag | Meaning |
| --- | --- |
| `-t, --template <name>` | One of the templates above (`baileys` when non-interactive) |
| `--name <name>` | Package name (default: derived from the directory) |
| `-y, --yes` | Skip prompts and use defaults |
| `--overwrite` | Allow scaffolding into a non-empty directory |
| `--force` | Allow a directory inside the botmesh monorepo itself (refused by default) |
| `-h, --help` | Show help |

Every project gets `package.json` (with `npm start` and `npm run dev`, the
[terminal simulator](/guide/dev-simulator)), `src/bot.js`, `.env.example`,
`.gitignore`, `README.md` and an **`AGENTS.md`** with instructions for AI
coding agents: the current v2 API, what does not exist (`addAnswer`,
`capture`...) and the commands to run.

The generated `package.json` depends on the npm versions of the `@botmesh/*`
packages (`^2.0.0-alpha.1` for the core, `^0.1.0` for the rest), so its
`npm install` only works after the first publish. Until then, point those
dependencies at your local checkout of the monorepo.

To set everything up by hand instead, follow the steps below.

## Step 1 — Install the framework

The engine (`@botmesh/core`) is transport-agnostic: you pair it with a
**provider** package. For WhatsApp over Baileys 7 (unofficial, QR login):

```bash
mkdir my-bot
cd my-bot
pnpm init
pnpm add @botmesh/core@alpha @botmesh/baileys@alpha
```

Other transports behind the same `IProvider` contract:

| Transport | Package | Status | Notes |
|---|---|---|---|
| WhatsApp (Baileys 7) | `@botmesh/baileys` | Alpha | Unofficial, QR login — what this guide uses |
| WhatsApp Cloud API | `@botmesh/meta` | Alpha | Official Meta API, webhook-based, no ban risk |
| Telegram | `@botmesh/telegram` | Alpha | Bot API, long-poll or webhook |
| Facebook Messenger | `@botmesh/messenger` | Experimental | Meta Graph Send API, webhook-based |
| Instagram DM | `@botmesh/instagram` | Experimental | Meta Graph, webhook-based |
| Discord | `@botmesh/discord` | Experimental | Gateway websocket + REST |

**Alpha** packages are part of the first publishable alpha. **Experimental**
ones are real, tested implementations that stay private (unpublished) for now
and may change. More experimental providers (Evolution API, WPPConnect,
Twilio, HighLevel, Gupshup, Email and TikTok) and a capability matrix are in
[Channels](/guide/channels).

Then add `"type": "module"` to the generated `package.json` so Node treats
your files as ESM:

```json
{
  "type": "module"
}
```

## Step 2 — Create your bot

Create a `bot.js` file. In v2, constructing a bot **requires a provider** —
WhatsApp session/auth options live on the provider, not on the bot:

```ts
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

const bot = new Bot({
  provider: new BaileysProvider({
    session: 'my-bot',
    qr: { terminal: true, small: true },
  }),
})

bot.on('ready', () => console.log('✅ Bot connected!'))

bot.when('hola', async (ctx) => {
  await ctx.reply('👋 Hello! I am your bot.')
})

await bot.start()
```

## Step 3 — Run and scan the QR

```bash
node bot.js
```

You'll see a QR code in your terminal. Open it on your phone:

1. Open **WhatsApp**
2. Go to **Settings → Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code

Done! Your bot is connected. Send "hola" (exactly, that's the default
matching mode) from another phone and you'll get a reply.

::: warning Don't scan with the same phone
The QR is scanned with the phone that **will be the bot**, not the one sending messages.
:::

## Other transports, same bot code

Only the provider changes — `when`/`flow`/hooks/plugins are identical on
every transport. For the official WhatsApp Cloud API:

```ts
import { Bot } from '@botmesh/core'
import { CloudAPIProvider } from '@botmesh/meta'

const bot = new Bot({
  provider: new CloudAPIProvider({
    accessToken: process.env.META_ACCESS_TOKEN,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    verifyToken: process.env.META_VERIFY_TOKEN,
    appSecret: process.env.META_APP_SECRET, // required: verifies X-Hub-Signature-256
  }),
})
```

(The Cloud API is webhook-based: pass the **raw** request body of each
inbound POST to `provider.ingest(rawBody, headers)` from your HTTP server —
the signature is computed over the exact bytes Meta sent. Without
`appSecret` the constructor throws; `allowUnsignedWebhooks: true` exists only
for isolated local development.) See [Channels](/guide/channels) for every
other transport and [Webhook server](/guide/server) to mount webhook
providers.

## Next steps

- [Your first bot](./first-bot) — a complete bot with commands, media and flows
- [Core concepts](./concepts) — understand how everything works
- [Terminal simulator](./dev-simulator) — chat with your bot with no phone (`npx botmesh dev src/bot.js`)
- [Examples](/examples/messages) — ready-to-copy recipes
