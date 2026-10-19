import { describe, it, expect } from 'vitest'
import { InMemoryOrderStore, MENU, PRODUCT_IDS, formatMoney, menuView, normalizeOrderId, quote, quoteLines, type OrderItem } from '../src/shop.js'

describe('pricing', () => {
  it('formats cents as USD', () => {
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(350)).toBe('$3.50')
    expect(formatMoney(123456)).toBe('$1,234.56')
  })

  it('lists the menu with formatted prices', () => {
    expect(menuView()).toEqual([
      { product: 'croissant', name: 'Croissant', price: '$3.50' },
      { product: 'cheese_bread', name: 'Cheese bread', price: '$2.50' },
      { product: 'chocolate_cake', name: 'Chocolate cake', price: '$28.00' },
      { product: 'coffee', name: 'Coffee', price: '$3.00' },
    ])
    expect(PRODUCT_IDS).toEqual(Object.keys(MENU))
  })

  it('quotes subtotals and the total in integer cents', () => {
    const q = quote([
      { product: 'croissant', quantity: 3 },
      { product: 'cheese_bread', quantity: 7 },
      { product: 'coffee', quantity: 2 },
    ])
    expect(q.totalCents).toBe(3 * 350 + 7 * 250 + 2 * 300)
    expect(q.total).toBe('$34.00')
    expect(q.lines.map((l) => l.subtotal)).toEqual(['$10.50', '$17.50', '$6.00'])
    expect(q.lines[1]).toMatchObject({ name: 'Cheese bread', unitPrice: '$2.50', quantity: 7 })
  })

  it('renders confirmation lines with human names', () => {
    expect(quoteLines([{ product: 'chocolate_cake', quantity: 1 }, { product: 'croissant', quantity: 2 }])).toEqual([
      '• 1 × Chocolate cake: $28.00',
      '• 2 × Croissant: $7.00',
      'Total: $35.00',
    ])
  })

  it('rejects unknown products, bad quantities and empty orders', () => {
    expect(() => quote([])).toThrow(/at least one item/)
    expect(() => quote([{ product: 'bagel', quantity: 1 } as unknown as OrderItem])).toThrow(/Unknown product/)
    expect(() => quote([{ product: 'coffee', quantity: 0 }])).toThrow(/Quantity/)
    expect(() => quote([{ product: 'coffee', quantity: 1.5 }])).toThrow(/Quantity/)
    expect(() => quote([{ product: 'coffee', quantity: 51 }])).toThrow(/Quantity/)
  })
})

describe('InMemoryOrderStore', () => {
  const at = new Date('2026-10-18T10:00:00Z')
  const store = () => new InMemoryOrderStore({ now: () => at })

  it('creates priced orders with sequential ids', async () => {
    const s = store()
    const a = await s.create('alice', [{ product: 'croissant', quantity: 2 }])
    const b = await s.create('alice', [{ product: 'coffee', quantity: 1 }])
    expect(a).toMatchObject({ id: 'B-1001', customerId: 'alice', totalCents: 700, total: '$7.00', status: 'placed', createdAt: at.toISOString() })
    expect(b.id).toBe('B-1002')
    expect((await s.list('alice')).map((o) => o.id)).toEqual(['B-1001', 'B-1002'])
  })

  it('scopes orders to their customer', async () => {
    const s = store()
    const order = await s.create('alice', [{ product: 'croissant', quantity: 1 }])
    expect(await s.list('bob')).toEqual([])
    expect(await s.update('bob', order.id, [{ product: 'coffee', quantity: 9 }])).toBeUndefined()
    expect(await s.cancel('bob', order.id)).toBeUndefined()
    expect((await s.list('alice'))[0]?.total).toBe('$3.50')
  })

  it('updates the items and re-prices the order', async () => {
    const s = store()
    const order = await s.create('alice', [{ product: 'croissant', quantity: 1 }])
    const updated = await s.update('alice', order.id, [{ product: 'chocolate_cake', quantity: 1 }, { product: 'coffee', quantity: 2 }])
    expect(updated).toMatchObject({ id: order.id, totalCents: 3400, total: '$34.00' })
    expect((await s.list('alice'))[0]?.items).toEqual([{ product: 'chocolate_cake', quantity: 1 }, { product: 'coffee', quantity: 2 }])
  })

  it('cancels an order once; cancelled orders are no longer listed or changed', async () => {
    const s = store()
    const order = await s.create('alice', [{ product: 'croissant', quantity: 1 }])
    expect(await s.cancel('alice', order.id)).toMatchObject({ status: 'cancelled' })
    expect(await s.cancel('alice', order.id)).toBeUndefined()
    expect(await s.update('alice', order.id, [{ product: 'coffee', quantity: 1 }])).toBeUndefined()
    expect(await s.list('alice')).toEqual([])
  })

  it('returns copies: callers cannot mutate stored orders', async () => {
    const s = store()
    const order = await s.create('alice', [{ product: 'croissant', quantity: 1 }])
    order.items[0]!.quantity = 40
    order.status = 'cancelled'
    expect(await s.list('alice')).toMatchObject([{ status: 'placed', items: [{ quantity: 1 }] }])
  })

  it('accepts loosely written order ids', async () => {
    expect(normalizeOrderId('B-1001')).toBe('B-1001')
    expect(normalizeOrderId('b1001')).toBe('B-1001')
    expect(normalizeOrderId('#1001')).toBe('B-1001')
    expect(normalizeOrderId(' 1001 ')).toBe('B-1001')
    expect(normalizeOrderId('X-1')).toBe('X-1')
    const s = store()
    await s.create('alice', [{ product: 'croissant', quantity: 1 }])
    expect(await s.cancel('alice', '#1001')).toMatchObject({ id: 'B-1001', status: 'cancelled' })
  })
})
