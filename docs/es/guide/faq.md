# Preguntas frecuentes

## ¿Necesito escanear el QR cada vez que inicio el bot?

**No.** La sesión se guarda en `./sessions/`. Solo necesitas escanear el QR
la primera vez. Si la sesión se invalida (ej. borraste la carpeta o WhatsApp
desvinculó el dispositivo), necesitarás escanear de nuevo.

## ¿Puedo usar el bot sin escanear QR?

Sí, con **pairing code**:

```js
const bot = new Bot({
  session: 'mi-bot',
  pairingCode: '+57300XXXXXXX',  // tu número
})
```

Recibirás un código de 8 dígitos en tu teléfono. Ingrésalo en WhatsApp
(Configuración → Dispositivos vinculados → Vincular con número de teléfono).

## ¿El bot funciona en grupos?

Sí. Los handlers `when()` funcionan en grupos por defecto. Para responder
solo en mensajes privados:

```js
bot.when('hola', async (ctx) => {
  if (ctx.isGroup) return  // ignorar grupos
  await ctx.reply('👋')
})
```

## ¿Cómo menciono a alguien en un grupo?

```js
bot.when('mencionar', async (ctx) => {
  await ctx.reply('Hola @573001234567', {
    mentions: ['573001234567@s.whatsapp.net'],
  })
})
```

## ¿Puedo enviar mensajes sin que alguien me escriba primero?

Sí, con `bot.sendText`:

```js
bot.schedule('0 9 * * *', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 ¡Buenos días!')
})
```

Necesitas el JID del destinatario (`numero@s.whatsapp.net`).

## ¿Cómo detengo el bot correctamente?

```js
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down...')
  await bot.stop()
  process.exit(0)
})
```

`bot.stop()` cierra la conexión limpiamente y guarda la sesión.

## ¿Puedo tener varios bots en el mismo proceso?

Sí, con sesiones diferentes:

```js
const bot1 = new Bot({ session: 'bot-1' })
const bot2 = new Bot({ session: 'bot-2' })

await bot1.start()
await bot2.start()
```

Cada uno tiene su propia sesión y su QR.

## ¿El bot consume muchos recursos?

No. En reposo consume ~50-100MB de RAM. El uso sube si procesas mucho media
(stickers, transcodificación de audio).

## ¿Funciona con WhatsApp Business?

Sí. El bot funciona con cuentas personales y de WhatsApp Business.

## ¿Pueden banear mi cuenta por usar un bot?

WhatsApp puede detectar automatización excesiva. Para minimizar el riesgo:

- No envíes spam ni mensajes masivos
- Usa `markOnlineOnConnect: false` para no parecer siempre en línea
- Respeta los límites de rate
- No respondas instantáneamente a todo (usa delays humanos)

```js
const bot = new Bot({
  markOnlineOnConnect: false,  // no parecer siempre en línea
})
```

## ¿Cómo hago debug?

```js
const bot = new Bot({
  debug: true,  // logs detallados
})
```

O usa el logger:

```js
bot.before('message', async (ctx, next) => {
  console.log(ctx.type, ctx.from, ctx.body)
  await next()
})
```

## ¿Necesito TypeScript?

**No.** Todos los ejemplos funcionan en JavaScript plano. TypeScript te da
autocompletado y type-checking, pero es opcional.

## ¿Dónde encuentro la API reference completa?

En la [API Reference](/api/) — generada con TypeDoc desde el código fuente.

## ¿Sigues teniendo problemas?

- [Abre un issue en GitHub](https://github.com/andresayac/bot-wa-baileys/issues)
- [Revisa los ejemplos](/es/ejemplos/mensajes)