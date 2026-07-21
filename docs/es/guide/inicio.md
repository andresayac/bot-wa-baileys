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

::: warning Paquetes solo ESM
`@bot-wa/core` y los paquetes de transporte se distribuyen como **ESM
puro** — no hay build de CommonJS. Tu proyecto necesita `"type": "module"`
en su `package.json` (o una extensión de archivo `.mjs`). En Node
**>= 22.12** también puedes hacer `require()` gracias al soporte
experimental `require(esm)` de Node, pero los ejemplos de abajo usan
`import` normal.
:::

## Paso 1 — Instalar el framework

El motor (`@bot-wa/core`) es agnóstico de transporte: lo emparejas con un
paquete **provider**. Para WhatsApp vía Baileys 7 (no oficial, login por QR):

```bash
mkdir my-bot
cd my-bot
pnpm init
pnpm add @bot-wa/core @bot-wa/baileys
```

Otros transportes detrás del mismo contrato `IProvider`:

| Transporte | Paquete | Notas |
|---|---|---|
| WhatsApp (Baileys 7) | `@bot-wa/baileys` | No oficial, login por QR — el que usa esta guía |
| WhatsApp Cloud API | `@bot-wa/meta` | API oficial de Meta, por webhook, sin riesgo de baneo |
| Telegram | `@bot-wa/telegram` | Bot API, long-poll o webhook |
| Discord | `@bot-wa/discord` | Gateway websocket + REST |

Luego agrega `"type": "module"` al `package.json` generado para que Node
trate tus archivos como ESM:

```json
{
  "type": "module"
}
```

## Paso 2 — Crear tu bot

Crea un archivo `bot.js`. En v2, crear un bot **requiere un provider** —
las opciones de sesión/auth de WhatsApp viven en el provider, no en el bot:

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

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

## Otros transportes, mismo código de bot

Solo cambia el provider — `when`/`flow`/hooks/plugins son idénticos en
todos los transportes. Para la Cloud API oficial de WhatsApp:

```ts
import { Bot } from '@bot-wa/core'
import { CloudAPIProvider } from '@bot-wa/meta'

const bot = new Bot({
  provider: new CloudAPIProvider({
    accessToken: process.env.META_ACCESS_TOKEN,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    verifyToken: process.env.META_VERIFY_TOKEN,
  }),
})
```

(La Cloud API es por webhook: haz POST de los payloads entrantes a
`provider.ingest(body, headers)` desde tu servidor HTTP.) Ver
[`@bot-wa/telegram`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/telegram-provider)
y [`@bot-wa/discord`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/discord-provider)
para los otros transportes.

## Siguientes pasos

- [Tu primer bot](./primer-bot) — un bot completo con comandos, media y flujos
- [Conceptos básicos](./conceptos) — entiende cómo funciona todo
- [Ejemplos](/es/ejemplos/mensajes) — recetas listas para copiar
