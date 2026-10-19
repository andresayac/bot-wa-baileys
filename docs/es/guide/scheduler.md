# Scheduler

Ejecuta tareas programadas: cada cierto intervalo, con cron, o después de
un delay. Cada método devuelve un `ScheduledTask` que puedes cancelar.

## every — repetir cada intervalo

```ts
bot.every('30 seconds', () => console.log('💓 heartbeat'))
bot.every('5 minutes', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '⏰ reminder')
})
bot.every('2 hours', async () => { /* cleanup */ })
bot.every(60000, () => console.log('1 minute'))  // ms
```

### Formatos aceptados

| String | Equivalente |
|---|---|
| `'30 seconds'` | 30000 ms |
| `'5 minutes'` | 300000 ms |
| `'2 hours'` | 7200000 ms |
| `'1 day'` | 86400000 ms |

## schedule — expresión cron

```ts
// Cada día a las 9:00 AM
bot.schedule('0 9 * * *', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 Good morning!')
})

// Días laborables a las 9:00 AM
bot.schedule('0 9 * * 1-5', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '💼 Time to work')
})

// Cada 15 minutos
bot.schedule('*/15 * * * *', async () => { /* ... */ })
```

### Formato cron (5 campos)

```
┌───── minuto (0-59)
│ ┌───── hora (0-23)
│ │ ┌───── día del mes (1-31)
│ │ │ ┌───── mes (1-12)
│ │ │ │ ┌───── día de la semana (0-7, 0 y 7 = domingo)
│ │ │ │ │
* * * * *
```

Cada campo acepta `*`, un número, un rango (`1-5`), un paso (`*/15`, `1-30/5`)
o una lista separada por comas de esos. Tienen que cumplirse todos los campos
(no se implementa la regla "O" entre día del mes y día de la semana del cron
clásico). Los nombres (`mon`, `jan`) y las macros (`@daily`) no están
soportados: `bot.schedule()` lanza un `TypeError` que nombra el campo inválido
en lugar de crear una tarea que nunca se ejecuta.

## delay — una vez después de X tiempo

```ts
bot.delay('10 seconds', () => console.log('⏰ 10s elapsed'))
bot.delay('5 minutes', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', 'All good?')
})
```

## Cancelar una tarea

`bot.schedule`, `bot.every` y `bot.delay` devuelven todos un
`ScheduledTask` con un método `.cancel()`:

```ts
const heartbeat = bot.every('30 seconds', () => console.log('💓'))

// más adelante
heartbeat.cancel()
```

## Siguientes pasos

- [Sub-APIs](./sub-apis) — grupos, perfil, chats, etc.
- [Despliegue](./deploy) — configuración de producción
