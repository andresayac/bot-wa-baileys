# Despliegue

Cómo ejecutar tu bot en producción, siempre conectado.

::: tip Solo ESM, Node >= 22
`@bot-wa/core` y los paquetes de transporte son ESM puro — no hay build de
CommonJS. Asegúrate de que el `package.json` de producción tenga
`"type": "module"` (o que tu entrypoint use `.mjs`), y que el runtime sea
**Node >= 22**.
:::

## Opción 1: VPS (recomendado)

### 1. Preparar el servidor

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
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
FROM node:22-slim
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
`sessionsDir/session` (por defecto `./sessions/<session>`) por el provider
de Baileys. **No la borres** o tendrás que escanear el QR de nuevo:

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot', sessionsDir: './sessions' }),
})
```

### Persistencia del store (conversaciones e historial)

El `MemoryStore` por defecto vive solo en memoria. Para producción, usa **`SQLiteStore`** — una base de datos real que persiste mensajes, chats, contactos, estado de flujos, checkpoints y conversaciones AI:

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})
```

Con `SQLiteStore`, los checkpoints de `flow(...).persistent()` sobreviven reinicios automáticamente. Ver la [guía de Store Persistente](./store) para más detalles.

Respalda la carpeta y el archivo juntos — son lo que le permite a un bot redesplegado continuar sin volver a escanear el QR ni perder conversaciones en curso:

```bash
tar -czf backup.tar.gz sessions/ data/
tar -xzf backup.tar.gz
```

### Apagado ordenado

`bot.stop()` desmonta el provider y aborta las conversaciones activas. Usa `{ drain: true }` para **esperar los envíos en vuelo** antes de cerrar (evita mensajes perdidos durante deploys):

```ts
process.on('SIGINT', async () => {
  console.log('Apagando ordenadamente...')
  await bot.stop({ drain: true, timeout: 15_000 }) // espera hasta 15s por envíos pendientes
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await bot.stop({ drain: true, timeout: 15_000 })
  process.exit(0)
})
```

| Opción | Tipo | Default | Descripción |
|---|---|---|---|
| `drain` | `boolean` | `false` | Esperar a que los envíos en vuelo terminen |
| `timeout` | `number` | `10000` | Máx ms a esperar por el drain antes de forzar el cierre |

### Logging

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot', debug: false }), // true para logs detallados
})
```

## Siguientes pasos

- [Preguntas frecuentes](./faq) — problemas comunes
- [API Reference](/api/) — documentación técnica
