# Despliegue

Cómo ejecutar tu bot en producción, siempre conectado.

::: tip Solo ESM, Node >= 20
`@bot-wa/bot-wa-baileys` es ESM puro — no hay build de CommonJS. Asegúrate
de que el `package.json` de producción tenga `"type": "module"` (o que tu
entrypoint use `.mjs`), y que el runtime sea **Node >= 20**.
:::

## Opción 1: VPS (recomendado)

### 1. Preparar el servidor

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm

git clone https://github.com/your-user/my-bot.git
cd my-bot
pnpm install
```

### 2. Primera conexión (escanear el QR)

```bash
node bot.js
# Escanea el QR, luego Ctrl+C
```

La sesión se guarda en `./sessions/`. No necesitas escanear de nuevo.

### 3. Ejecutar con PM2 (siempre activo)

```bash
npm install -g pm2
pm2 start bot.js --name my-bot
pm2 save
pm2 startup  # sigue las instrucciones para auto-iniciar en el arranque
```

### Comandos de PM2

```bash
pm2 status          # estado
pm2 logs my-bot     # logs
pm2 restart my-bot  # reiniciar
pm2 stop my-bot     # detener
```

## Opción 2: Docker

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
docker compose logs -f  # escanea el QR la primera vez
```

## Opción 3: Screen / Tmux

```bash
screen -S my-bot
node bot.js
# Salir sin detener: Ctrl+A, luego D
# Volver a entrar: screen -r my-bot
```

## Consideraciones

### Persistencia de sesión (auth)

Las credenciales de inicio de sesión de WhatsApp se guardan bajo
`sessionsDir/session` (por defecto `./sessions/<session>`). **No la
borres** o tendrás que escanear el QR de nuevo:

```ts
const bot = new Bot({ session: 'my-bot', sessionsDir: './sessions' })
```

### Persistencia del store (conversaciones e historial)

El `MemoryStore` por defecto vive solo en memoria. Si usas
`flow(...).persistent()` en algún lugar, sus checkpoints no sobrevivirán a
un reinicio del proceso a menos que respaldes el store con un archivo:

```ts
const bot = new Bot({
  storeConfig: { file: './store.json' },
})
```

Respalda la carpeta y el archivo juntos — son lo que le permite a un bot
redesplegado continuar sin volver a escanear el QR ni perder conversaciones
en curso:

```bash
tar -czf backup.tar.gz sessions/ store.json
tar -xzf backup.tar.gz
```

### Apagado ordenado

`bot.stop()` desmonta el provider y aborta las conversaciones activas (los
checkpoints persistentes se conservan si el store tiene un archivo
detrás):

```ts
process.on('SIGINT', async () => {
  await bot.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await bot.stop()
  process.exit(0)
})
```

### Logging

```ts
const bot = new Bot({
  debug: false,  // true para logs detallados
})
```

## Siguientes pasos

- [Preguntas frecuentes](./faq) — problemas comunes
- [API Reference](/api/) — documentación técnica
