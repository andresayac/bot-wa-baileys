# Instalación

## Requisitos

- **Node.js** 20 o superior ([descargar](https://nodejs.org/))
- **pnpm** (recomendado) o npm/yarn
- Un teléfono con WhatsApp

::: tip ¿No tienes pnpm?
Instálalo con:
```bash
npm install -g pnpm
```
:::

::: warning Paquete solo ESM
`@bot-wa/bot-wa-baileys` se distribuye como **ESM puro** — no hay build de
CommonJS. Tu proyecto necesita `"type": "module"` en su `package.json` (o
una extensión de archivo `.mjs`). En Node **>= 22.12** también puedes
hacer `require()` gracias al soporte experimental `require(esm)` de Node,
pero los ejemplos de abajo usan `import` normal.
:::

## Paso 1 — Instalar el framework

```bash
mkdir my-bot
cd my-bot
pnpm init
pnpm add @bot-wa/bot-wa-baileys
```

Luego agrega `"type": "module"` al `package.json` generado para que Node
trate tus archivos como ESM:

```json
{
  "type": "module"
}
```

## Paso 2 — Crear tu bot

Crea un archivo `bot.js`:

```ts
import { Bot } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({
  session: 'my-bot',
  qr: { terminal: true, small: true },
})

bot.on('ready', () => console.log('✅ Bot connected!'))

bot.when('hola', async (ctx) => {
  await ctx.reply('👋 Hello! I am your bot.')
})

await bot.start()
```

## Paso 3 — Ejecutar y escanear el QR

```bash
node bot.js
```

Verás un código QR en tu terminal. Ábrelo en tu teléfono:

1. Abre **WhatsApp**
2. Ve a **Configuración → Dispositivos vinculados**
3. Toca **Vincular un dispositivo**
4. Escanea el código QR

¡Listo! Tu bot está conectado. Envía "hola" (exactamente, ese es el modo de
coincidencia por defecto) desde otro teléfono y recibirás una respuesta.

::: warning No escanees con el mismo teléfono
El QR se escanea con el teléfono que **será el bot**, no con el que envía los mensajes.
:::

## Siguientes pasos

- [Tu primer bot](./primer-bot) — un bot completo con comandos, media y flujos
- [Conceptos básicos](./conceptos) — entiende cómo funciona todo
- [Ejemplos](/es/ejemplos/mensajes) — recetas listas para copiar
