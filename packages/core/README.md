# @bot-wa/bot-wa-baileys

[![Docs](https://img.shields.io/badge/docs-TypeDoc-blue?logo=typescript&logoColor=white)](https://andresayac.github.io/bot-wa-baileys/)
[![npm](https://img.shields.io/npm/v/@bot-wa/bot-wa-baileys)](https://www.npmjs.com/package/@bot-wa/bot-wa-baileys)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/andresayac/bot-wa-baileys/blob/main/LICENSE.md)

Framework moderno para bots de WhatsApp sobre [Baileys 7](https://github.com/WhiskeySockets/Baileys). Un solo import, flows declarativos para empezar en 30 segundos y un runtime de conversaciones async para cuando necesites control total.

> **v2 es un rewrite del core.** Si vienes de la v1 (`BaileysClass`), lee la [guía de migración](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/MIGRATION-v1-to-v2.md) antes de actualizar — hay cambios de comportamiento, no solo de nombres.

## Instalación

```
npm i @bot-wa/bot-wa-baileys
```

Requiere **Node >= 20** (el paquete es ESM-only — ver la nota sobre ESM en la [guía de migración](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/MIGRATION-v1-to-v2.md#cambios-de-comportamiento-en-v2)).

## Quickstart (30 segundos)

```ts
import { Bot, flow } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({ session: 'mi-bot' })

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

Un ejemplo más completo (comandos, media, hooks, DI, scheduler) vive en [`examples/bot.ts`](examples/bot.ts).

¿Sin cámara para escanear el QR? Configura `new Bot({ session: 'mi-bot', pairingCode: '+57300XXXXXXX' })` (número en formato internacional completo) y escucha `bot.on('pairing_code', (code) => console.log(code))` — igual que en v1.

> **Flujos persistentes:** `flow(...).persistent()` solo sobrevive a un reinicio del proceso si el store está respaldado por un archivo. El `MemoryStore` por defecto vive en memoria; para conservar los checkpoints entre reinicios crea el bot con `new Bot({ storeConfig: { file: './store.json' } })`. Ver la [guía de migración](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/MIGRATION-v1-to-v2.md#flujos-persistentes-persistent).

## Características (v2)

- **Flows declarativos que compilan a runtime async** — `flow().say().ask().choose()` se compila a un `bot.conversation` real; ya no hay motor de "arrays de pasos" por separado.
- **Dispatcher por especificidad** — comandos (`/reset`) > conversación activa > matchers (`equals` normalizado por defecto, o `contains`/`startsWith`/`endsWith`) > catch-all; el primer handler que "consume" el mensaje gana.
- **Runtime de conversaciones async** — `c.ask`, `c.waitText`, `c.waitMedia`, `c.choose`, con validación, reintentos y timeouts configurables por espera.
- **Testing kit sin WhatsApp real** — `createTestBot()` desde `@bot-wa/bot-wa-baileys/testing`, con un `MockProvider` y aserciones sobre el outbox.
- **100% ESM + TypeScript estricto** — cero `any` en la API pública, Baileys 7 como motor de transporte.
- **Sin botones nativos** — están muertos en el protocolo actual de WhatsApp Web; usa menús numerados (`c.choose()` / `.choose()`) o `ctx.poll()`.
- **Hooks y plugins con DI** — `before`/`after`/`onError` como middleware, `bot.plug()` con `unplug()` automático, `bot.provide()` para inyectar dependencias.
- **Scheduler integrado** — `bot.schedule()` (cron), `bot.every()`, `bot.delay()`.
- **Sub-APIs tipadas** — `bot.groups`, `bot.profile`, `bot.privacy`, `bot.chats`, `bot.presence`.

## Documentación

- [Guía de migración v1 → v2](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/MIGRATION-v1-to-v2.md)
- [API (TypeDoc)](https://andresayac.github.io/bot-wa-baileys/)
- [`docs/public/llms.txt`](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/public/llms.txt) — resumen de la API pensado para pegar en el contexto de un LLM

## Acknowledgements

Este proyecto se inspiró en ideas y código del repositorio [bot-whatsapp](https://github.com/codigoencasa/bot-whatsapp) de codigoencasa. Su trabajo creando flujos de conversación automatizados y respuestas a preguntas frecuentes fue particularmente influyente. Agradecemos sus contribuciones a la comunidad open-source.

## Contribución

Si quieres contribuir a este proyecto, eres bienvenido. Cualquier mejora, corrección de bugs o nueva funcionalidad es bien recibida.

## Licencia

Este proyecto está licenciado bajo [MIT](https://github.com/andresayac/bot-wa-baileys/blob/main/LICENSE.md).
