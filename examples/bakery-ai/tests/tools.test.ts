import { describe, it, expect } from 'vitest'
import { validateArgs, type AITool, type AIToolContext } from '@botmesh/ai'
import type { MessageContext } from '@botmesh/core'
import { TOOL, createBakeryTools } from '../src/tools.js'
import { InMemoryOrderStore, type Order } from '../src/shop.js'

function setup() {
  const store = new InMemoryOrderStore()
  const changes: Array<{ action: string; order: Order }> = []
  const tools = createBakeryTools(store, { onOrderChange: (c) => changes.push(c) })
  const tool = (name: string): AITool<unknown> => {
    const t = tools[name]
    if (!t) throw new Error(`missing tool ${name}`)
    return t
  }
  /** Validate like the tool loop does, then run the handler as `customer`. */
  const call = async (name: string, args: unknown, customer: string | null = 'alice') => {
    const v = validateArgs(tool(name), args)
    if (!v.ok) throw new Error(`invalid args: ${v.error}`)
    const tctx: AIToolContext = {
      tool: name,
      callId: 'call-1',
      signal: new AbortController().signal,
      ...(customer ? { ctx: { sender: customer } as MessageContext } : {}),
    }
    return tool(name).handler(v.data, tctx)
  }
  return { store, tools, tool, call, changes }
}

const twoCroissantsAndCoffee = { items: [{ product: 'croissant', quantity: 2 }, { product: 'coffee', quantity: 1 }] }

describe('bakery tools', () => {
  it('exposes the six tools with English names', () => {
    expect(Object.keys(setup().tools)).toEqual(['view_menu', 'quote_order', 'my_orders', 'create_order', 'update_order', 'cancel_order'])
  })

  it('asks for confirmation only on side effects, and dedupes creates', () => {
    const { tool } = setup()
    for (const name of [TOOL.viewMenu, TOOL.quoteOrder, TOOL.myOrders]) expect(tool(name).confirm).toBeFalsy()
    for (const name of [TOOL.createOrder, TOOL.updateOrder, TOOL.cancelOrder]) expect(tool(name).confirm).toBe(true)
    expect(tool(TOOL.createOrder).dedupe).toBe('args')
  })

  it('validates products with an enum and quantities as positive integers', () => {
    const { tool } = setup()
    const create = tool(TOOL.createOrder)
    expect(validateArgs(create, twoCroissantsAndCoffee).ok).toBe(true)
    const bad = validateArgs(create, { items: [{ product: 'bagel', quantity: 1 }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/must be one of "croissant", "cheese_bread", "chocolate_cake", "coffee"/)
    expect(validateArgs(create, { items: [{ product: 'coffee', quantity: 0 }] }).ok).toBe(false)
    expect(validateArgs(create, { items: [{ product: 'coffee', quantity: 1.5 }] }).ok).toBe(false)
    expect(validateArgs(create, { items: [] }).ok).toBe(false)
    expect(validateArgs(create, { items: [{ product: 'coffee', quantity: 1, price: 0 }] }).ok).toBe(false)
  })

  it('shows code-computed totals in the confirmation', () => {
    const { tool } = setup()
    expect(tool(TOOL.createOrder).confirmLines?.(twoCroissantsAndCoffee)).toEqual([
      '• 2 × Croissant: $7.00',
      '• 1 × Coffee: $3.00',
      'Total: $10.00',
    ])
    expect(tool(TOOL.updateOrder).confirmLines?.({ orderId: 'B-1001', items: [{ product: 'chocolate_cake', quantity: 1 }] })).toEqual([
      'Order B-1001',
      '• 1 × Chocolate cake: $28.00',
      'Total: $28.00',
    ])
  })

  it('view_menu and quote_order are read-only', async () => {
    const { call, store } = setup()
    expect(await call(TOOL.viewMenu, {})).toHaveLength(4)
    expect(await call(TOOL.quoteOrder, twoCroissantsAndCoffee)).toMatchObject({ total: '$10.00' })
    expect(await store.list('alice')).toEqual([])
  })

  it('creates, lists, updates and cancels the caller’s orders', async () => {
    const { call, changes } = setup()
    expect(await call(TOOL.createOrder, twoCroissantsAndCoffee)).toMatchObject({ orderId: 'B-1001', status: 'placed', total: '$10.00' })
    expect(await call(TOOL.myOrders, {})).toMatchObject([{ orderId: 'B-1001', total: '$10.00' }])
    expect(await call(TOOL.updateOrder, { orderId: 'B-1001', items: [{ product: 'croissant', quantity: 3 }] })).toMatchObject({ total: '$10.50' })
    expect(await call(TOOL.cancelOrder, { orderId: 'B-1001' })).toEqual({ orderId: 'B-1001', status: 'cancelled' })
    expect(await call(TOOL.myOrders, {})).toMatchObject({ orders: [] })
    expect(changes.map((c) => c.action)).toEqual(['created', 'updated', 'cancelled'])
  })

  it('returns an explicit { error } for unknown or foreign order ids', async () => {
    const { call } = setup()
    await call(TOOL.createOrder, twoCroissantsAndCoffee, 'alice')
    expect(await call(TOOL.cancelOrder, { orderId: 'B-9999' })).toEqual({ error: expect.stringMatching(/No active order B-9999.*my_orders/) })
    expect(await call(TOOL.cancelOrder, { orderId: 'B-1001' }, 'bob')).toHaveProperty('error')
    expect(await call(TOOL.updateOrder, { orderId: 'B-1001', items: [{ product: 'coffee', quantity: 1 }] }, 'bob')).toHaveProperty('error')
  })

  it('refuses to touch orders outside a chat', async () => {
    const { call } = setup()
    expect(await call(TOOL.createOrder, twoCroissantsAndCoffee, null)).toHaveProperty('error')
    expect(await call(TOOL.myOrders, {}, null)).toHaveProperty('error')
  })
})
