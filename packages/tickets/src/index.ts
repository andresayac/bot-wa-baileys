/**
 * @bot-wa/tickets — support tickets and queues for `@bot-wa/core`.
 *
 * - {@link ticketsPlugin} — installs a {@link TicketDesk} as `ctx.tools.tickets`.
 * - {@link TicketDesk} — the engine (usable without a Bot).
 * - Working hours helpers: {@link parseWorkingHours}, {@link isWithinWorkingHours}.
 */

import type { TicketsApi } from './types.js'

export { ticketsPlugin, renderTemplate } from './ticketsPlugin.js'
export type { TicketsPluginConfig } from './ticketsPlugin.js'
export { TicketDesk, TicketNotFoundError } from './TicketDesk.js'
export type { TicketDeskOptions, TicketCallbackName } from './TicketDesk.js'
export { memoryTicketStorage, storeTicketStorage } from './storage.js'
export { TICKET_PRIORITIES, TICKET_STATUSES } from './types.js'
export type {
  Ticket,
  TicketPriority,
  TicketStatus,
  CreateTicketInput,
  CreatedTicket,
  TicketPatch,
  TicketFilter,
  TicketsApi,
  TicketKeyValue,
} from './types.js'
export { parseWorkingHours, isWithinWorkingHours, localClock } from './workingHours.js'
export type {
  WorkingHours,
  WorkingHoursInput,
  WorkingHoursWindow,
  WorkingHoursPredicate,
  NormalizedWindow,
} from './workingHours.js'

/** Types `ctx.tools.tickets` once this package is imported. */
declare module '@bot-wa/core' {
  interface DefaultTools {
    /** Present when `ticketsPlugin` is plugged into the Bot. */
    tickets?: TicketsApi
  }
}
