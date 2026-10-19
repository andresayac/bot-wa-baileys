/**
 * The tools the model may call. Read-only tools (menu, quote, list) run
 * freely; tools with side effects (create, update, cancel) ask the customer
 * first (`confirm: true`) and show totals computed by `shop.ts`.
 *
 * Practices applied (see docs/guide/ai-tools.md, "Best practices for
 * side-effecting tools"): money computed in code, catalog values validated
 * with `enum`, a quote tool, update/cancel/list next to create, `dedupe` on
 * create, and an explicit `{ error }` for unknown order ids.
 */
import { defineTool, type AIToolContext, type AIToolSet, type JSONSchema } from '@bot-wa/ai'
import {
  MAX_QUANTITY,
  PRODUCT_IDS,
  PRODUCT_NAMES,
  menuView,
  quote,
  quoteLines,
  type Order,
  type OrderItem,
  type OrderStore,
} from './shop.js'

/** Tool names, exported so tests and logs don't repeat string literals. */
export const TOOL = {
  viewMenu: 'view_menu',
  quoteOrder: 'quote_order',
  myOrders: 'my_orders',
  createOrder: 'create_order',
  updateOrder: 'update_order',
  cancelOrder: 'cancel_order',
} as const

/** Order lines: only real products (enum) and sane quantities. Validated before any confirmation. */
const ITEMS: JSONSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  description: 'Products and quantities. Use the product ids returned by view_menu.',
  items: {
    type: 'object',
    properties: {
      product: { type: 'string', enum: PRODUCT_IDS },
      quantity: { type: 'integer', minimum: 1, maximum: MAX_QUANTITY },
    },
    required: ['product', 'quantity'],
    additionalProperties: false,
  },
}

const ORDER_ID: JSONSchema = { type: 'string', description: 'Order id as returned by my_orders or create_order, e.g. "B-1001".' }

/** What the default confirmation prompt shows instead of raw product ids (used where `confirmLines` is not set). */
const LABELS = { product: PRODUCT_NAMES }

interface ItemsArgs { items: OrderItem[] }
interface OrderIdArgs { orderId: string }
interface UpdateArgs extends OrderIdArgs, ItemsArgs {}

/** The customer behind a tool call: the stable sender id of the chat turn. */
function customerOf(tctx: AIToolContext): string | undefined {
  return tctx.ctx?.sender || undefined
}

const NO_CUSTOMER = { error: 'No customer for this call: orders can only be managed from a chat.' }
const noOrder = (orderId: string) => ({ error: `No active order ${orderId} for this customer. Call my_orders to get the ids.` })

/** The order as the model sees it: no internal fields, money already formatted. */
function view(order: Order) {
  const q = quote(order.items)
  return { orderId: order.id, status: order.status, lines: q.lines, total: order.total }
}

export interface BakeryToolsOptions {
  /** Called after every order change (logging, notifications, a kitchen screen...). */
  onOrderChange?: (change: { action: 'created' | 'updated' | 'cancelled'; order: Order }) => void
}

/** Build the bakery's tool set on top of an {@link OrderStore}. */
export function createBakeryTools(store: OrderStore, options: BakeryToolsOptions = {}): AIToolSet {
  const changed = options.onOrderChange ?? (() => {})

  return {
    [TOOL.viewMenu]: defineTool({
      title: 'View menu',
      description: 'List the menu: product id, name and price. Call it before quoting or ordering if you are unsure of a product id.',
      handler: () => menuView(),
    }),

    [TOOL.quoteOrder]: defineTool<ItemsArgs>({
      title: 'Quote order',
      description:
        'Compute the exact prices, subtotals and total of a list of products without placing anything. ' +
        'Always use it for "how much is...?" instead of calculating yourself.',
      schema: { type: 'object', properties: { items: ITEMS }, required: ['items'], additionalProperties: false },
      handler: ({ items }) => {
        const q = quote(items)
        return { lines: q.lines, total: q.total }
      },
    }),

    [TOOL.myOrders]: defineTool({
      title: 'My orders',
      description: "List the customer's active orders with their id, items and total. Use it to find the id to update or cancel.",
      handler: async (_args, tctx) => {
        const customer = customerOf(tctx)
        if (!customer) return NO_CUSTOMER
        const orders = await store.list(customer)
        return orders.length ? orders.map(view) : { orders: [], note: 'The customer has no active orders.' }
      },
    }),

    [TOOL.createOrder]: defineTool<ItemsArgs>({
      title: 'Place order',
      description: 'Place a NEW order. Do not use it to change an existing order (use update_order).',
      schema: { type: 'object', properties: { items: ITEMS }, required: ['items'], additionalProperties: false },
      confirm: true,
      // The same order twice in a row (the model calling again on its own) is not placed again.
      dedupe: 'args',
      labels: LABELS,
      // The customer confirms numbers computed here, never by the model.
      confirmLines: ({ items }) => quoteLines(items),
      handler: async ({ items }, tctx) => {
        const customer = customerOf(tctx)
        if (!customer) return NO_CUSTOMER
        const order = await store.create(customer, items)
        changed({ action: 'created', order })
        return view(order)
      },
    }),

    [TOOL.updateOrder]: defineTool<UpdateArgs>({
      title: 'Change order',
      description: 'Replace ALL the items of an existing active order (by id) with the complete new list.',
      schema: {
        type: 'object',
        properties: { orderId: ORDER_ID, items: ITEMS },
        required: ['orderId', 'items'],
        additionalProperties: false,
      },
      confirm: true,
      labels: LABELS,
      confirmLines: ({ orderId, items }) => [`Order ${orderId}`, ...quoteLines(items)],
      handler: async ({ orderId, items }, tctx) => {
        const customer = customerOf(tctx)
        if (!customer) return NO_CUSTOMER
        const order = await store.update(customer, orderId, items)
        if (!order) return noOrder(orderId)
        changed({ action: 'updated', order })
        return view(order)
      },
    }),

    [TOOL.cancelOrder]: defineTool<OrderIdArgs>({
      title: 'Cancel order',
      description: 'Cancel an existing active order by id.',
      schema: { type: 'object', properties: { orderId: ORDER_ID }, required: ['orderId'], additionalProperties: false },
      confirm: true,
      confirmLines: ({ orderId }) => [`Order ${orderId}`],
      handler: async ({ orderId }, tctx) => {
        const customer = customerOf(tctx)
        if (!customer) return NO_CUSTOMER
        const order = await store.cancel(customer, orderId)
        if (!order) return noOrder(orderId)
        changed({ action: 'cancelled', order })
        return { orderId: order.id, status: order.status }
      },
    }),
  }
}
