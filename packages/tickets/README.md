# @botmesh/tickets

> **Experimental — not yet published on npm.** `private` package of the monorepo: use it with `workspace:*`; its API may change.

Support tickets and queues for [`@botmesh/core`](../core): `ctx.tools.tickets` with states, priorities, queue position, working hours, callbacks (`onAssign`, …) and persistence in the bot store.

## Usage

```ts
import { ticketsPlugin } from '@botmesh/tickets'

bot.plug(ticketsPlugin({
  workingHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  timezone: 'America/Bogota',
  queueMessage: 'You are in the queue, position {{position}} (ticket #{{id}})',
  closedMessage: 'We are outside working hours; we will reply when we open (ticket #{{id}})',
  assignMessage: '{{assignee}} is handling your ticket #{{id}}',
  closeMessage: 'Ticket #{{id}} closed. Thank you!',
  handoffOnAssign: true,   // bot.handoff(chatId) on assign
  resumeOnClose: true,     // bot.resume(chatId) on close
  onAssign: async (ticket) => notifyAgent(ticket),
}))

bot.when('support', async (ctx) => {
  const ticket = await ctx.tools.tickets!.create({ chatId: ctx.from, subject: ctx.body, priority: 'normal' })
  await ctx.reply(`🎫 Ticket #${ticket.id} created`)
})

// Agent panel / your own API
const tickets = bot.injectTools.tickets!
await tickets.assign('1', 'ana')
await tickets.close('1', { reason: 'resolved' })
```

## API (`ctx.tools.tickets`)

| Method | Description |
| --- | --- |
| `create({ chatId, subject, priority?, meta? })` | Creates an `open` ticket. Returns the ticket plus `created`, `position` (1-based or `null`) and `withinWorkingHours`. With `reuseOpen` (the default) it returns the chat's unclosed ticket when one exists (`created: false`). |
| `get(id)` | Ticket or `undefined`. |
| `update(id, patch)` | `subject`, `priority`, `status`, `assignee` (`null` unassigns and returns it to the queue), `meta`. Rejects with `TicketNotFoundError`. |
| `list(filter?)` | Filters by `status` (one or several), `chatId`, `assignee`, `priority`; ordered by age. |
| `assign(id, assignee)` | `assigned` state; fires `onAssign`. |
| `close(id, { reason? })` | `closed` state, `closedAt`, `closeReason`; fires `onClose`. |
| `queue()` | `open` tickets by priority (`urgent` > `high` > `normal` > `low`) and then age. |
| `position(id)` | Queue position or `null`. |
| `isOpen(date?)` | Whether it is within working hours (always `true` without `workingHours`). |

States: `open` (queued), `assigned`, `pending` (waiting for the customer, out of the queue) and `closed`. Ids are sequential (`'1'`, `'2'`, …) per bot namespace.

## Working hours

`workingHours` accepts `'9-18'`, `'09:30-18:15'`, `{ days, start, end }` (days `0` = Sunday … `6` = Saturday), an array of windows (split shifts) or a function `(date) => boolean`. The end is exclusive and a window such as `'22-6'` crosses midnight. It is evaluated in `timezone` (IANA; process timezone by default). Outside working hours `closedMessage` is sent instead of `queueMessage`.

## Persistence

By default it uses the bot store's cursors API (`tickets:seq`, `tickets:index`, `tickets:t:<id>`), implemented by all six stores; with `MemoryStore` it lives in RAM. `tickets:index` lists only unclosed tickets: in memory only active ones live there and closed ones are read on demand (`get`, and `list` when the filter may include `closed`). It loads lazily on the first call (`install` is synchronous) and mutations are serialized; if a store write fails, the call rejects and memory does not change. You can pass your own `storage: { get, set }`.

## Callbacks and messages

`onCreate`, `onAssign`, `onClose` and `onUpdate(ticket, previous)` run after the change is persisted; their errors (and send errors) go to `onError` (`warn` log by default) and never make the operation fail. Templates accept `{{id}}`, `{{position}}`, `{{subject}}`, `{{priority}}`, `{{assignee}}`, `{{status}}` and `{{reason}}`.

`TicketDesk` can be used without a bot: `new TicketDesk({ storage: memoryTicketStorage() })`.
