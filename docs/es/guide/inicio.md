# Instalación

## Requisitos

- **Node.js** 22 o superior ([descargar](https://nodejs.org/))
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

::: warning Alpha — primera publicación en npm pendiente
bot-wa está en **alpha** y **ningún paquete `@bot-wa/*` está en npm
todavía**: la primera publicación se está preparando. Los comandos
`pnpm add` de este sitio son los que funcionarán cuando salga. Mientras tanto,
clona [el repositorio](https://github.com/andresayac/bot-wa-baileys) y usa
los paquetes desde el workspace de pnpm (`workspace:*`).
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

| Transporte | Paquete | Estado | Notas |
|---|---|---|---|
| WhatsApp (Baileys 7) | `@bot-wa/baileys` | Alpha | No oficial, login por QR — el que usa esta guía |
| WhatsApp Cloud API | `@bot-wa/meta` | Alpha | API oficial de Meta, por webhook, sin riesgo de baneo |
| Telegram | `@bot-wa/telegram` | Alpha | Bot API, long-poll o webhook |
| Facebook Messenger | `@bot-wa/messenger` | Experimental | Send API de Meta Graph, por webhook |
| Instagram DM | `@bot-wa/instagram` | Experimental | Meta Graph, por webhook |
| Discord | `@bot-wa/discord` | Experimental | Gateway websocket + REST |

Los paquetes **Alpha** forman parte de la primera alpha publicable. Los
**Experimental** son implementaciones reales y con tests que de momento siguen
siendo privadas (sin publicar) y pueden cambiar.

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
    appSecret: process.env.META_APP_SECRET, // obligatorio: verifica X-Hub-Signature-256
  }),
})
```

(La Cloud API es por webhook: pasa el body **crudo** de cada POST entrante a
`provider.ingest(rawBody, headers)` desde tu servidor HTTP — la firma se
calcula sobre los bytes exactos que envió Meta. Sin `appSecret` el
constructor lanza un error; `allowUnsignedWebhooks: true` existe solo para
desarrollo local aislado.) Ver
[`@bot-wa/telegram`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/telegram-provider)
y [`@bot-wa/discord`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/discord-provider)
(experimental) para los otros transportes.

## Siguientes pasos

- [Tu primer bot](./primer-bot) — un bot completo con comandos, media y flujos
- [Conceptos básicos](./conceptos) — entiende cómo funciona todo
- [Ejemplos](/es/ejemplos/mensajes) — recetas listas para copiar
