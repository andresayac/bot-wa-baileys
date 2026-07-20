# Enviar mensajes

Recetas prácticas para responder a mensajes de texto.

## Responder a un texto

```js
bot.when('hola', async (ctx) => {
  await ctx.reply('👋 ¡Hola!')
})
```

## Responder a varios textos

```js
bot.when(['adios', 'chao', 'bye', 'hasta luego'], async (ctx) => {
  await ctx.reply('👋 ¡Hasta luego! Vuelve pronto.')
})
```

## Responder con regex

```js
// Detectar números largos
bot.when(/\d{4,}/, async (ctx) => {
  await ctx.reply(`🔢 Detecté un número: "${ctx.body}"`)
})

// Detectar email
bot.when(/[\w.]+@[\w.]+\.\w+/, async (ctx) => {
  await ctx.reply(`📧 Detecté un email: "${ctx.body}"`)
})

// Detectar URL
bot.when(/https?:\/\/.+/, async (ctx) => {
  await ctx.reply('🔗 Detecté un enlace')
})
```

## Responder citando el mensaje

```js
bot.when('cita', async (ctx) => {
  await ctx.quote('Respondiendo a tu mensaje específicamente')
})
```

## Responder con typing simulado

```js
bot.when('lento', async (ctx) => {
  await ctx.replyWithTyping('Escribiendo lentamente...')
})
```

## Reaccionar con emoji

```js
bot.when('bien', async (ctx) => {
  await ctx.react('👍')
})

bot.when('amor', async (ctx) => {
  await ctx.react('❤️')
})
```

## Responder solo en privado

```js
bot.when('privado', async (ctx) => {
  if (ctx.isGroup) return
  await ctx.reply('Esto solo funciona en chat privado')
})
```

## Responder solo en grupos

```js
bot.when('grupo', async (ctx) => {
  if (!ctx.isGroup) return
  await ctx.reply('Esto solo funciona en grupos')
})
```

## Mensaje multi-línea

```js
bot.when('info', async (ctx) => {
  await ctx.reply([
    'ℹ️ *Información del bot*',
    '',
    '• Versión: 2.0.0',
    '• Motor: Baileys 7',
    '',
    'Envía /help para ver comandos.',
  ].join('\n'))
})
```

## Usar el nombre del remitente

```js
bot.when('quien', async (ctx) => {
  const nombre = ctx.sender.pushName ?? 'desconocido'
  await ctx.reply(`👋 Hola ${nombre}!`)
})
```

## Catch-all (cuando no reconoce nada)

```js
bot.onMessage(async (ctx) => {
  await ctx.reply([
    '🤔 No reconocí ese comando.',
    '',
    'Envía /help para ver lo que puedo hacer.',
  ].join('\n'))
})
```

## Siguientes pasos

- [Enviar media](./media) — fotos, stickers, audio
- [Flujo de registro](./flujo-registro) — conversación multi-paso