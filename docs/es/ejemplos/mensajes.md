# Enviar mensajes

Recetas prácticas para responder a mensajes de texto.

## Configuración

```ts
import { Bot } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })
```

## Responder a un texto

```ts
bot.when('hi', async (ctx) => {
  await ctx.reply('👋 Hello!')
})
```

## Varias palabras clave

```ts
bot.when(['bye', 'goodbye', 'see you'], async (ctx) => {
  await ctx.reply('👋 See you later!')
})
```

## Coincidencia con regex

```ts
bot.when(/\d{4,}/, async (ctx) => {
  await ctx.reply(`🔢 Detected a long number: "${ctx.body}"`)
})

bot.when(/[\w.]+@[\w.]+\.\w+/, async (ctx) => {
  await ctx.reply('📧 Detected an email')
})
```

## Coincidir "contiene" en vez de exacto

Por defecto, un trigger de tipo string solo coincide cuando el mensaje
(normalizado) **es igual** a él — `bot.when('invoice', ...)` NO coincide con
"check my invoice please". Usa un `TriggerObject` con `match: 'contains'`
para recuperar el comportamiento clásico de "contiene":

```ts
bot.when({ pattern: 'invoice', match: 'contains' }, async (ctx) => {
  await ctx.reply('🧾 I see you mentioned an invoice')
})
```

`match` también admite `'startsWith'` y `'endsWith'`.

## Citar el mensaje

```ts
bot.when('quote', async (ctx) => {
  await ctx.quote('Replying to your specific message')
})
```

## Reaccionar con emoji

```ts
bot.when('good', async (ctx) => { await ctx.react('👍') })
bot.when('love', async (ctx) => { await ctx.react('❤️') })
```

## Solo en privado

```ts
bot.when('private', async (ctx) => {
  if (ctx.isGroup) return
  await ctx.reply('This only works in private chat')
})
```

## Mensaje multi-línea

```ts
bot.when('info', async (ctx) => {
  await ctx.reply([
    'ℹ️ *Bot info*',
    '',
    '• Version: 2.0.0',
    '• Engine: Baileys 7',
  ].join('\n'))
})
```

## Usar los datos del remitente

```ts
bot.when('who', async (ctx) => {
  const name = ctx.senderInfo?.pushName ?? ctx.pushName ?? 'friend'
  await ctx.reply(`👋 Hi ${name}!`)
})
```

## Sin botones nativos — usa una encuesta

WhatsApp Web eliminó los botones nativos, así que un sí/no rápido se resuelve
mejor con una encuesta real (ver [Enviar media](./media) para más opciones de
encuestas):

```ts
bot.when('confirm', async (ctx) => {
  await ctx.poll('Do you confirm your order?', ['Yes', 'No'])
})
```

Para un menú que se ramifica en lógica distinta según la opción, usa
`flow().choose()` o `c.choose()` — ver la receta de
[Flujo de compra](./flujo-compra).

## Catch-all

```ts
bot.onMessage(async (ctx) => {
  await ctx.reply('🤔 I did not recognize that. Send /help.')
})
```

## Iniciar el bot

```ts
await bot.start()
```

## Siguientes pasos

- [Enviar media](./media) — fotos, stickers, audio
- [Flujo de registro](./flujo-registro) — conversación multi-paso
