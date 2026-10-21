# Instalación

## Requisitos

- **Node.js** 22 o superior ([descargar](https://nodejs.org/))
- **pnpm** (recomendado) o npm/yarn
- Un teléfono con WhatsApp (para el transporte Baileys)

::: tip ¿No tienes pnpm?
Instálalo con:
```bash
npm install -g pnpm
```
:::

::: warning Paquetes solo ESM
`@botmesh/core` y los paquetes de transporte se distribuyen como **ESM
puro** — no hay build de CommonJS. Tu proyecto necesita `"type": "module"`
en su `package.json` (o una extensión de archivo `.mjs`). En Node
**>= 22.12** también puedes hacer `require()` gracias al soporte
experimental `require(esm)` de Node, pero los ejemplos de abajo usan
`import` normal.
:::

::: warning Alpha — primera publicación en npm pendiente
botmesh está en **alpha** y **ningún paquete `@botmesh/*` está en npm
todavía**: la primera publicación se está preparando. Los comandos
`pnpm add` de este sitio son los que funcionarán cuando salga, **con el tag
`@alpha`** (`changeset publish` crea el dist-tag `alpha`, no `latest`, así que
una instalación sin tag no resuelve). Mientras tanto, clona
[el repositorio](https://github.com/andresayac/botmesh) y usa
los paquetes desde el workspace de pnpm (`workspace:*`).
:::

## Crear un proyecto con create-botmesh

La forma más rápida de empezar es la CLI `create-botmesh`, que genera un
proyecto listo para ejecutar (forma parte de la misma alpha, así que hasta la
primera publicación ejecútala desde el monorepo apuntando **fuera** del repo:
`pnpm --filter create-botmesh build && node packages/create-botmesh/lib/cli.js ../my-bot`;
un destino dentro del monorepo de botmesh se rechaza salvo que pases `--force`):

```bash
npm create botmesh@alpha my-bot
npm create botmesh@alpha my-bot -- --template telegram --yes
```

| Plantilla | Qué obtienes |
| --- | --- |
| `baileys` (por defecto) | WhatsApp vía Baileys: escaneas un QR para vincular |
| `meta` | WhatsApp Cloud API (webhook; necesita credenciales de Meta y una URL pública) |
| `telegram` | Telegram Bot API (long-polling; necesita un token de @BotFather) |
| `ai` | Baileys + autorespondedor de soporte con `@botmesh/ai` limitado al negocio (`ANTHROPIC_API_KEY`) |
| `games` | Adivina el número, ahorcado, trivia, tres en raya, piedra-papel-tijera; puntuaciones en `ctx.user` |
| `support` | Tickets por usuario, menú de FAQ y handoff a humano |
| `store` | Catálogo, carrito por usuario con TTL de 7 días y flujo de checkout |
| `restaurant` | Menú, pedidos a domicilio o para recoger, "repetir mi último pedido", reservas de mesa |
| `clinic` | Agenda de citas (especialidad, día, hora), listar y cancelar citas |
| `ai-full` | IA limitada al negocio + intents por palabra clave/regex + store SQLite + scheduler + comandos slash + handoff (`ANTHROPIC_API_KEY`) |

Las plantillas de casos de uso (de `games` a `ai-full`) usan Baileys.

| Flag | Significado |
| --- | --- |
| `-t, --template <name>` | Una de las plantillas de arriba (`baileys` en modo no interactivo) |
| `--name <name>` | Nombre del paquete (por defecto, el del directorio) |
| `-y, --yes` | Omite las preguntas y usa los valores por defecto |
| `--overwrite` | Permite generar en un directorio que no está vacío |
| `--force` | Permite un directorio dentro del propio monorepo de botmesh (rechazado por defecto) |
| `-h, --help` | Muestra la ayuda |

Cada proyecto incluye `package.json` (con `npm start` y `npm run dev`, el
[simulador en la terminal](/es/guide/simulador)), `src/bot.js`,
`.env.example`, `.gitignore`, `README.md` y un **`AGENTS.md`** con
instrucciones para agentes de código con IA: la API v2 actual, lo que no
existe (`addAnswer`, `capture`...) y los comandos que hay que ejecutar.

El `package.json` generado depende de las versiones en npm de los paquetes
`@botmesh/*` (`^2.0.0-alpha.1` para el core, `^0.1.0` para el resto), así que
su `npm install` solo funciona tras la primera publicación. Mientras tanto,
apunta esas dependencias a tu copia local del monorepo.

Si prefieres montarlo todo a mano, sigue los pasos de abajo.

## Paso 1 — Instalar el framework

El motor (`@botmesh/core`) es agnóstico de transporte: lo emparejas con un
paquete **provider**. Para WhatsApp vía Baileys 7 (no oficial, login por QR):

```bash
mkdir my-bot
cd my-bot
pnpm init
pnpm add @botmesh/core@alpha @botmesh/baileys@alpha
```

Otros transportes detrás del mismo contrato `IProvider`:

| Transporte | Paquete | Estado | Notas |
|---|---|---|---|
| WhatsApp (Baileys 7) | `@botmesh/baileys` | Alpha | No oficial, login por QR — el que usa esta guía |
| WhatsApp Cloud API | `@botmesh/meta` | Alpha | API oficial de Meta, por webhook, sin riesgo de baneo |
| Telegram | `@botmesh/telegram` | Alpha | Bot API, long-poll o webhook |
| Facebook Messenger | `@botmesh/messenger` | Experimental | Send API de Meta Graph, por webhook |
| Instagram DM | `@botmesh/instagram` | Experimental | Meta Graph, por webhook |
| Discord | `@botmesh/discord` | Experimental | Gateway websocket + REST |

Los paquetes **Alpha** forman parte de la primera alpha publicable. Los
**Experimental** son implementaciones reales y con tests que de momento siguen
siendo privadas (sin publicar) y pueden cambiar. Hay más providers
experimentales (Evolution API, WPPConnect, Twilio, HighLevel, Gupshup, Email y
TikTok) y una matriz de capacidades en [Canales](/es/guide/canales).

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
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

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
import { Bot } from '@botmesh/core'
import { CloudAPIProvider } from '@botmesh/meta'

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
desarrollo local aislado.) Consulta [Canales](/es/guide/canales) para el
resto de transportes y [Servidor de webhooks](/es/guide/servidor) para montar
los providers por webhook.

## Siguientes pasos

- [Tu primer bot](./primer-bot) — un bot completo con comandos, media y flujos
- [Conceptos básicos](./conceptos) — entiende cómo funciona todo
- [Simulador en la terminal](./simulador) — chatea con tu bot sin teléfono (`npx botmesh dev src/bot.js`)
- [Ejemplos](/es/ejemplos/mensajes) — recetas listas para copiar
