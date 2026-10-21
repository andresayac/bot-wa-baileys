# Simulador en la terminal (`botmesh dev`)

`botmesh dev` te deja chatear con tu bot en la terminal: sin número de
WhatsApp, sin teléfono y sin riesgo de baneo. Inyecta un provider en
memoria, así que nada sale del proceso, y recarga tu código al guardar.

```bash
npx botmesh dev src/bot.js
```

El comando `botmesh` viene con `@botmesh/core`. Los proyectos generados con
`create-botmesh` ya lo tienen como `npm run dev`.

## 1. El patrón factory (`defineBot`)

Tu módulo exporta por defecto una **factory** que recibe el provider y
devuelve el `Bot` sin arrancarlo. Quien ejecuta el archivo decide qué
provider inyectar:

```js
// src/bot.js
import { Bot, defineBot, flow, isMainModule } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

const createBot = defineBot((provider) => {
  const bot = new Bot({ provider })           // usa SIEMPRE el provider que recibes
  bot.when('hola', (ctx) => ctx.reply('¡Hola! 👋'))
  bot.use(flow('menu').ask('¿Tu nombre?', 'name').say((_ctx, c) => `Hola ${c.state.name}`))
  return bot                                   // no llames a bot.start() aquí
})
export default createBot

// npm start (node src/bot.js) → provider real. botmesh dev solo importa la factory.
if (isMainModule(import.meta)) {
  const bot = await createBot(new BaileysProvider({ session: 'my-bot' }))
  bot.on('qr', (qr) => bot.logger.info(qr))
  await bot.start()
}
```

- La factory puede ser async (`async (provider) => { ... }`).
- `isMainModule(import.meta)` usa `import.meta.main` (Node ≥ 22.18 / 24.2)
  o compara `process.argv[1]` (sin distinguir mayúsculas en Windows). Da
  `false` si un gestor de procesos importa tu archivo desde su propio
  wrapper (pm2 en modo ESM); en ese caso usa un archivo de arranque aparte
  que importe la factory.
- `botmesh dev` define la variable de entorno `BOT_WA_DEV=1` por si tu
  código necesita detectar el simulador.

## 2. Uso

```bash
npx botmesh dev src/bot.js                       # o "npm run dev" en proyectos de create-botmesh
npx botmesh dev src/bot.js --env-file .env       # carga variables (p. ej. ANTHROPIC_API_KEY para @botmesh/ai)
npx botmesh dev src/bot.ts                       # TypeScript con el type stripping nativo de Node
npx botmesh dev src/bot.js --user ana --name "Ana" --group equipo --no-watch
```

| Opción | Significado |
| --- | --- |
| `--user <id>` | id del remitente simulado (por defecto `user`) |
| `--name <nombre>` | nombre visible simulado (por defecto `Dev User`) |
| `--group <id>` | empezar dentro del chat de grupo `<id>` |
| `--env-file <ruta>` | cargar variables de entorno de un archivo; se puede repetir; si falta el archivo solo avisa |
| `--watch <dir>` | carpeta vigilada para la recarga (por defecto, la de la entry) |
| `--no-watch` | desactiva la recarga (`:reload` sigue funcionando) |
| `--color` / `--no-color` | fuerza colores sí o no (por defecto: auto; respeta `NO_COLOR`) |
| `-h`, `-v` | ayuda, versión |

Códigos de salida: `0` ok, `1` fallo en ejecución, `2` error de uso.

## 3. Comandos dentro del simulador

- Cualquier línea es un mensaje para el bot. Los comandos con barra
  (`/reset`) se envían como mensajes.
- `::texto` envía un texto que empieza por `:`. Un emoticono como `:)` es
  un mensaje normal.
- `:as <user> [nombre]` cambia de remitente (se queda en el mismo chat).
- `:group <id>` entra a un chat de grupo; menciona al bot como `@bot`.
  `:dm` vuelve al chat privado.
- `:media <image|video|audio|voice|document|sticker> <ruta> [caption]` envía
  un archivo del disco (alias: `photo`, `doc`, `file`, `ptt`; rutas con
  espacios entre comillas). Los bytes llegan vía
  `provider.downloadMedia(ref)`.
- `:click <n|id|label>` pulsa un botón, una fila de lista o un botón de
  card, o vota en el último poll (llega a `bot.on('poll')`).
- `:state` muestra quién eres, el estado del bot y la conversación activa
  (si espera respuesta y su `c.state`).
- `:reset` reinicia el bot desde cero (borra conversaciones y estado en
  memoria). `:reload` vuelve a importar el código. `:help`, `:quit`
  (también Ctrl+C o Ctrl+D).

Los botones, listas, cards y polls salen numerados (`[1] Info`); la media
sale como `[image: url]` con el caption en la línea siguiente. Los mensajes
del bot a otros chats salen como `bot → <chatId> › ...`.

Con la entrada por pipe (`printf 'hola\n' | npx botmesh dev src/bot.js --no-watch`),
cada línea espera a que el bot termine de reaccionar (hasta 30 s, para
cubrir llamadas a IA), así que el transcript sale en orden.

## 4. Recarga en caliente

- Al guardar un `.js/.mjs/.cjs/.ts/.mts/.cts/.jsx/.tsx` en la carpeta
  vigilada se para el bot actual (`bot.stop()`), se reimporta la entry y se
  crea un bot nuevo. Los imports relativos (`./flows/menu.js`) también se
  recargan; los paquetes (`@botmesh/core`, `node_modules`) no.
- Se ignoran `node_modules`, las carpetas que empiezan por punto,
  `sessions/`, `*_sessions`, `.json`, `.env` y los logs, para que escribir
  un store o credenciales nunca provoque un bucle.
- Si la recarga falla (p. ej. un error de sintaxis), sigue corriendo la
  versión anterior. Al recargar se pierden las conversaciones en memoria.
- Node no puede descargar módulos viejos, así que en sesiones muy largas la
  memoria crece: reinicia de vez en cuando. Cierra los recursos que crees
  fuera del bot (servidores, intervalos) en `bot.on('stopped', ...)`.

## 5. TypeScript

- Necesita el type stripping nativo de Node: viene activado en Node ≥ 22.18
  / 23.6. En Node 22.6–22.17 usa
  `NODE_OPTIONS=--experimental-strip-types npx botmesh dev src/bot.ts`.
- Los imports relativos deben llevar la extensión `.ts` real y los imports
  de solo tipos deben usar `import type`. Sin TSX, enums ni namespaces
  (salvo con transform-types).
- Si falta soporte, el CLI muestra estas opciones en lugar de un error
  críptico.

## 6. Seguridad

- Si la factory construye el `Bot` con otro provider en vez del que recibe,
  el simulador se niega a arrancarlo (podría conectar de verdad), para ese
  bot y se detiene: nunca vuelve a llamar a la factory y, en modo watch, el
  CLI sale con código 1.
- Un export por defecto que no se creó con `defineBot()` recibe un aviso
  (una sola vez).
- Si la entry se ejecuta pero no exporta una factory (un `bot.js` antiguo
  que arranca solo al importarse), `botmesh dev` termina el proceso, aunque
  esté en modo watch, para cerrar cualquier conexión real que haya abierto.

## 7. API programática (`@botmesh/core/dev`)

```ts
import { DevSession } from '@botmesh/core/dev'

const session = new DevSession({ load: () => import('./bot.js'), write: (t) => process.stdout.write(t) })
await session.start()
await session.handleLine('hola')
await session.handleLine(':state')
await session.stop()
```

- `DevSession` no hace I/O por sí misma; inyecta `load` y `write`. Entre
  sus opciones están `user`, `name`, `group`, `echo`,
  `settleMs`/`maxSettleMs` y `onHalt`.
- `DevProvider` extiende `MockProvider` con `onOutbound`, `injectMedia` e
  `injectPollVote`.
- También se exportan funciones puras: `renderOutbound`, `parseDevInput`,
  `watchForChanges` y `runCli(argv, io)` con streams inyectables.

Novedades relacionadas en el core: `bot.inspectConversation({ from, sender, isGroup })`
devuelve `{ key, state, waiting, queued, accepts? }` o `undefined` (`state` es una
copia superficial; `accepts` dice qué acepta la espera pendiente: `'text'`, la lista
de tipos de `waitMedia` o `'any'` en `choose`/`waitAny`), y `bot.isBusy()` dice si el bot sigue atendiendo un
evento o ejecutando un paso de conversación.

## Siguientes pasos

- [Testing](./testing)
- [Inspeccionar y validar flujos](./inspeccion-flujos)
