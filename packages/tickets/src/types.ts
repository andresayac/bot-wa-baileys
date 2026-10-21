import type { ChatId } from '@botmesh/core'

/** Ticket priority, highest first: `urgent` > `high` > `normal` > `low`. */
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'

/**
 * Ticket lifecycle:
 *  - `open` — waiting in the queue for an agent;
 *  - `assigned` — an agent owns it (out of the queue);
 *  - `pending` — waiting on the customer (out of the queue);
 *  - `closed` — done.
 */
export type TicketStatus = 'open' | 'assigned' | 'pending' | 'closed'

export const TICKET_PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent']
export const TICKET_STATUSES: readonly TicketStatus[] = ['open', 'assigned', 'pending', 'closed']

/** A support ticket (JSON-serializable). */
export interface Ticket {
  /** Sequential id as a string (`'1'`, `'2'`, …), unique per bot namespace. */
  id: string
  /** The chat the ticket belongs to (opaque id, usually `ctx.from`). */
  chatId: ChatId
  subject: string
  priority: TicketPriority
  status: TicketStatus
  /** Agent that owns the ticket (free-form id or name). */
  assignee?: string
  /** Host-defined, JSON-serializable metadata. */
  meta?: Record<string, unknown>
  createdAt: number
  updatedAt: number
  closedAt?: number
  closeReason?: string
}

/** Input of `tickets.create()`. */
export interface CreateTicketInput {
  chatId: ChatId
  subject: string
  /** Default `'normal'`. */
  priority?: TicketPriority
  meta?: Record<string, unknown>
}

/** What `tickets.create()` resolves with. */
export interface CreatedTicket extends Ticket {
  /** `false` when an existing open ticket of the same chat was returned (`reuseOpen`). */
  created: boolean
  /** 1-based queue position, or `null` when the ticket is not queued. */
  position: number | null
  /** Whether the ticket was created inside the configured working hours. */
  withinWorkingHours: boolean
}

/** Patch accepted by `tickets.update()`. `assignee: null` unassigns (back to the queue). */
export interface TicketPatch {
  subject?: string
  priority?: TicketPriority
  status?: TicketStatus
  assignee?: string | null
  /** Replaces the whole `meta` object. */
  meta?: Record<string, unknown>
}

/** Filter for `tickets.list()`; every given field must match. */
export interface TicketFilter {
  status?: TicketStatus | TicketStatus[]
  chatId?: ChatId
  assignee?: string
  priority?: TicketPriority
}

/** `ctx.tools.tickets` — the public API of the tickets plugin. */
export interface TicketsApi {
  /** Create a ticket (or return the chat's open one when `reuseOpen` is on). */
  create(input: CreateTicketInput): Promise<CreatedTicket>
  get(id: string): Promise<Ticket | undefined>
  /** Apply a patch; rejects with `TicketNotFoundError` for an unknown id. */
  update(id: string, patch: TicketPatch): Promise<Ticket>
  /** All tickets matching `filter`, oldest first. */
  list(filter?: TicketFilter): Promise<Ticket[]>
  /** Assign to an agent (status `assigned`); fires `onAssign`. */
  assign(id: string, assignee: string): Promise<Ticket>
  /** Close a ticket; fires `onClose`. */
  close(id: string, opts?: { reason?: string }): Promise<Ticket>
  /** The queue: `open` tickets by priority, then age. */
  queue(): Promise<Ticket[]>
  /** 1-based queue position, or `null` when the ticket is not queued / unknown. */
  position(id: string): Promise<number | null>
  /** Whether `date` (default now) is inside the working hours (always `true` without them). */
  isOpen(date?: Date): boolean
}

/**
 * Minimal string key/value the ticket desk persists to. The plugin's default maps it
 * to the bot store's cursor API (`IStore.getCursor`/`setCursor`, namespaced per bot).
 */
export interface TicketKeyValue {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}
