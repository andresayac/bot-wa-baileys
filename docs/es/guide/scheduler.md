# Scheduler

El scheduler te permite ejecutar tareas programadas: cada cierto tiempo,
con expresiones cron, o después de un delay.

## every — repetir cada intervalo

```js
// Cada 30 segundos
bot.every('30 seconds', () => {
  console.log('💓 heartbeat')
})

// Cada 5 minutos
bot.every('5 minutes', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '⏰ recordatorio')
})

// Cada 2 horas
bot.every('2 hours', async () => {
  // limpiar cache, enviar reporte, etc.
})

// En milisegundos
bot.every(60000, () => console.log('1 minuto'))
```

### Formatos aceptados

| String | Equivalente |
|---|---|
| `'30 seconds'` | 30000 ms |
| `'5 minutes'` | 300000 ms |
| `'2 hours'` | 7200000 ms |
| `'1 day'` | 86400000 ms |
| `60000` (número) | 60000 ms |

## schedule — expresión cron

```js
// Cada día a las 9:00 AM
bot.schedule('0 9 * * *', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 ¡Buenos días!')
})

// Lunes a viernes a las 9:00 AM
bot.schedule('0 9 * * 1-5', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '💼 A trabajar')
})

// Cada 15 minutos
bot.schedule('*/15 * * * *', async () => {
  console.log('tick')
})

// Primer día de cada mes a medianoche
bot.schedule('0 0 1 * *', async () => {
  // reporte mensual
})
```

### Formato cron (5 campos)

```
┌───── minuto (0-59)
│ ┌───── hora (0-23)
│ │ ┌───── día del mes (1-31)
│ │ │ ┌───── mes (1-12)
│ │ │ │ ┌───── día de la semana (0-6, 0=domingo)
│ │ │ │ │
* * * * *
```

## delay — una vez después de X tiempo

```js
// 10 segundos después de que el bot inicia
bot.delay('10 seconds', () => {
  console.log('⏰ 10 segundos han pasado')
})

// 5 minutos después
bot.delay('5 minutes', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '¿Todo bien?')
})
```

## Ejemplo: bot de recordatorios

```js
const bot = new Bot({ session: 'recordatorios' })

// Recordatorio diario
bot.schedule('0 8 * * *', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '☀️ ¡Buenos días! No olvides...')
})

// Heartbeat cada minuto
bot.every('1 minute', () => {
  console.log(`💓 ${new Date().toISOString()}`)
})

// Mensaje de bienvenida 10s después de conectar
bot.delay('10 seconds', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🤖 Bot activo')
})

bot.start()
```

## Siguientes pasos

- [Sub-APIs](./sub-apis) — groups, profile, chats, etc.
- [Despliegue](./deploy) — cómo poner el bot en producción