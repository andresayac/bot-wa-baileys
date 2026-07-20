# Despliegue

Cómo poner tu bot en producción para que esté siempre conectado.

## Opción 1: VPS (recomendado)

La forma más simple: un servidor Linux con Node.js.

### 1. Preparar el servidor

```bash
# Instalar Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm

# Clonar tu bot
git clone https://github.com/tu-usuario/mi-bot.git
cd mi-bot
pnpm install
```

### 2. Primera conexión (escanear QR)

```bash
node bot.js
# Escanea el QR con tu teléfono
# Verás "✅ ¡Bot conectado!"
# Ctrl+C para detener
```

La sesión se guarda en `./sessions/`. No necesitas escanear el QR de nuevo.

### 3. Ejecutar con PM2 (siempre activo)

```bash
npm install -g pm2
pm2 start bot.js --name mi-bot
pm2 save
pm2 startup  # sigue las instrucciones para auto-iniciar en boot
```

### Comandos útiles de PM2

```bash
pm2 status          # ver estado
pm2 logs mi-bot     # ver logs
pm2 restart mi-bot  # reiniciar
pm2 stop mi-bot     # detener
pm2 delete mi-bot   # eliminar
```

## Opción 2: Docker

### Dockerfile

```dockerfile
FROM node:18-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY . .

# Crear carpeta de sesiones
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
      - ./sessions:/app/sessions  # persistir sesión
    environment:
      - NODE_ENV=production
```

### Ejecutar

```bash
docker compose up -d
docker compose logs -f  # ver logs (escanea el QR la primera vez)
```

## Opción 3: Screen / Tmux (simple, sin PM2)

```bash
# Crear sesión screen
screen -S mi-bot

# Ejecutar el bot
node bot.js

# Salir sin detener: Ctrl+A, luego D
# Volver a entrar:
screen -r mi-bot
```

## Consideraciones

### Persistencia de sesión

La sesión de WhatsApp se guarda en `./sessions/`. **No la borres** o tendrás
que escanear el QR de nuevo.

```js
const bot = new Bot({
  session: 'mi-bot',
  sessionsDir: './sessions',  // ← esta carpeta
})
```

### Backup de sesión

```bash
# Respaldar
tar -czf session-backup.tar.gz sessions/

# Restaurar
tar -xzf session-backup.tar.gz
```

### Variables de entorno

```bash
# .env
NODE_ENV=production
BOT_SESSION=mi-bot
```

```js
const bot = new Bot({
  session: process.env.BOT_SESSION || 'mi-bot',
})
```

### Logging

```js
const bot = new Bot({
  debug: false,  // true para logs detallados
})
```

En producción, usa `debug: false` y un logger como pino con transporte a archivo.

### Reinicio automático

PM2 y Docker reinician automáticamente si el bot crashea. Si usas screen/tmux,
necesitas un script:

```bash
#!/bin/bash
while true; do
  node bot.js
  echo "Bot crasheó, reiniciando en 5s..."
  sleep 5
done
```

## Siguientes pasos

- [Preguntas frecuentes](./faq) — problemas comunes
- [API Reference](/api/) — documentación técnica