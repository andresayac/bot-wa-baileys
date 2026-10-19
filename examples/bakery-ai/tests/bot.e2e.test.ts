/**
 * End to end: the real bot (plugins, whitelist, tools, confirmations) on a
 * MockProvider, with a scripted MockAIProvider standing in for the model.
 * No network, no credentials.
 */
import { afterEach, describe, it, expect } from 'vitest'
import { MockProvider, type MockOutgoing } from '@bot-wa/core/testing'
import { MockAIProvider, type GenerateInput, type MockTurn } from '@bot-wa/ai'
import type { Bot } from '@bot-wa/core'
import { createBakeryBot, GREETING } from '../src/bot.js'
import { InMemoryOrderStore } from '../src/shop.js'

const ALICE = 'alice@example'
const STRANGER = 'stranger@example'

const call = (name: string, args: unknown): MockTurn => ({ toolCalls: [{ name, args }] })

/**
 * A fake model: picks a tool from keywords in the user's message and, once
 * the tool ran, answers with its raw result so the tests can assert on it.
 */
function scriptedModel(): MockAIProvider {
  return new MockAIProvider({
    reply: (input: GenerateInput) => {
      const last = input.messages[input.messages.length - 1]
      if (last?.role === 'tool') return last.results.map((r) => `[${r.name}] ${r.content}`).join('\n')
      const text = last?.role === 'user' ? last.content.toLowerCase() : ''
      if (text.includes('menu')) return call('view_menu', {})
      if (text.includes('how much')) return call('quote_order', { items: [{ product: 'chocolate_cake', quantity: 2 }] })
      if (text.includes('two croissants')) {
        return call('create_order', { items: [{ product: 'croissant', quantity: 2 }, { product: 'coffee', quantity: 1 }] })
      }
      if (text.includes('bagel')) return call('create_order', { items: [{ product: 'bagel', quantity: 1 }] })
      if (text.includes('three croissants')) {
        return call('update_order', { orderId: 'B-1001', items: [{ product: 'croissant', quantity: 3 }, { product: 'coffee', quantity: 1 }] })
      }
      if (text.includes('cancel b-9999')) return call('cancel_order', { orderId: 'B-9999' })
      if (text.includes('cancel')) return call('cancel_order', { orderId: 'B-1001' })
      if (text.includes('my orders')) return call('my_orders', {})
      return 'I can only help with the bakery.'
    },
  })
}

const textOf = (m: MockOutgoing): string => (m.content.kind === 'text' ? m.content.text : '')

/** Drives one chat and reads its replies in order. */
function chat(provider: MockProvider, from: string, opts: { isGroup?: boolean; sender?: string } = {}) {
  let cursor = 0
  const replies = () => provider.outbox.filter((m) => m.chatId === from).map(textOf)
  return {
    replies,
    async send(text: string) {
      provider.incoming(text, { from, ...opts })
      await new Promise((r) => setTimeout(r, 0))
    },
    /** The next reply after the previous match that matches `matcher`. */
    expectReply(matcher: string | RegExp, timeoutMs = 1000): Promise<string> {
      const hit = (s: string) => (typeof matcher === 'string' ? s.includes(matcher) : matcher.test(s))
      const deadline = Date.now() + timeoutMs
      return new Promise((resolve, reject) => {
        const scan = () => {
          const all = replies()
          for (; cursor < all.length; cursor++) {
            if (hit(all[cursor]!)) return resolve(all[cursor++]!)
          }
          if (Date.now() > deadline) return reject(new Error(`No reply matching ${String(matcher)}. Replies: ${JSON.stringify(all)}`))
          setTimeout(scan, 5)
        }
        scan()
      })
    },
  }
}

let bot: Bot | undefined
afterEach(async () => {
  await bot?.stop()
  bot = undefined
})

async function startBakery() {
  // Both channels of the example (Baileys, Twilio sandbox) have no native buttons.
  const provider = new MockProvider({ buttons: false })
  const model = scriptedModel()
  const orders = new InMemoryOrderStore()
  bot = createBakeryBot(provider, { aiProvider: model, orders, allowedUsers: [ALICE], ai: { memory: false } })
  await bot.start()
  return { provider, model, orders, alice: chat(provider, ALICE) }
}

describe('bakery bot (end to end)', () => {
  it('greets on /start and answers menu questions through view_menu', async () => {
    const { alice } = await startBakery()
    await alice.send('/start')
    await alice.expectReply(GREETING)
    await alice.send('what is on the menu?')
    const menu = await alice.expectReply('[view_menu]')
    expect(menu).toContain('"Cheese bread"')
    expect(menu).toContain('"$28.00"')
  })

  it('places, changes and cancels an order with English confirmations', async () => {
    const { alice, orders } = await startBakery()

    await alice.send('two croissants and a coffee, please')
    const confirm = await alice.expectReply('Do you confirm?')
    expect(confirm).toBe('About to: Place order\n• 2 × Croissant: $7.00\n• 1 × Coffee: $3.00\nTotal: $10.00\nDo you confirm? (yes/no)')
    expect(await orders.list(ALICE)).toEqual([]) // nothing placed before the "yes"
    await alice.send('yes')
    await alice.expectReply(/\[create_order\] .*"orderId":"B-1001".*"total":"\$10\.00"/)
    expect(await orders.list(ALICE)).toMatchObject([{ id: 'B-1001', total: '$10.00' }])

    await alice.send('make it three croissants')
    expect(await alice.expectReply('Do you confirm?')).toContain('Order B-1001\n• 3 × Croissant: $10.50\n• 1 × Coffee: $3.00\nTotal: $13.50')
    await alice.send('yes')
    await alice.expectReply(/\[update_order\] .*"total":"\$13\.50"/)

    await alice.send('cancel my order')
    expect(await alice.expectReply('Do you confirm?')).toContain('Cancel order\nOrder B-1001')
    await alice.send('yes')
    await alice.expectReply('[cancel_order] {"orderId":"B-1001","status":"cancelled"}')
    expect(await orders.list(ALICE)).toEqual([])
  })

  it('keeps its built-in texts in English whatever language the client reports', async () => {
    // A Telegram client in Spanish reports language_code "es" on some updates only.
    const provider = new MockProvider({ buttons: true })
    bot = createBakeryBot(provider, { aiProvider: scriptedModel(), allowedUsers: [ALICE], ai: { memory: false } })
    await bot.start()
    const asks = () => provider.outbox.filter((m) => m.content.kind === 'buttons').map((m) => m.content as Extract<MockOutgoing['content'], { kind: 'buttons' }>)
    const ask = async (text: string, platformData?: Record<string, unknown>) => {
      provider.incoming(text, { from: ALICE, ...(platformData ? { platformData } : {}) })
      await new Promise((r) => setTimeout(r, 50))
      const last = asks().at(-1)!
      provider.interaction(last.buttons[1]!.id, { from: ALICE, platformData: { languageCode: 'es' } })
      await new Promise((r) => setTimeout(r, 50))
      return last
    }
    const first = await ask('two croissants and a coffee')
    const second = await ask('two croissants and a coffee', { languageCode: 'es' })
    for (const q of [first, second]) {
      expect(q.text).toMatch(/^About to: Place order\n[\s\S]*\nDo you confirm\?$/)
      expect(q.buttons.map((b) => b.title)).toEqual(['Yes', 'No'])
    }
  })

  it('does nothing when the customer says no', async () => {
    const { alice, orders } = await startBakery()
    await alice.send('two croissants and a coffee')
    await alice.expectReply('Do you confirm?')
    await alice.send('no')
    await alice.expectReply(/\[create_order\] .*declined/)
    expect(await orders.list(ALICE)).toEqual([])
  })

  it('does not place the same order twice in a row (dedupe)', async () => {
    const { alice, orders } = await startBakery()
    await alice.send('two croissants and a coffee')
    await alice.expectReply('Do you confirm?')
    await alice.send('yes')
    await alice.expectReply('[create_order]')

    await alice.send('two croissants and a coffee')
    // Not asked again, not run again: the model is told it was a duplicate.
    const dup = await alice.expectReply('[create_order]')
    expect(dup).toContain('"reason":"duplicate"')
    expect(alice.replies().filter((r) => r.includes('Do you confirm?'))).toHaveLength(1)
    expect(await orders.list(ALICE)).toHaveLength(1)
  })

  it('reports unknown order ids back to the model as an error', async () => {
    const { alice } = await startBakery()
    await alice.send('cancel B-9999')
    await alice.expectReply('Do you confirm?')
    await alice.send('yes')
    await alice.expectReply(/\[cancel_order\] .*No active order B-9999/)
  })

  it('rejects products that are not on the menu before asking anything', async () => {
    const { alice, orders } = await startBakery()
    await alice.send('one bagel')
    const reply = await alice.expectReply('[create_order]')
    expect(reply).toMatch(/must be one of/)
    expect(alice.replies().some((r) => r.includes('Do you confirm?'))).toBe(false)
    expect(await orders.list(ALICE)).toEqual([])
  })

  it('quotes without placing anything', async () => {
    const { alice, orders } = await startBakery()
    await alice.send('how much are two chocolate cakes?')
    await alice.expectReply(/\[quote_order\] .*"total":"\$56\.00"/)
    expect(await orders.list(ALICE)).toEqual([])
  })

  it('ignores senders that are not on the allow-list', async () => {
    const { provider, model } = await startBakery()
    const stranger = chat(provider, STRANGER)
    await stranger.send('what is on the menu?')
    await stranger.send('/start')
    await new Promise((r) => setTimeout(r, 50))
    expect(stranger.replies()).toEqual([])
    expect(model.calls).toHaveLength(0)
  })

  it('in groups only answers commands (groupMode "commands")', async () => {
    const { provider, model } = await startBakery()
    const group = chat(provider, 'group@example', { isGroup: true, sender: ALICE })
    await group.send('what is on the menu?')
    await new Promise((r) => setTimeout(r, 50))
    expect(model.calls).toHaveLength(0)
    await group.send('/help')
    await group.expectReply(GREETING)
  })

  it('passes the AI tuning options to the model and remembers facts when memory is on', async () => {
    const provider = new MockProvider({ buttons: false })
    const model = new MockAIProvider({
      reply: (input: GenerateInput) => (input.system?.includes('long-term memory') ? '{"facts":["Prefers decaf"]}' : 'Noted!'),
    })
    bot = createBakeryBot(provider, {
      aiProvider: model,
      ai: { memory: { maxFacts: 3, ttl: '30d' }, maxTokens: 900, effort: 'low', maxSteps: 2 },
    })
    await bot.start()
    const alice = chat(provider, ALICE)
    await alice.send('I always drink decaf')
    await alice.expectReply('Noted!')
    expect(model.calls[0]).toMatchObject({ maxTokens: 900, effort: 'low' })
    // The fact extraction runs in the background after the reply.
    const deadline = Date.now() + 1000
    while (!model.calls.some((c) => c.system?.includes('long-term memory')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(model.calls.some((c) => c.system?.includes('long-term memory'))).toBe(true)
  })

  it('makes no memory extraction call with memory off', async () => {
    const { model, alice } = await startBakery()
    await alice.send('hello there')
    await alice.expectReply('I can only help with the bakery.')
    await new Promise((r) => setTimeout(r, 50))
    expect(model.calls).toHaveLength(1)
  })
})
