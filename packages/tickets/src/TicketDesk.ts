/**
 * TicketDesk — the transport-agnostic ticket/queue engine behind `ctx.tools.tickets`.
 *
 * Usable on its own (no Bot needed): give it a {@link TicketKeyValue} and it keeps an
 * in-memory index, loaded lazily on the first call and written through on every change.
 * Mutations are serialized, so concurrent `create()` calls never share an id. Callbacks
 * (`onCreate`, `onAssign`, `onClose`, `onUpdate`) run after the change is persisted and
 * outside the lock, so they may call back into the desk; their errors go to `onError`
 * and never fail the operation.
 *
 * Storage layout (keys under `keyPrefix`, default `tickets:`): `seq` (last id),
 * `index` (JSON array of the ids of NON-closed tickets) and `t:<id>` (one JSON ticket
 * each). Only active tickets live in memory and in the index, so both stay bounded by
 * the live workload; closed tickets stay in `t:<id>` and are read on demand (`get`, and
 * `list` when the filter can match `closed`, which scans `1..seq`).
 *
 * Memory changes only after the store writes succeed, so a failed write rejects the
 * call and leaves the desk as it was.
 */

import type {
  CreateTicketInput,
  CreatedTicket,
  Ticket,
  TicketFilter,
  TicketKeyValue,
  TicketPatch,
  TicketPriority,
  TicketStatus,
  TicketsApi,
} from './types.js'
import { TICKET_PRIORITIES, TICKET_STATUSES } from './types.js'
import { isWithinWorkingHours, parseWorkingHours, type WorkingHours, type WorkingHoursInput } from './workingHours.js'

/** Thrown by `update`/`assign`/`close` for an unknown ticket id. */
export class TicketNotFoundError extends Error {
  constructor(readonly ticketId: string) {
    super(`Ticket ${JSON.stringify(ticketId)} not found`)
    this.name = 'TicketNotFoundError'
  }
}

/** Where a callback error came from (second argument of `onError`). */
export type TicketCallbackName = 'onCreate' | 'onAssign' | 'onClose' | 'onUpdate'

export interface TicketDeskOptions {
  storage: TicketKeyValue
  /** Clock (epoch ms). Default `Date.now`. */
  now?: () => number
  /** See {@link WorkingHoursInput}. Without it the desk is always open. */
  workingHours?: WorkingHoursInput
  /** IANA timezone used to evaluate `workingHours`. Default: the process timezone. */
  timezone?: string
  /** Return the chat's existing non-closed ticket instead of opening another. Default `true`. */
  reuseOpen?: boolean
  /** Storage key prefix. Default `'tickets:'`. */
  keyPrefix?: string
  onCreate?: (ticket: CreatedTicket) => void | Promise<void>
  onAssign?: (ticket: Ticket) => void | Promise<void>
  onClose?: (ticket: Ticket) => void | Promise<void>
  onUpdate?: (ticket: Ticket, previous: Ticket) => void | Promise<void>
  onError?: (error: unknown, source: TicketCallbackName) => void
}

const READ_BATCH = 50

const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

function clone<T>(v: T): T { return structuredClone(v) }

function assertPriority(p: unknown): asserts p is TicketPriority {
  if (!TICKET_PRIORITIES.includes(p as TicketPriority)) {
    throw new Error(`Invalid ticket priority ${JSON.stringify(p)}; expected one of ${TICKET_PRIORITIES.join(', ')}`)
  }
}
function assertStatus(s: unknown): asserts s is TicketStatus {
  if (!TICKET_STATUSES.includes(s as TicketStatus)) {
    throw new Error(`Invalid ticket status ${JSON.stringify(s)}; expected one of ${TICKET_STATUSES.join(', ')}`)
  }
}

export class TicketDesk implements TicketsApi {
  private readonly storage: TicketKeyValue
  private readonly now: () => number
  private readonly hours?: WorkingHours
  private readonly prefix: string
  /** Active (non-closed) tickets only. */
  private tickets = new Map<string, Ticket>()
  private seq = 0
  private loaded?: Promise<void>
  private lock: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: TicketDeskOptions) {
    this.storage = opts.storage
    this.now = opts.now ?? Date.now
    this.prefix = opts.keyPrefix ?? 'tickets:'
    if (opts.workingHours !== undefined) this.hours = parseWorkingHours(opts.workingHours)
    if (opts.timezone !== undefined) new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone }) // throws on an unknown zone
  }

  /* ---------------------------------------------------------------- reads */

  async get(id: string): Promise<Ticket | undefined> {
    await this.load()
    const t = this.tickets.get(String(id)) ?? await this.readClosed(String(id))
    return t ? clone(t) : undefined
  }

  async list(filter: TicketFilter = {}): Promise<Ticket[]> {
    await this.load()
    const statuses = filter.status === undefined ? undefined : ([] as TicketStatus[]).concat(filter.status)
    const all = [...this.tickets.values()]
    if (statuses === undefined || statuses.includes('closed')) {
      const ids: string[] = []
      for (let i = 1; i <= this.seq; i++) if (!this.tickets.has(String(i))) ids.push(String(i))
      for (const t of await this.readMany(ids)) if (t.status === 'closed') all.push(t)
    }
    return all
      .filter((t) =>
        (statuses === undefined || statuses.includes(t.status))
        && (filter.chatId === undefined || t.chatId === filter.chatId)
        && (filter.assignee === undefined || t.assignee === filter.assignee)
        && (filter.priority === undefined || t.priority === filter.priority))
      .sort((a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id))
      .map(clone)
  }

  async queue(): Promise<Ticket[]> {
    await this.load()
    return this.queued().map(clone)
  }

  async position(id: string): Promise<number | null> {
    await this.load()
    const i = this.queued().findIndex((t) => t.id === String(id))
    return i === -1 ? null : i + 1
  }

  isOpen(date: Date = new Date(this.now())): boolean {
    return this.hours === undefined ? true : isWithinWorkingHours(this.hours, date, this.opts.timezone)
  }

  /* ------------------------------------------------------------ mutations */

  async create(input: CreateTicketInput): Promise<CreatedTicket> {
    if (!input || typeof input.chatId !== 'string' || input.chatId === '') throw new Error('tickets.create: chatId must be a non-empty string')
    if (typeof input.subject !== 'string') throw new Error('tickets.create: subject must be a string')
    const priority = input.priority ?? 'normal'
    assertPriority(priority)

    const { result, created } = await this.serial(async () => {
      if (this.opts.reuseOpen !== false) {
        const existing = [...this.tickets.values()].find((t) => t.chatId === input.chatId && t.status !== 'closed')
        if (existing) return { result: existing, created: false }
      }
      const at = this.now()
      const id = String(this.seq + 1)
      const ticket: Ticket = {
        id,
        chatId: input.chatId,
        subject: input.subject,
        priority,
        status: 'open',
        ...(input.meta !== undefined ? { meta: clone(input.meta) } : {}),
        createdAt: at,
        updatedAt: at,
      }
      // seq first: if a later write fails the id is just skipped (never reused for
      // a ticket that might already sit in t:<id>).
      await this.storage.set(`${this.prefix}seq`, id)
      this.seq = Number(id)
      await this.writeTicket(ticket)
      await this.writeIndex([...this.tickets.keys(), id])
      this.tickets.set(id, ticket)
      return { result: ticket, created: true }
    })

    const pos = this.queued().findIndex((t) => t.id === result.id)
    const out: CreatedTicket = {
      ...clone(result),
      created,
      position: pos === -1 ? null : pos + 1,
      withinWorkingHours: this.isOpen(),
    }
    if (created) await this.fire('onCreate', () => this.opts.onCreate?.(clone(out)))
    return out
  }

  update(id: string, patch: TicketPatch): Promise<Ticket> {
    return this.apply(id, patch)
  }

  assign(id: string, assignee: string): Promise<Ticket> {
    return this.update(id, { assignee, status: 'assigned' })
  }

  private async apply(id: string, patch: TicketPatch, closeReason?: string): Promise<Ticket> {
    if (patch.priority !== undefined) assertPriority(patch.priority)
    if (patch.status !== undefined) assertStatus(patch.status)
    if (patch.assignee !== undefined && patch.assignee !== null && (typeof patch.assignee !== 'string' || patch.assignee === '')) {
      throw new Error('tickets.update: assignee must be a non-empty string or null')
    }
    const { next, previous } = await this.serial(async () => {
      const cur = this.tickets.get(String(id)) ?? await this.readClosed(String(id))
      if (!cur) throw new TicketNotFoundError(String(id))
      const previous = clone(cur)
      const next: Ticket = { ...cur }
      if (patch.subject !== undefined) next.subject = patch.subject
      if (patch.priority !== undefined) next.priority = patch.priority
      if (patch.meta !== undefined) next.meta = clone(patch.meta)
      if (patch.assignee !== undefined) {
        if (patch.assignee === null) {
          delete next.assignee
          if (next.status === 'assigned') next.status = 'open'
        } else {
          next.assignee = patch.assignee
          if (next.status === 'open' || next.status === 'pending') next.status = 'assigned'
        }
      }
      if (patch.status !== undefined) next.status = patch.status
      if (next.status === 'closed' && previous.status !== 'closed') next.closedAt = this.now()
      if (next.status !== 'closed') { delete next.closedAt; delete next.closeReason }
      else if (closeReason !== undefined) next.closeReason = closeReason
      next.updatedAt = Math.max(this.now(), previous.updatedAt + 1)
      await this.writeTicket(next)
      const wasActive = previous.status !== 'closed'
      const isActive = next.status !== 'closed'
      if (wasActive !== isActive) {
        const ids = [...this.tickets.keys()].filter((k) => k !== next.id)
        if (isActive) ids.push(next.id)
        try {
          await this.writeIndex(ids)
        } catch (error) {
          // Best effort: put the previous ticket back so storage matches memory.
          await this.writeTicket(previous).catch(() => undefined)
          throw error
        }
      }
      if (isActive) this.tickets.set(next.id, next)
      else this.tickets.delete(next.id)
      return { next, previous }
    })

    await this.fire('onUpdate', () => this.opts.onUpdate?.(clone(next), previous))
    const newlyAssigned = next.assignee !== undefined && next.assignee !== previous.assignee && next.status === 'assigned'
    if (newlyAssigned) await this.fire('onAssign', () => this.opts.onAssign?.(clone(next)))
    if (next.status === 'closed' && previous.status !== 'closed') await this.fire('onClose', () => this.opts.onClose?.(clone(next)))
    return clone(next)
  }

  close(id: string, opts: { reason?: string } = {}): Promise<Ticket> {
    return this.apply(id, { status: 'closed' }, opts.reason)
  }

  /* ------------------------------------------------------------- internals */

  private queued(): Ticket[] {
    return [...this.tickets.values()]
      .filter((t) => t.status === 'open')
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt || Number(a.id) - Number(b.id))
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const seq = Number(await this.storage.get(`${this.prefix}seq`))
      const rawIndex = await this.storage.get(`${this.prefix}index`)
      const parsed: unknown = rawIndex ? JSON.parse(rawIndex) : []
      const ids = Array.isArray(parsed) ? parsed.map(String) : []
      const map = new Map<string, Ticket>()
      // Older indexes may still list closed tickets: they are simply not kept in memory.
      for (const t of await this.readMany(ids)) if (t.status !== 'closed') map.set(t.id, t)
      this.tickets = map
      const maxId = Math.max(0, ...ids.map(Number).filter(Number.isFinite))
      this.seq = Math.max(Number.isFinite(seq) ? seq : 0, maxId)
    })()
    // A failed load is retried on the next call instead of poisoning the desk.
    this.loaded.catch(() => { this.loaded = undefined })
    return this.loaded
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(() => this.load()).then(fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  private writeTicket(ticket: Ticket): Promise<void> {
    return this.storage.set(`${this.prefix}t:${ticket.id}`, JSON.stringify(ticket))
  }

  private writeIndex(activeIds: string[]): Promise<void> {
    return this.storage.set(`${this.prefix}index`, JSON.stringify(activeIds))
  }

  /** Read tickets by id, `READ_BATCH` reads at a time; missing ids are skipped. */
  private async readMany(ids: string[]): Promise<Ticket[]> {
    const out: Ticket[] = []
    for (let i = 0; i < ids.length; i += READ_BATCH) {
      const raws = await Promise.all(ids.slice(i, i + READ_BATCH).map((id) => this.storage.get(`${this.prefix}t:${id}`)))
      for (const raw of raws) if (raw) out.push(JSON.parse(raw) as Ticket)
    }
    return out
  }

  /** A closed ticket from storage (active ones always live in memory). */
  private async readClosed(id: string): Promise<Ticket | undefined> {
    if (this.tickets.has(id)) return undefined
    const [t] = await this.readMany([id])
    return t?.status === 'closed' ? t : undefined
  }

  private async fire(source: TicketCallbackName, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (error) {
      try { this.opts.onError?.(error, source) } catch { /* never let reporting fail the operation */ }
    }
  }
}
