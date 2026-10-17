import { describe, expect, it, vi } from 'vitest'
import { Bot, MemoryStore } from '@bot-wa/core'
import { MockProvider, createTestBot } from '@bot-wa/core/testing'
import {
  TicketDesk,
  TicketNotFoundError,
  memoryTicketStorage,
  ticketsPlugin,
  type Ticket,
  type TicketsApi,
} from '../src/index.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

function desk(over: Partial<ConstructorParameters<typeof TicketDesk>[0]> = {}) {
  let t = Date.UTC(2026, 0, 5, 12, 0, 0) // Monday 12:00 UTC
  const now = () => (t += 1000)
  return new TicketDesk({ storage: memoryTicketStorage(), now, ...over })
}

describe('TicketDesk — CRUD', () => {
  it('creates tickets with sequential ids, defaults and queue position', async () => {
    const d = desk()
    const a = await d.create({ chatId: 'c1', subject: 'No llega mi pedido' })
    const b = await d.create({ chatId: 'c2', subject: 'Factura', priority: 'high' })
    expect(a.id).toBe('1')
    expect(b.id).toBe('2')
    expect(a.status).toBe('open')
    expect(a.priority).toBe('normal')
    expect(a.created).toBe(true)
    expect(a.position).toBe(1)
    // high priority jumps ahead of the normal one
    expect(await d.position('2')).toBe(1)
    expect(await d.position('1')).toBe(2)
    expect((await d.queue()).map((x) => x.id)).toEqual(['2', '1'])
  })

  it('get/update/list with filters', async () => {
    const d = desk()
    await d.create({ chatId: 'c1', subject: 'a' })
    await d.create({ chatId: 'c2', subject: 'b', priority: 'urgent', meta: { order: 7 } })
    expect((await d.get('2'))?.meta).toEqual({ order: 7 })
    expect(await d.get('99')).toBeUndefined()

    const u = await d.update('1', { subject: 'a2', status: 'pending' })
    expect(u.subject).toBe('a2')
    expect(u.status).toBe('pending')
    expect(u.updatedAt).toBeGreaterThan(u.createdAt)

    expect((await d.list({ status: 'pending' })).map((x) => x.id)).toEqual(['1'])
    expect((await d.list({ chatId: 'c2' })).map((x) => x.id)).toEqual(['2'])
    expect((await d.list({ priority: 'urgent' })).map((x) => x.id)).toEqual(['2'])
    expect((await d.list()).length).toBe(2)
    // pending tickets are not in the queue
    expect(await d.position('1')).toBeNull()
    await expect(d.update('nope', { subject: 'x' })).rejects.toBeInstanceOf(TicketNotFoundError)
  })

  it('validates input', async () => {
    const d = desk()
    await expect(d.create({ chatId: '', subject: 'x' })).rejects.toThrow(/chatId/)
    await expect(d.create({ chatId: 'c', subject: 'x', priority: 'mega' as never })).rejects.toThrow(/priority/)
    await d.create({ chatId: 'c', subject: 'x' })
    await expect(d.update('1', { status: 'weird' as never })).rejects.toThrow(/status/)
  })

  it('reuses the open ticket of a chat unless reuseOpen is false', async () => {
    const d = desk()
    const a = await d.create({ chatId: 'c1', subject: 'a' })
    const again = await d.create({ chatId: 'c1', subject: 'otra cosa' })
    expect(again.id).toBe(a.id)
    expect(again.created).toBe(false)
    await d.close('1')
    const fresh = await d.create({ chatId: 'c1', subject: 'b' })
    expect(fresh.id).toBe('2')

    const d2 = desk({ reuseOpen: false })
    await d2.create({ chatId: 'c1', subject: 'a' })
    expect((await d2.create({ chatId: 'c1', subject: 'b' })).id).toBe('2')
  })

  it('assign fires onAssign, leaves the queue; close fires onClose', async () => {
    const onAssign = vi.fn()
    const onClose = vi.fn()
    const d = desk({ onAssign, onClose })
    await d.create({ chatId: 'c1', subject: 'a' })
    await d.create({ chatId: 'c2', subject: 'b' })
    const t = await d.assign('1', 'ana')
    expect(t.status).toBe('assigned')
    expect(t.assignee).toBe('ana')
    expect(onAssign).toHaveBeenCalledTimes(1)
    expect((onAssign.mock.calls[0][0] as Ticket).id).toBe('1')
    expect(await d.position('2')).toBe(1)
    const c = await d.close('1', { reason: 'resuelto' })
    expect(c.status).toBe('closed')
    expect(c.closedAt).toBeTypeOf('number')
    expect(c.closeReason).toBe('resuelto')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('update({ assignee }) also counts as an assignment; errors in callbacks are swallowed and reported', async () => {
    const onError = vi.fn()
    const d = desk({ onAssign: () => { throw new Error('boom') }, onError })
    await d.create({ chatId: 'c1', subject: 'a' })
    const t = await d.update('1', { assignee: 'leo' })
    expect(t.status).toBe('assigned')
    expect(onError).toHaveBeenCalledTimes(1)
    // unassigning puts it back in the queue
    const back = await d.update('1', { assignee: null })
    expect(back.status).toBe('open')
    expect(back.assignee).toBeUndefined()
    expect(await d.position('1')).toBe(1)
  })

  it('serializes concurrent creates (no duplicate ids)', async () => {
    const d = desk()
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => d.create({ chatId: `c${i}`, subject: 's' })))
    expect(new Set(all.map((t) => t.id)).size).toBe(10)
  })
})

describe('TicketDesk — working hours', () => {
  it('reports withinWorkingHours on create and exposes isOpen()', async () => {
    let now = Date.UTC(2026, 0, 5, 20, 0, 0) // Monday 20:00 UTC
    const d = new TicketDesk({ storage: memoryTicketStorage(), now: () => now, workingHours: '9-18', timezone: 'UTC' })
    expect(d.isOpen()).toBe(false)
    const t = await d.create({ chatId: 'c', subject: 's' })
    expect(t.withinWorkingHours).toBe(false)
    now = Date.UTC(2026, 0, 5, 10, 0, 0)
    expect(d.isOpen()).toBe(true)
  })
})

describe('ticketsPlugin — Bot integration', () => {
  it('exposes ctx.tools.tickets and sends the queue message', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(ticketsPlugin({ queueMessage: 'Ticket #{{id}}: posición {{position}}' }))
    bot.when('soporte', async (ctx) => {
      const ticket = await ctx.tools.tickets!.create({ chatId: ctx.from, subject: ctx.body })
      await ctx.reply(`creado ${ticket.id}`)
    })
    await chat.send('soporte')
    await chat.expectReply('Ticket #1: posición 1')
    await chat.expectReply('creado 1')
    await bot.stop()
  })

  it('sends the closed message outside working hours instead of the queue message', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(ticketsPlugin({
      workingHours: { start: '09:00', end: '18:00' },
      timezone: 'UTC',
      now: () => Date.UTC(2026, 0, 5, 23, 0, 0),
      queueMessage: 'en cola {{position}}',
      closedMessage: 'Fuera de horario, ticket #{{id}}',
    }))
    const tickets = bot.injectTools.tickets as TicketsApi
    await tickets.create({ chatId: chat.jid, subject: 's' })
    await chat.expectReply('Fuera de horario, ticket #1')
    expect(chat.replies().some((r) => r.startsWith('en cola'))).toBe(false)
    await bot.stop()
  })

  it('handoffOnAssign hands the chat off; resumeOnClose resumes it; assign/close messages go out', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(ticketsPlugin({
      handoffOnAssign: true,
      resumeOnClose: true,
      assignMessage: '{{assignee}} atiende tu ticket #{{id}}',
      closeMessage: 'Ticket #{{id}} cerrado',
    }))
    const tickets = bot.injectTools.tickets as TicketsApi
    await tickets.create({ chatId: chat.jid, subject: 's' })
    await tickets.assign('1', 'Ana')
    expect(bot.isHandedOff(chat.jid)).toBe(true)
    expect(bot.getHandoff(chat.jid)?.meta).toMatchObject({ ticketId: '1', assignee: 'Ana' })
    await chat.expectReply('Ana atiende tu ticket #1')
    await tickets.close('1')
    expect(bot.isHandedOff(chat.jid)).toBe(false)
    await chat.expectReply('Ticket #1 cerrado')
    await bot.stop()
  })

  it('persists tickets through the bot store across restarts', async () => {
    const store = new MemoryStore()
    const bot1 = new Bot({ provider: new MockProvider(), store })
    bot1.plug(ticketsPlugin())
    await bot1.start()
    const t1 = bot1.injectTools.tickets as TicketsApi
    await t1.create({ chatId: 'c1', subject: 'uno', meta: { a: 1 } })
    await t1.create({ chatId: 'c2', subject: 'dos' })
    await t1.assign('2', 'ana')
    await bot1.stop()

    const bot2 = new Bot({ provider: new MockProvider(), store })
    bot2.plug(ticketsPlugin())
    await bot2.start()
    const t2 = bot2.injectTools.tickets as TicketsApi
    expect((await t2.get('1'))?.meta).toEqual({ a: 1 })
    expect((await t2.get('2'))?.assignee).toBe('ana')
    const t3 = await t2.create({ chatId: 'c3', subject: 'tres' })
    expect(t3.id).toBe('3')
    await bot2.stop()
  })

  it('install is synchronous and plug() returns a disposer that removes the tool', async () => {
    const { bot } = await createTestBot()
    const spec = ticketsPlugin()
    const result = spec.install as unknown as (...a: unknown[]) => unknown
    expect(result.constructor.name).toBe('Function')
    const unplug = bot.plug(spec)
    expect(bot.injectTools.tickets).toBeDefined()
    unplug()
    expect(bot.injectTools.tickets).toBeUndefined()
    await bot.stop()
  })
})

describe('ticket storage', () => {
  it('memoryTicketStorage round-trips through a fresh desk', async () => {
    const storage = memoryTicketStorage()
    const a = new TicketDesk({ storage })
    await a.create({ chatId: 'c', subject: 's' })
    const b = new TicketDesk({ storage })
    expect((await b.list()).map((t) => t.id)).toEqual(['1'])
    expect((await b.create({ chatId: 'd', subject: 's' })).id).toBe('2')
  })
})
