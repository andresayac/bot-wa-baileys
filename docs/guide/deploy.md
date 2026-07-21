# Deployment

How to run your bot in production, always connected.

::: tip ESM-only, Node >= 20
`@bot-wa/core` and the transport packages are pure ESM — no CommonJS build.
Make sure your production `package.json` has `"type": "module"` (or your
entrypoint uses `.mjs`), and that the runtime is **Node >= 20**.
:::

## Option 1: VPS (recommended)

### 1. Prepare the server

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm

git clone https://github.com/your-user/my-bot.git
cd my-bot
pnpm install
```

### 2. First connection (scan QR)

```bash
node bot.js
# Scan the QR, then Ctrl+C
```

The session is saved in `./sessions/`. You don't need to scan again.

### 3. Run with PM2 (always on)

```bash
npm install -g pm2
pm2 start bot.js --name my-bot
pm2 save
pm2 startup  # follow instructions for auto-start on boot
```

### PM2 commands

```bash
pm2 status          # status
pm2 logs my-bot     # logs
pm2 restart my-bot  # restart
pm2 stop my-bot     # stop
```

## Option 2: Docker

### Dockerfile

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .
RUN mkdir -p /app/sessions
CMD ["node", "bot.js"]
```

### docker-compose.yml

```yaml
version: '3.8'
services:
  bot:
    build: .
    restart: unless-stopped
    volumes:
      - ./sessions:/app/sessions
      - ./store.json:/app/store.json
    environment:
      - NODE_ENV=production
```

```bash
docker compose up -d
docker compose logs -f  # scan QR first time
```

## Option 3: Screen / Tmux

```bash
screen -S my-bot
node bot.js
# Detach: Ctrl+A, then D
# Reattach: screen -r my-bot
```

## Considerations

### Session persistence (auth)

The WhatsApp login credentials are saved under
`sessionsDir/session` (defaults to `./sessions/<session>`) by the Baileys
provider. **Don't delete it** or you'll need to scan the QR again:

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot', sessionsDir: './sessions' }),
})
```

### Store persistence (conversations & history)

The default `MemoryStore` lives in memory only. For production, use **`SQLiteStore`** — a real database that persists messages, chats, contacts, flow state, checkpoints and AI conversations:

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})
```

With `SQLiteStore`, `flow(...).persistent()` checkpoints survive restarts automatically. See the [Persistent Store guide](./store) for details.

Back up both directories/files together — they're what let a redeployed bot resume without re-scanning the QR or losing in-flight conversations:

```bash
tar -czf backup.tar.gz sessions/ data/
tar -xzf backup.tar.gz
```

### Graceful shutdown

`bot.stop()` tears down the provider and aborts active conversations. Use `{ drain: true }` to **wait for in-flight sends** before closing (prevents lost messages during deploys):

```ts
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...')
  await bot.stop({ drain: true, timeout: 15_000 }) // wait up to 15s for pending sends
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await bot.stop({ drain: true, timeout: 15_000 })
  process.exit(0)
})
```

| Option | Type | Default | Description |
|---|---|---|---|
| `drain` | `boolean` | `false` | Wait for in-flight sends to complete |
| `timeout` | `number` | `10000` | Max ms to wait for drain before forcing stop |

### Logging

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot', debug: false }), // true for verbose logs
})
```

## Next steps

- [FAQ](./faq) — common problems
- [API Reference](/api/) — technical docs
