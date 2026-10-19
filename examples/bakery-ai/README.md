# Bakery AI assistant (WhatsApp via Baileys or Twilio)

A complete, runnable example of an **AI ordering assistant** built with
`@bot-wa/core` and `@bot-wa/ai`. Customers of *Demo Bakery* chat on WhatsApp
to see the menu, get exact quotes and place, change or cancel orders. The
model calls **tools**. Every tool with side effects asks the customer to
confirm first, and every price is computed by code, never by the model.

The same bot runs on two channels:

- **Baileys**: WhatsApp Web protocol. Scan a QR with your phone; no business
  account needed.
- **Twilio**: the official WhatsApp Business API, with the Twilio WhatsApp
  sandbox for testing. Webhooks go through `@bot-wa/server`.

The behaviour was validated live on both channels with real models before it
became this example.

## What it shows

- A **business-scoped persona**: it only talks about the bakery, which WhatsApp's
  AI policy requires since 2026-01-15.
- Six tools: `view_menu`, `quote_order`, `my_orders` (read-only) and
  `create_order`, `update_order`, `cancel_order` (side effects, `confirm: true`).
- **Code-computed totals** in the confirmation (`confirmLines`). The customer
  confirms numbers the model never calculated.
- Products validated with a JSON Schema **`enum`**, so an invented product is
  rejected before the customer is asked anything. Human names (`Cheese bread`)
  replace ids (`cheese_bread`) in everything the customer sees.
- **`dedupe: 'args'`** on `create_order`: the same order is not placed twice in
  a row when the model calls the tool again on its own.
- **`{ error }` results** for unknown order ids, so the model tells the customer
  instead of pretending it worked.
- Orders **scoped per customer** (the stable `ctx.sender`) behind a small
  `OrderStore` interface that you can swap for a database.
- An **allow-list** (`ALLOWED_USERS`) and **`groupMode: 'commands'`**: in groups the
  bot only answers `/commands`, not the AI.
- `slashCommandsPlugin` (`/start`, `/help`, ...) plugged **before** the
  `aiPlugin` catch-all.
- Tool **audit logs** (`onToolEvent`) and order logs. They carry metadata only
  and never message bodies.
- Typed env config with clear errors that never print secrets. Health
  endpoints (`/healthz`, `/readyz`), Twilio signature validation and graceful
  shutdown.
- Tests with **no network**: pricing, the order store, the tools, the config
  and an end-to-end conversation using `MockProvider` + a scripted
  `MockAIProvider`.

## Architecture

```text
                         ┌──────────────────── src/bot.ts ────────────────────┐
 WhatsApp ── Baileys ──┐ │ Bot (i18n: en, groupMode, whitelist)               │
 (QR session)          │ │  ├─ slashCommandsPlugin   /start /help /id ...     │
                       ├─┤  └─ aiPlugin (catch-all)                           │
 WhatsApp ── Twilio ───┘ │       persona + model (Ollama / any provider)      │
 (webhook → @bot-wa/     │       tools ──────────────┐                        │
  server ingress,        └───────────────────────────┼────────────────────────┘
  signature check)                                   ▼
                         src/tools.ts   view_menu · quote_order · my_orders
                                        create_order · update_order · cancel_order
                                        (confirm, confirmLines, dedupe, enum)
                                                     │
                                                     ▼
                         src/shop.ts    MENU · quote() · formatMoney (Intl, USD)
                                        OrderStore ◄── InMemoryOrderStore (swap for a DB)
```

| File | Role |
| --- | --- |
| [`src/shop.ts`](src/shop.ts) | Menu, pricing in integer cents, `Intl.NumberFormat` (USD), `OrderStore` interface plus an in-memory implementation. No bot or AI code. |
| [`src/tools.ts`](src/tools.ts) | `createBakeryTools(store)`: the six `defineTool` definitions. |
| [`src/bot.ts`](src/bot.ts) | `createBakeryBot(provider, options)`: the channel-agnostic `Bot` with persona, plugins and allow-list. |
| [`src/config.ts`](src/config.ts) | Typed env loading and validation (`loadBaileysConfig`, `loadTwilioConfig`). |
| [`src/runtime.ts`](src/runtime.ts) | Logger, bot logging, graceful shutdown. |
| [`src/main-baileys.ts`](src/main-baileys.ts) | Entry point: Baileys provider. |
| [`src/main-twilio.ts`](src/main-twilio.ts) | Entry point: Twilio provider + `createIngress` / `createNodeHandler` HTTP server. |

## Requirements

- Node.js >= 22 and pnpm (this repo's workspace).
- An AI model **with tool calling**. The default is a local
  [Ollama](https://ollama.com) (`ollama pull llama3.1`). Any `@bot-wa/ai`
  provider or preset works too (see [Using another AI provider](#using-another-ai-provider)).

## Run it

The sources are TypeScript with `.js` import specifiers (the repo's ESM
convention), so they are compiled with `tsc` before running. Node's built-in
type stripping does not rewrite those specifiers. From the **repo root**:

```bash
pnpm install
pnpm --filter "@bot-wa/example-bakery-ai..." build      # the example + the packages it uses
cp examples/bakery-ai/.env.example examples/bakery-ai/.env  # then edit it
```

`pnpm --filter` runs the scripts inside `examples/bakery-ai/`, so `.env` and the
Baileys `sessions/` folder are read from there. Both are git-ignored.

### Channel 1: Baileys (scan a QR)

```bash
pnpm --filter @bot-wa/example-bakery-ai start:baileys
```

1. A QR code appears in the terminal. On your phone, open WhatsApp →
   **Linked devices** → **Link a device** and scan it. To use a pairing code
   instead, set `WA_PAIRING_PHONE` and type the code that is logged.
2. The session is saved in `examples/bakery-ai/sessions/<WA_SESSION>/`. It is a
   credential: never commit or share it. Delete the folder to log out.
3. Message the linked number from another phone listed in `ALLOWED_USERS`.
   Baileys ids look like `15551234567@s.whatsapp.net` (country code + number,
   no `+`).

### Channel 2: Twilio WhatsApp sandbox

1. **Sandbox.** In the Twilio Console open *Messaging → Try it out → Send a
   WhatsApp message*. From your phone, send the shown `join <your-code>` to
   the sandbox number **+1 415 523 8886**. Each tester joins once; the join
   expires after a few days without use.
2. **Public URL.** Twilio has to reach your machine over https. A free
   [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
   quick tunnel is enough:

   ```bash
   # An empty config file stops a ~/.cloudflared/config.yml of yours (named
   # tunnels, ingress rules) from hijacking the routing of the quick tunnel.
   touch /tmp/cloudflared-empty.yml          # Windows (cmd): type nul > %TEMP%\cloudflared-empty.yml
   cloudflared tunnel --config /tmp/cloudflared-empty.yml --url http://127.0.0.1:3000
   ```

   cloudflared prints `https://<random>.trycloudflare.com`. Without
   `--config`, cloudflared also loads your default `config.yml`, and its
   ingress rules can send the quick tunnel's traffic somewhere else. The
   webhook then never arrives, or arrives with a 404.
3. **`.env`.** Fill `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (*Account info* in
   the Console) and `PUBLIC_URL=https://<random>.trycloudflare.com`.
4. **Webhook.** In the sandbox settings, set *When a message comes in* to
   `https://<random>.trycloudflare.com/twilio/webhook`, method **POST**.
5. Start the bot:

   ```bash
   pnpm --filter @bot-wa/example-bakery-ai start:twilio
   ```

   `GET /healthz` returns 200 while the server runs. `GET /readyz` returns 200
   once the bot is ready.

Twilio signs every webhook (`X-Twilio-Signature`) over the **exact** URL it
called. The provider verifies it against `PUBLIC_URL + WEBHOOK_PATH`, so that
URL must match the Console setting character for character. Unsigned or
mismatched requests get a 403. A quick tunnel gets a new URL on every start:
update both `PUBLIC_URL` and the sandbox webhook when it changes.

**BSUID note.** Twilio identifies some WhatsApp users by a *business-scoped
user id* (BSUID) instead of their number: `From=whatsapp:CO.2132056440717202`
instead of `whatsapp:+57...`. The provider uses it as is: it is the stable
`chatId`/`senderId`, and replies are sent to it. To allow such a user, add that
exact id to `ALLOWED_USERS` next to (or instead of) `whatsapp:+<number>`. With
`LOG_LEVEL=debug`, dropped senders are logged with the id the bot saw
(`inbound dropped by access list`).

## Environment variables

| Variable | Default | Channel | Description |
| --- | --- | --- | --- |
| `AI_PROVIDER` | `ollama` | both | `ollama`, `anthropic`, `openai`, `gemini` or a preset (`deepseek`, `qwen`, `glm`, `kimi`, `groq`, `openrouter`, `mistral`, `grok`, `together`). |
| `AI_MODEL` | `llama3.1` for Ollama, otherwise the provider's default | both | Model id. It must support tool calling. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | both | Ollama server. |
| `AI_BASE_URL` | (none) | both | Endpoint override for any provider. Wins over `OLLAMA_URL`. |
| `AI_API_KEY` | (none) | both | API key. Optional: each SDK/preset also reads its own variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, ...). |
| `AI_TIMEOUT_MS` | `120000` | both | Timeout per model call. |
| `ALLOWED_USERS` | empty (everybody) | both | Comma-separated ids allowed to talk to the bot. |
| `GROUP_MODE` | `commands` | both | `all`, `mentions` or `commands`. |
| `LOG_LEVEL` | `info` | both | pino level. |
| `WA_SESSION` | `bakery` | Baileys | Session name (folder under `WA_SESSIONS_DIR`). |
| `WA_SESSIONS_DIR` | `sessions` | Baileys | Where sessions are stored. |
| `WA_PAIRING_PHONE` | (none) | Baileys | Log in with a pairing code for this number instead of the QR. |
| `TWILIO_ACCOUNT_SID` | **required** | Twilio | `AC...` |
| `TWILIO_AUTH_TOKEN` | **required** | Twilio | Also verifies webhook signatures. |
| `TWILIO_WHATSAPP_FROM` | `whatsapp:+14155238886` | Twilio | Sender (the sandbox by default). |
| `TWILIO_SMS_FROM` | (none) | Twilio | SMS sender, if you also want SMS chats. |
| `PUBLIC_URL` | **required** | Twilio | Public https base URL (tunnel or proxy). |
| `WEBHOOK_PATH` | `/twilio/webhook` | Twilio | Webhook path. |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Twilio | Where the HTTP server listens. |

Invalid values are all reported together at startup, by variable name and
never with the value. The startup log shows only non-secret settings.

## Side-effecting tools: the rules this example follows

These come from live tests with real models. The full guide is
[AI tool calling → Best practices for side-effecting tools](../../docs/guide/ai-tools.md#best-practices-for-side-effecting-tools):

1. **The model never computes money.** `quote_order` handles "how much is...?".
   `create_order`/`update_order` re-price in code and show the result through
   `confirmLines`, and every tool returns formatted totals for the model to
   repeat.
2. **Catalog values use `enum`**, validated before the confirmation.
3. **Every create comes with update, cancel and list tools**, so the model never
   "fixes" an order by placing another one.
4. **`dedupe: 'args'` on create.**
5. **Unknown ids return `{ error }`**, never a silent success.
6. **`confirm: true` on every side effect.** Read-only tools need none.
7. **The `@bot-wa/ai` system note stays on.** It tells the model the system asks
   for confirmation, so the model does not ask "shall I place it?" itself or
   claim actions no tool confirmed.

## Sample conversation

Real replies vary with the model. The confirmations and totals are produced by
code and always look like this:

```text
Customer: hi! what do you have?
Bot:      Hi! Today we have: Croissant $3.50, Cheese bread $2.50,
          Chocolate cake $28.00 and Coffee $3.00. What would you like?
Customer: how much would 2 croissants and a coffee be?
Bot:      2 croissants ($7.00) and a coffee ($3.00) come to $10.00.
Customer: great, I'll take that
Bot:      About to: Place order
          • 2 × Croissant: $7.00
          • 1 × Coffee: $3.00
          Total: $10.00
          Do you confirm? (yes/no)
Customer: yes
Bot:      Done! Your order B-1001 is placed. Total: $10.00.
Customer: actually make it 3 croissants
Bot:      About to: Change order
          Order B-1001
          • 3 × Croissant: $10.50
          • 1 × Coffee: $3.00
          Total: $13.50
          Do you confirm? (yes/no)
Customer: yes
Bot:      Updated: order B-1001 is now 3 croissants and a coffee, $13.50.
Customer: sorry, cancel it
Bot:      About to: Cancel order
          Order B-1001
          Do you confirm? (yes/no)
Customer: yes
Bot:      Order B-1001 is cancelled.
Customer: who won the world cup?
Bot:      Sorry, I can only help with Demo Bakery: our menu, prices and orders.
```

## Tests

```bash
pnpm --filter @bot-wa/example-bakery-ai test        # vitest, no network
pnpm --filter @bot-wa/example-bakery-ai typecheck
```

[`tests/bot.e2e.test.ts`](tests/bot.e2e.test.ts) runs the real bot on a
`MockProvider` with a scripted `MockAIProvider`. The fake model returns tool
calls from keywords, and the test checks the English confirmations, the
create → update → cancel cycle, dedupe, the `{ error }` path, enum
rejection, the allow-list and group mode.

## Using another AI provider

Set `AI_PROVIDER`/`AI_MODEL` (and `AI_API_KEY` or the SDK's variable). The
OpenAI-compatible presets and `openai` need the `openai` SDK, `anthropic` needs
`@anthropic-ai/sdk` and `gemini` needs `@google/generative-ai`. They are optional
peer dependencies of `@bot-wa/ai`, so add the one you use:

```bash
pnpm --filter @bot-wa/example-bakery-ai add openai            # openai + presets (deepseek, groq, ...)
pnpm --filter @bot-wa/example-bakery-ai add @anthropic-ai/sdk
```

A missing SDK or a bad key is logged at startup, and the bot replies with its
error message instead of crashing.

## Localization

The example is in English. To serve customers in another language:

1. **Persona.** Rewrite `PERSONA` in [`src/bot.ts`](src/bot.ts) in that language
   ("Answer briefly and in Spanish..."). It decides the language the model
   answers in. Translate `GREETING`, `errorMessage`, `refusalMessage` and the
   tool `title`s, which the customer sees in confirmations.
2. **Built-in texts** (the confirmation wrapper "About to: ... Do you confirm?
   (yes/no)", slash-command replies) come from the i18n catalog. Set
   `i18n: { defaultLocale: 'es' }` for the bundled Spanish texts, or register
   your own language with `bot.locale('fr', { ai: { tools: { confirm: '...' } }, core: { ... } })`.
   Accepted answers to a confirmation can be extended with
   `aiPlugin({ toolConfirm: { yes: [...], no: [...] } })`.
3. **Money and menu.** Change `CURRENCY`/`LOCALE` and the product names in
   [`src/shop.ts`](src/shop.ts). Keep the product **ids** stable, because the
   model and the schemas use them.

See the [i18n guide](../../docs/guide/i18n.md) for details.

## Going to production

- Replace `InMemoryOrderStore` with a database-backed `OrderStore`. Also give
  the `Bot` a persistent store (`@bot-wa/sqlite-store`, `@bot-wa/redis-store`, ...)
  so AI history and per-user memory survive restarts.
- On Twilio, use your own WhatsApp sender instead of the sandbox and a stable
  public URL (reverse proxy or named tunnel) instead of a quick tunnel.
- WhatsApp's terms only allow AI that serves the business. Keep the persona
  scoped.
