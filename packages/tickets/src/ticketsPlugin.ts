/**
 * ticketsPlugin — support tickets / queues as `ctx.tools.tickets`.
 *
 * @example
 * ```ts
 * import { ticketsPlugin } from '@botmesh/tickets'
 *
 * bot.plug(ticketsPlugin({
 *   workingHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
 *   timezone: 'America/Bogota',
 *   queueMessage: 'Estás en cola, posición {{position}} (ticket #{{id}})',
 *   closedMessage: 'Estamos fuera de horario; te atendemos mañana (ticket #{{id}})',
 *   handoffOnAssign: true,
 *   resumeOnClose: true,
 *   onAssign: async (ticket) => notifyAgent(ticket),
 * }))
 *
 * bot.when('soporte', async (ctx) => {
 *   const ticket = await ctx.tools.tickets!.create({ chatId: ctx.from, subject: ctx.body })
 *   await ctx.reply(`🎫 Ticket #${ticket.id} creado`)
 * })
 * ```
 */

import type { ChatId, PluginSpec } from '@botmesh/core'
import { TicketDesk, type TicketDeskOptions } from './TicketDesk.js'
import { memoryTicketStorage, storeTicketStorage } from './storage.js'
import type { CreatedTicket, Ticket, TicketKeyValue } from './types.js'

export interface TicketsPluginConfig extends Omit<TicketDeskOptions, 'storage' | 'onError'> {
  /** Custom persistence. Default: the bot store's cursor API (falls back to memory). */
  storage?: TicketKeyValue
  /**
   * Sent to the chat when a ticket is created inside working hours. Placeholders:
   * `{{id}}`, `{{position}}`, `{{subject}}`, `{{priority}}`.
   */
  queueMessage?: string
  /** Sent instead of `queueMessage` when the ticket is created outside working hours. */
  closedMessage?: string
  /** Sent to the chat when the ticket is assigned (`{{assignee}}` also available). */
  assignMessage?: string
  /** Sent to the chat when the ticket is closed (`{{reason}}` also available). */
  closeMessage?: string
  /** Hand the chat off to a human (`bot.handoff`) when its ticket is assigned. Default `false`. */
  handoffOnAssign?: boolean
  /** Resume the bot (`bot.resume`) when the ticket is closed and the chat is handed off. Default `false`. */
  resumeOnClose?: boolean
  /** Called on callback / notification errors (default: logged as a warning). */
  onError?: (error: unknown, source: string) => void
}

/** Replace `{{name}}` placeholders; unknown names render as an empty string. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name]
    return v === undefined || v === null ? '' : String(v)
  })
}

function vars(t: Ticket | CreatedTicket): Record<string, unknown> {
  return { ...t, reason: t.closeReason }
}

/** Build the plugin. `bot.plug(ticketsPlugin({...}))`. */
export function ticketsPlugin(config: TicketsPluginConfig = {}): PluginSpec {
  return {
    name: 'tickets',
    version: '0.1.0',
    description: 'Support tickets and queues with working hours and store persistence.',
    install(ctx) {
      const { bot, logger } = ctx
      const report = (error: unknown, source: string) => {
        if (config.onError) {
          try { config.onError(error, source) } catch { /* ignore */ }
        } else {
          logger.warn({ err: error, source }, 'tickets: callback failed')
        }
      }
      let storage = config.storage
      if (!storage) {
        storage = storeTicketStorage(bot.getStore())
        if (!storage) {
          logger.warn('tickets: the store has no cursor support; tickets live in memory only')
          storage = memoryTicketStorage()
        }
      }

      const notify = async (chatId: ChatId, template: string | undefined, values: Record<string, unknown>, source: string) => {
        if (!template) return
        try { await bot.sendTo(chatId, renderTemplate(template, values)) } catch (error) { report(error, source) }
      }
      const step = async (source: string, fn: () => unknown) => {
        try { await fn() } catch (error) { report(error, source) }
      }

      const desk = new TicketDesk({
        ...config,
        storage,
        onError: report,
        onCreate: async (ticket) => {
          const template = ticket.withinWorkingHours ? config.queueMessage : (config.closedMessage ?? config.queueMessage)
          await notify(ticket.chatId, template, vars(ticket), 'queueMessage')
          await step('onCreate', () => config.onCreate?.(ticket))
        },
        onAssign: async (ticket) => {
          if (config.handoffOnAssign) {
            await step('handoff', () => bot.handoff(ticket.chatId, {
              reason: 'ticket:assigned',
              meta: { ticketId: ticket.id, ...(ticket.assignee !== undefined ? { assignee: ticket.assignee } : {}) },
            }))
          }
          await notify(ticket.chatId, config.assignMessage, vars(ticket), 'assignMessage')
          await step('onAssign', () => config.onAssign?.(ticket))
        },
        onClose: async (ticket) => {
          if (config.resumeOnClose && bot.isHandedOff(ticket.chatId)) {
            await step('resume', () => bot.resume(ticket.chatId, { reason: 'ticket:closed' }))
          }
          await notify(ticket.chatId, config.closeMessage, vars(ticket), 'closeMessage')
          await step('onClose', () => config.onClose?.(ticket))
        },
      })

      ctx.tools.tickets = desk
      ctx.onDispose(() => { if (ctx.tools.tickets === desk) delete ctx.tools.tickets })
    },
  }
}
