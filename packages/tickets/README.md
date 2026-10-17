# @bot-wa/tickets

> **Experimental — aún no publicado en npm.** Paquete `private` del monorepo: úsalo con `workspace:*`; su API puede cambiar.

Tickets de soporte y colas para [`@bot-wa/core`](../core): `ctx.tools.tickets` con estados, prioridades, posición en cola, horario de atención, callbacks (`onAssign`, …) y persistencia en el store del bot.

## Uso

```ts
import { ticketsPlugin } from '@bot-wa/tickets'

bot.plug(ticketsPlugin({
  workingHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  timezone: 'America/Bogota',
  queueMessage: 'Estás en cola, posición {{position}} (ticket #{{id}})',
  closedMessage: 'Estamos fuera de horario; te respondemos al abrir (ticket #{{id}})',
  assignMessage: '{{assignee}} atiende tu ticket #{{id}}',
  closeMessage: 'Ticket #{{id}} cerrado. ¡Gracias!',
  handoffOnAssign: true,   // bot.handoff(chatId) al asignar
  resumeOnClose: true,     // bot.resume(chatId) al cerrar
  onAssign: async (ticket) => notifyAgent(ticket),
}))

bot.when('soporte', async (ctx) => {
  const ticket = await ctx.tools.tickets!.create({ chatId: ctx.from, subject: ctx.body, priority: 'normal' })
  await ctx.reply(`🎫 Ticket #${ticket.id} creado`)
})

// Panel de agentes / API propia
const tickets = bot.injectTools.tickets!
await tickets.assign('1', 'ana')
await tickets.close('1', { reason: 'resuelto' })
```

## API (`ctx.tools.tickets`)

| Método | Descripción |
| --- | --- |
| `create({ chatId, subject, priority?, meta? })` | Crea un ticket `open`. Devuelve el ticket más `created`, `position` (1-based o `null`) y `withinWorkingHours`. Con `reuseOpen` (por defecto) devuelve el ticket no cerrado del chat si existe (`created: false`). |
| `get(id)` | Ticket o `undefined`. |
| `update(id, patch)` | `subject`, `priority`, `status`, `assignee` (`null` desasigna y vuelve a la cola), `meta`. Rechaza con `TicketNotFoundError`. |
| `list(filter?)` | Filtra por `status` (uno o varios), `chatId`, `assignee`, `priority`; orden por antigüedad. |
| `assign(id, assignee)` | Estado `assigned`; dispara `onAssign`. |
| `close(id, { reason? })` | Estado `closed`, `closedAt`, `closeReason`; dispara `onClose`. |
| `queue()` | Tickets `open` por prioridad (`urgent` > `high` > `normal` > `low`) y luego antigüedad. |
| `position(id)` | Posición en cola o `null`. |
| `isOpen(date?)` | Si es horario de atención (siempre `true` sin `workingHours`). |

Estados: `open` (en cola), `assigned`, `pending` (esperando al cliente, fuera de la cola) y `closed`. Los ids son secuenciales (`'1'`, `'2'`, …) por namespace de bot.

## Horario de atención

`workingHours` acepta `'9-18'`, `'09:30-18:15'`, `{ days, start, end }` (días `0` = domingo … `6` = sábado), un array de ventanas (turnos partidos) o una función `(date) => boolean`. El fin es exclusivo y una ventana como `'22-6'` cruza la medianoche. Se evalúa en `timezone` (IANA; por defecto la del proceso). Fuera de horario se envía `closedMessage` en lugar de `queueMessage`.

## Persistencia

Por defecto usa la API de cursores del store del bot (`tickets:seq`, `tickets:index`, `tickets:t:<id>`), que implementan los seis stores; con `MemoryStore` vive en RAM. Se carga de forma perezosa en la primera llamada (el `install` es síncrono) y las mutaciones se serializan. Puedes pasar tu propio `storage: { get, set }`.

## Callbacks y mensajes

`onCreate`, `onAssign`, `onClose` y `onUpdate(ticket, previous)` se ejecutan tras persistir el cambio; sus errores (y los de envío) van a `onError` (por defecto, log `warn`) y nunca hacen fallar la operación. Las plantillas admiten `{{id}}`, `{{position}}`, `{{subject}}`, `{{priority}}`, `{{assignee}}`, `{{status}}` y `{{reason}}`.

`TicketDesk` se puede usar sin bot: `new TicketDesk({ storage: memoryTicketStorage() })`.
