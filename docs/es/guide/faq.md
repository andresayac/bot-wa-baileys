# Preguntas frecuentes

## ¿Necesito escanear el QR cada vez que inicio el bot?

**No.** La sesión se guarda en `./sessions/`. Solo escaneas el QR la
primera vez. Si la sesión se invalida (borraste la carpeta o WhatsApp
desvinculó el dispositivo), necesitarás escanear de nuevo.

## ¿Puedo usar el bot sin escanear el QR?

Sí, con **pairing code**:

```ts
const bot = new Bot({
  session: 'my-bot',
  pairingCode: '+57300XXXXXXX', // formato internacional completo
})

bot.on('pairing_code', (code) => console.log('Pairing code:', code))
```

## ¿El bot funciona en grupos?

Sí. Los handlers `when()` funcionan en grupos por defecto. Para responder
solo en privado:

```ts
bot.when('hola', async (ctx) => {
  if (ctx.isGroup) return
  await ctx.reply('👋')
})
```

En un grupo, cada participante obtiene una **conversación independiente**
por defecto cuando dispara un flow — dos personas hablándole al bot en el
mismo grupo no comparten estado. Configura `conversationScope: 'chat'` si
en cambio quieres una única conversación compartida por grupo.

## ¿Por qué `bot.when('hi')` no coincide con "hi there"?

La estrategia de coincidencia por defecto es **igualdad normalizada**, no
"contains" — el mensaje debe ser igual al trigger exactamente, después de
convertir a minúsculas, quitar acentos y colapsar espacios. Para
coincidencia por subcadena, usa un `TriggerObject`:

```ts
bot.when({ pattern: 'hi', match: 'contains' }, handler)
```

`match` también acepta `'startsWith'` y `'endsWith'`.

## ¿Puedo enviar botones?

No — los botones/listas interactivos nativos están muertos en el protocolo
actual de WhatsApp Web. Usa un menú numerado (`.choose()` en un flow,
`c.choose()` en una conversación) o una encuesta real:

```ts
await ctx.poll('Confirm your order?', ['Yes', 'No'])
```

## ¿Los flows/conversaciones sobreviven a un reinicio?

Solo si lo activas explícitamente. `flow(...).persistent()` hace
checkpoint de la conversación después de cada paso, pero el `MemoryStore`
por defecto vive en memoria — un reinicio pierde esos checkpoints a menos
que el store tenga un archivo detrás:

```ts
const bot = new Bot({ storeConfig: { file: './store.json' } })
```

## ¿Puedo enviar mensajes sin que alguien me escriba primero?

Sí, con `bot.sendText`:

```ts
bot.schedule('0 9 * * *', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 Good morning!')
})
```

## ¿Cómo detengo el bot correctamente?

```ts
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down...')
  await bot.stop()
  process.exit(0)
})
```

## ¿Puedo tener varios bots en el mismo proceso?

Sí, con sesiones diferentes:

```ts
const bot1 = new Bot({ session: 'bot-1' })
const bot2 = new Bot({ session: 'bot-2' })
await bot1.start()
await bot2.start()
```

## ¿Funciona con WhatsApp Business?

Sí. El bot funciona tanto con cuentas personales como con cuentas de
WhatsApp Business.

## ¿Pueden banear mi cuenta?

WhatsApp puede detectar automatización excesiva. Para minimizar el riesgo:

- No envíes spam ni mensajes masivos
- Usa `markOnlineOnConnect: false`
- Respeta los límites de rate
- No respondas instantáneamente a todo (usa delays humanos)

## ¿Necesito TypeScript?

**No.** Todos los ejemplos funcionan en JavaScript plano — solo ten en
cuenta que el paquete es **solo ESM**, así que tu proyecto necesita
`"type": "module"` en el `package.json` (o un archivo `.mjs`)
independientemente de si usas TypeScript. TypeScript te da autocompletado y
type-checking, pero es opcional.

## ¿Por qué me sale `ERR_REQUIRE_ESM` o "require is not defined"?

Estás intentando hacer `require('@bot-wa/bot-wa-baileys')` desde un archivo
CommonJS. No hay build de CJS — cambia a `import` (agrega `"type":
"module"` a tu `package.json`, o usa la extensión `.mjs`). Node >= 22.12
también puede hacer `require()` de un paquete ESM gracias a su soporte
experimental `require(esm)`.

## ¿Dónde está la API reference completa?

En la [API Reference](/api/) — generada con TypeDoc desde el código fuente.

## ¿Sigues teniendo problemas?

- [Abre un issue en GitHub](https://github.com/andresayac/bot-wa-baileys/issues)
- [Revisa los ejemplos](/es/ejemplos/mensajes)
