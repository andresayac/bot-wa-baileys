# Deployment

How to run your bot in production, always connected.

## Option 1: VPS (recommended)

### 1. Prepare the server

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
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
FROM node:18-slim
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

### Session persistence

The WhatsApp session is saved in `./sessions/`. **Don't delete it** or you'll
need to scan the QR again.

### Backup

```bash
tar -czf session-backup.tar.gz sessions/
tar -xzf session-backup.tar.gz
```

### Logging

```js
const bot = new Bot({
  debug: false,  // true for verbose logs
})
```

## Next steps

- [FAQ](./faq) — common problems
- [API Reference](/api/) — technical docs