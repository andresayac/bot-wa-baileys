/**
 * The bakery's business logic: menu, pricing and orders.
 *
 * Nothing here knows about WhatsApp, Twilio or the AI model. Money is always
 * computed here (integer cents) and formatted with `Intl.NumberFormat`, so the
 * model only ever repeats totals that this code produced.
 */

/** Currency and locale used to format prices. Change both to localize the shop. */
export const CURRENCY = 'USD'
export const LOCALE = 'en-US'

/** Max units of one product per order line. */
export const MAX_QUANTITY = 50

export interface MenuEntry {
  /** Human name shown to customers. */
  name: string
  /** Unit price in cents. */
  priceCents: number
}

/** The menu. Keys are the product ids the model must use (validated with a JSON Schema `enum`). */
export const MENU = {
  croissant: { name: 'Croissant', priceCents: 350 },
  cheese_bread: { name: 'Cheese bread', priceCents: 250 },
  chocolate_cake: { name: 'Chocolate cake', priceCents: 2800 },
  coffee: { name: 'Coffee', priceCents: 300 },
} as const satisfies Record<string, MenuEntry>

export type ProductId = keyof typeof MENU

/** Product ids in menu order. */
export const PRODUCT_IDS = Object.keys(MENU) as ProductId[]

/** Product id → human name (handy for `labels` in tool definitions). */
export const PRODUCT_NAMES: Record<ProductId, string> = Object.fromEntries(
  PRODUCT_IDS.map((id) => [id, MENU[id].name]),
) as Record<ProductId, string>

export interface OrderItem {
  product: ProductId
  quantity: number
}

export interface QuoteLine {
  product: ProductId
  name: string
  quantity: number
  unitPrice: string
  subtotal: string
}

export interface Quote {
  lines: QuoteLine[]
  totalCents: number
  /** Formatted total, e.g. `$12.50`. */
  total: string
}

const money = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY })

/** Format an amount in cents (`1250` → `$12.50`). */
export function formatMoney(cents: number): string {
  return money.format(cents / 100)
}

export function isProductId(value: unknown): value is ProductId {
  return typeof value === 'string' && Object.hasOwn(MENU, value)
}

/** The menu as the model sees it: id, name and formatted price. */
export function menuView(): Array<{ product: ProductId; name: string; price: string }> {
  return PRODUCT_IDS.map((product) => ({ product, name: MENU[product].name, price: formatMoney(MENU[product].priceCents) }))
}

/**
 * Price a list of items. Throws on an unknown product, a non-integer quantity
 * or an empty list (the tool schemas reject those first; this is the last line
 * of defense for any other caller).
 */
export function quote(items: readonly OrderItem[]): Quote {
  if (items.length === 0) throw new RangeError('An order needs at least one item')
  let totalCents = 0
  const lines = items.map(({ product, quantity }): QuoteLine => {
    if (!isProductId(product)) throw new RangeError(`Unknown product: ${String(product)}`)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new RangeError(`Quantity must be an integer between 1 and ${MAX_QUANTITY}`)
    }
    const { name, priceCents } = MENU[product]
    const subtotalCents = priceCents * quantity
    totalCents += subtotalCents
    return { product, name, quantity, unitPrice: formatMoney(priceCents), subtotal: formatMoney(subtotalCents) }
  })
  return { lines, totalCents, total: formatMoney(totalCents) }
}

/** Human lines of a quote, as shown in confirmations: `• 2 × Croissant: $7.00` … `Total: $10.00`. */
export function quoteLines(items: readonly OrderItem[]): string[] {
  const q = quote(items)
  return [...q.lines.map((l) => `• ${l.quantity} × ${l.name}: ${l.subtotal}`), `Total: ${q.total}`]
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                      */
/* -------------------------------------------------------------------------- */

export type OrderStatus = 'placed' | 'cancelled'

export interface Order {
  id: string
  /** Stable customer id (the bot's `ctx.sender`). */
  customerId: string
  items: OrderItem[]
  totalCents: number
  total: string
  status: OrderStatus
  createdAt: string
  updatedAt: string
}

/**
 * Where orders live. Every method is scoped to one customer, so a customer can
 * never read or change someone else's order. Async on purpose: swap the
 * in-memory implementation for a database without touching the tools.
 */
export interface OrderStore {
  /** Place a new order (priced with {@link quote}). */
  create(customerId: string, items: readonly OrderItem[]): Promise<Order>
  /** The customer's active (not cancelled) orders, oldest first. */
  list(customerId: string): Promise<Order[]>
  /** Replace the items of an active order. `undefined` when the customer has no such active order. */
  update(customerId: string, orderId: string, items: readonly OrderItem[]): Promise<Order | undefined>
  /** Cancel an active order. `undefined` when the customer has no such active order. */
  cancel(customerId: string, orderId: string): Promise<Order | undefined>
}

export interface InMemoryOrderStoreOptions {
  /** Clock (tests). Default `() => new Date()`. */
  now?: () => Date
  /** Number of the first order id (`B-<n>`). Default 1001. */
  firstNumber?: number
}

/** {@link OrderStore} kept in RAM: orders are lost on restart. Fine for a demo, not for production. */
export class InMemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, Order>()
  private readonly now: () => Date
  private next: number

  constructor(options: InMemoryOrderStoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.next = options.firstNumber ?? 1001
  }

  async create(customerId: string, items: readonly OrderItem[]): Promise<Order> {
    const q = quote(items)
    const at = this.now().toISOString()
    const order: Order = {
      id: `B-${this.next++}`,
      customerId,
      items: items.map((i) => ({ ...i })),
      totalCents: q.totalCents,
      total: q.total,
      status: 'placed',
      createdAt: at,
      updatedAt: at,
    }
    this.orders.set(order.id, order)
    return clone(order)
  }

  async list(customerId: string): Promise<Order[]> {
    return [...this.orders.values()].filter((o) => o.customerId === customerId && o.status === 'placed').map(clone)
  }

  async update(customerId: string, orderId: string, items: readonly OrderItem[]): Promise<Order | undefined> {
    const order = this.active(customerId, orderId)
    if (!order) return undefined
    const q = quote(items)
    order.items = items.map((i) => ({ ...i }))
    order.totalCents = q.totalCents
    order.total = q.total
    order.updatedAt = this.now().toISOString()
    return clone(order)
  }

  async cancel(customerId: string, orderId: string): Promise<Order | undefined> {
    const order = this.active(customerId, orderId)
    if (!order) return undefined
    order.status = 'cancelled'
    order.updatedAt = this.now().toISOString()
    return clone(order)
  }

  private active(customerId: string, orderId: string): Order | undefined {
    const order = this.orders.get(normalizeOrderId(orderId))
    return order && order.customerId === customerId && order.status === 'placed' ? order : undefined
  }
}

/** Accept `b-1001`, `1001` or `#1001` for `B-1001`: models and people write ids loosely. */
export function normalizeOrderId(id: string): string {
  const digits = /^\s*(?:#|b-?)?\s*(\d+)\s*$/i.exec(id)
  return digits ? `B-${digits[1]}` : id.trim()
}

function clone(order: Order): Order {
  return { ...order, items: order.items.map((i) => ({ ...i })) }
}
