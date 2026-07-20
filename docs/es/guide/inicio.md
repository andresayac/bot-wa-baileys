# Instalación

## Requisitos

- **Node.js** 18 o superior ([descargar](https://nodejs.org/))
- **pnpm** (recomendado) o npm/yarn
- Un teléfono con WhatsApp activo

::: tip ¿No tienes pnpm?
Instálalo con:
```bash
npm install -g pnpm
```
:::

## Paso 1 — Instalar el framework

Crea una carpeta para tu bot e instala el paquete:

```bash
mkdir mi-bot
cd mi-bot
pnpm init
pnpm add @bot-wa/bot-wa-baileys
```

## Paso 2 — Crear el archivo del bot

Crea un archivo `bot.js` (o `bot.ts` si usas TypeScript):

```js
const { Bot } = require('@bot-wa/bot-wa-baileys')

const bot = new Bot({
  session: 'mi-bot',
  qr: { terminal: true, small: true },
})

bot.on('ready', () => console.log('✅ ¡Bot conectado!'))

bot.when('hola', async (ctx) => {
  await ctx.reply('👋 ¡Hola! Soy tu bot.')
})

bot.start()
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

¡Listo! Tu bot está conectado. Envía "hola" desde otro teléfono y recibirás la respuesta.

::: warning No escanees con el mismo teléfono
El QR se escanea con el teléfono que **será el bot**, no con el que le enviará mensajes. Si escaneas con tu teléfono personal, ese teléfono se convierte en el bot.
:::

## Siguientes pasos

- [Tu primer bot](./primer-bot) — un bot completo con comandos, media y flujos
- [Conceptos básicos](./conceptos) — entiende cómo funciona todo
- [Ejemplos](/es/ejemplos/mensajes) — recetas listas para copiar