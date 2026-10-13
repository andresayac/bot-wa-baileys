# @bot-wa/core

[![Docs](https://img.shields.io/badge/docs-guides-blue)](https://github.com/andresayac/bot-wa-baileys/tree/main/docs)
[![npm](https://img.shields.io/npm/v/@bot-wa/core)](https://www.npmjs.com/package/@bot-wa/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/andresayac/bot-wa-baileys/blob/main/LICENSE.md)

Motor de bots **agnóstico de transporte**: flows declarativos para empezar en 30 segundos, un runtime de conversaciones async para control total, hooks/plugins/DI y scheduler. Tú inyectas el transporte (WhatsApp vía [`@bot-wa/baileys`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/baileys-provider); Telegram/Discord usan el mismo contrato `IProvider`).

> **v2 es un rewrite transport-agnostic.** Si vienes de la v1 (`BaileysClass`), lee la [guía de migración](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/MIGRATION-v1-to-v2.md).

## Instalación

```
npm i @bot-wa/core @bot-wa/baileys
```

Requiere **Node >= 22** (ESM-only). El core no tiene dependencias de transporte — las instala el paquete del transporte que uses.

## Quickstart (30 segundos)

```ts
import { Bot, flow } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({
  provider: new BaileysProvider({
    session: 'mi-bot',
    qr: { terminal: true },        // muestra el QR en la terminal
  }),
})

bot.when('hola', (ctx) => ctx.reply('👋 ¡Hola!'))

bot.use(
  flow('registrar')
    .say('📝 Vamos a registrarte')
    .ask('¿Tu nombre?', 'name')
    .say((_ctx, c) => `✅ Hola ${c.state.name}`)
)

// Avanzado: conversación async con control total
bot.conversation('soporte', async (c, ctx) => {
  await ctx.reply('Describe tu problema')
  const problema = await c.waitText({ timeout: '2m' })
  await ctx.reply(`🎫 Registrado: ${problema}`)
})

await bot.start()   // escanea el QR
```

Un ejemplo completo (comandos, media, hooks, DI, scheduler) vive en [`packages/baileys-provider/examples/bot.ts`](../baileys-provider/examples/bot.ts).

¿Sin cámara? Configura `pairingCode: '+57300XXXXXXX'` en el `BaileysProvider` (formato internacional completo) y escucha `bot.on('qr', ...)` — el código de emparejamiento llega por ahí también.

> **Flujos persistentes:** `flow(...).persistent()` solo sobrevive a un reinicio si el store es persistente. El `MemoryStore` por defecto vive en memoria; para conservar los checkpoints usa un store con disco (p.ej. [`@bot-wa/sqlite-store`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/sqlite-store)).

## Características (v2)

- **Motor transport-agnostic** — el core no conoce WhatsApp: `IProvider` normaliza entrada (`InboundEvent`) y salida (`OutboundContent`); cada transporte resuelve su propia identidad internamente.
- **Flows declarativos que compilan a runtime async** — `flow().say().ask().choose()` se compila a un `bot.conversation` real.
- **Dispatcher por especificidad** — comandos (`/reset`) > conversación activa > matchers (`equals` normalizado por defecto, o `contains`/`startsWith`/`endsWith`) > catch-all.
- **Runtime de conversaciones async** — `c.ask`, `c.waitText`, `c.waitMedia`, `c.choose`, con validación, reintentos y timeouts por espera.
- **Interacciones proyectadas** — clics de botón/slash llegan como un mensaje `type: 'buttons'` con `ctx.acknowledge()` (no-op en WhatsApp).
- **Validación de config en runtime** — el constructor lanza `ConfigValidationError` con mensaje claro.
- **Group mode** — `config.groupMode: 'all' | 'mentions' | 'commands'`.
- **Graceful shutdown con drain** — `bot.stop({ drain: true })` espera envíos en vuelo.
- **Testing kit sin transporte real** — `createTestBot()` desde `@bot-wa/core/testing`, con un `MockProvider` v2 y aserciones sobre el outbox.
- **Hooks y plugins con DI** — `before`/`after`/`onError`, `bot.plug()`/`unplug()`, `bot.provide()`.
- **Scheduler integrado** — `bot.schedule()` (cron), `bot.every()`, `bot.delay()`.
- **100% ESM + TypeScript estricto.**

> Nota: las sub-APIs de gestión de WhatsApp (`bot.groups/profile/privacy/chats/presence`) se movieron al transporte y se re-expondrán como namespaces del provider próximamente.

## Store persistente (SQLite)

El `MemoryStore` por defecto es ideal para desarrollo. Para producción usa el paquete [`@bot-wa/sqlite-store`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/sqlite-store):

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})
```

## Group Mode

```ts
const bot = new Bot({
  provider,
  groupMode: 'mentions',  // solo responde si lo @mencionan
  // groupMode: 'commands',  // solo responde a comandos
  // groupMode: 'all',       // responde a todo (default)
})
```

## Documentación

- [Guía de migración v1 → v2](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/MIGRATION-v1-to-v2.md)
- API (TypeDoc): generate it locally with `pnpm docs:api` (output in `docs/api/`)

## Acknowledgements

Inspirado en ideas y código de [bot-whatsapp](https://github.com/codigoencasa/bot-whatsapp) de codigoencasa.

## Licencia

[MIT](https://github.com/andresayac/bot-wa-baileys/blob/main/LICENSE.md) © Andres Aya
