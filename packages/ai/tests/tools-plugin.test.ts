import { describe, it, expect } from 'vitest'
import { createTestBot } from '@bot-wa/core/testing'
import type { LoggerLike } from '@bot-wa/core'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { aiPlugin } from '../src/plugin.js'
import type { AIPluginConfig } from '../src/plugin.js'
import { chatKeyOf } from '../src/chatKey.js'
import { confirmWith, isAffirmative } from '../src/tools/confirm.js'
import type { AIToolEvent, AIToolSet } from '../src/tools/types.js'
import type { GenerateInput } from '../src/types.js'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Model: on a user turn mentioning `trigger`, call the tool; after the tool turn, echo its result. */
function scripted(tool: string, args: unknown, trigger = 'borra') {
  return new MockAIProvider({
    reply: (input: GenerateInput) => {
      const last = input.messages[input.messages.length - 1]
      if (last?.role === 'tool') return `resultado: ${last.results.map((r) => r.content).join(' | ')}`
      if (last?.role === 'user' && last.content.includes(trigger)) return { toolCalls: [{ name: tool, args }] }
      return `eco: ${last?.content ?? ''}`
    },
  })
}

async function botWithTools(tools: AIToolSet, mock: MockAIProvider, cfg: Partial<AIPluginConfig> = {}) {
  // A channel without native buttons: the typed yes/no question (buttons: tools-confirm-buttons.test.ts).
  const { bot, chat } = await createTestBot({}, { provider: { buttons: false } })
  bot.plug(aiPlugin({ __provider: mock, tools, ...cfg }))
  return { bot, chat }
}

describe('aiPlugin tools (autoreply)', () => {
  it('warns (and does not run the tool) when a tool call is cut off by the output-token cap', async () => {
    const warnings: unknown[][] = []
    const noop = () => {}
    const logger: LoggerLike = { debug: noop, info: noop, error: noop, warn: (...a: unknown[]) => { warnings.push(a) }, child: () => logger }
    const { bot, chat } = await createTestBot({ logger }, { provider: { buttons: false } })
    let runs = 0
    const mock = new MockAIProvider({
      reply: (input: GenerateInput) => input.messages.at(-1)?.role === 'tool'
        ? 'Could you repeat that?'
        : { toolCalls: [{ name: 'borrar', args: { id: 'x' } }], stopReason: 'max_tokens' },
    })
    bot.plug(aiPlugin({ __provider: mock, tools: { borrar: { description: 'b', handler: () => { runs++; return 'ok' } } } }))
    await chat.send('borra x')
    await chat.expectReply('Could you repeat that?')
    expect(runs).toBe(0)
    expect(warnings.some((w) => String(w[1]).includes('cut off by the output token limit'))).toBe(true)
  })

  it('runs a plain tool and replies with the final answer', async () => {
    const { chat } = await botWithTools(
      { buscar: { description: 'Busca', schema: { type: 'object', properties: { q: { type: 'string' } } }, handler: (a) => `encontré ${(a as { q: string }).q}` } },
      scripted('buscar', { q: 'pan' }, 'busca'),
    )
    await chat.send('busca pan')
    await chat.expectReply('resultado: encontré pan')
  })

  it('confirm:true asks the user, waits without deadlocking the FIFO, and runs on "sí"', async () => {
    const ran: unknown[] = []
    const { chat } = await botWithTools(
      { borrar: { description: 'Borrar pedido', confirm: true, confirmMessage: '¿Borro el pedido 7? (sí/no)', handler: (a) => { ran.push(a); return 'borrado' } } },
      scripted('borrar', { id: 7 }),
    )
    await chat.send('borra el pedido 7')
    await chat.expectReply('¿Borro el pedido 7? (sí/no)')
    expect(ran).toEqual([])
    await chat.send('Sí')
    await chat.expectReply('resultado: borrado')
    expect(ran).toEqual([{ id: 7 }])
    // The chat keeps working normally afterwards.
    await chat.send('hola')
    await chat.expectReply('eco: hola')
  })

  it('a negative answer does not run the tool and the model is told it was declined', async () => {
    let ran = false
    const { chat } = await botWithTools(
      { borrar: { description: 'Borrar pedido', confirm: true, handler: () => { ran = true } } },
      scripted('borrar', { id: 7 }),
    )
    await chat.send('borra el pedido 7')
    await chat.expectReply(/¿Confirmas\? \(sí\/no\)/)
    await chat.send('no')
    await chat.expectReply(/resultado: The user declined to run "borrar"/)
    expect(ran).toBe(false)
  })

  it('/reset during a pending confirmation cancels silently (no tool, no AI reply)', async () => {
    let ran = false
    const { chat } = await botWithTools(
      { borrar: { description: 'Borrar', confirm: true, handler: () => { ran = true } } },
      scripted('borrar', {}),
    )
    await chat.send('borra todo')
    await chat.expectReply(/Confirmas/)
    await chat.send('/reset')
    await chat.expectReply(/reiniciada/)
    await tick()
    expect(ran).toBe(false)
    expect(chat.replies().some((r) => r.startsWith('resultado:'))).toBe(false)
  })

  it('a confirmation timeout cancels the turn', async () => {
    let ran = false
    const { chat } = await botWithTools(
      { borrar: { description: 'Borrar', confirm: true, handler: () => { ran = true } } },
      scripted('borrar', {}),
      { toolConfirm: { timeout: 30 } },
    )
    await chat.send('borra todo')
    await chat.expectReply(/Confirmas/)
    await tick(120)
    expect(ran).toBe(false)
    expect(chat.replies().some((r) => r.startsWith('resultado:'))).toBe(false)
    await chat.send('hola')
    await chat.expectReply('eco: hola')
  })

  describe('after the first confirmation (turn detached from the chat queue)', () => {
    /** Model: 'paga' → tool A; after A's result → tool B; after B's result → final text. */
    function twoStep() {
      return new MockAIProvider({
        reply: (input: GenerateInput) => {
          const last = input.messages[input.messages.length - 1]
          if (last?.role === 'tool') {
            if (last.results[0]?.name === 'a') return { toolCalls: [{ name: 'b', args: {} }] }
            return `resultado: ${last.results.map((r) => r.content).join(' | ')}`
          }
          if (last?.role === 'user' && last.content.includes('paga')) return { toolCalls: [{ name: 'a', args: {} }] }
          return `eco: ${last?.content ?? ''}`
        },
      })
    }
    function gate() {
      let open!: () => void
      const p = new Promise<void>((r) => { open = r })
      return { p, open }
    }

    it('a second confirmation never replaces a flow the user started meanwhile', async () => {
      const g = gate()
      const ran: string[] = []
      const { bot, chat } = await botWithTools({
        a: { description: 'A', confirm: true, confirmMessage: '¿A?', handler: async () => { await g.p; ran.push('a'); return 'A ok' } },
        b: { description: 'B', confirm: true, confirmMessage: '¿B?', handler: () => { ran.push('b'); return 'B ok' } },
      }, twoStep())
      let flowCancelled = false
      bot.conversation('menu', async (c) => {
        let pick: string
        try { pick = await c.ask('elige') } catch (e) { flowCancelled = true; throw e }
        await c.say(`elegiste ${pick}`)
      })
      await chat.send('paga')
      await chat.expectReply('¿A?')
      await chat.send('si')
      await tick()
      await chat.send('menu')
      await chat.expectReply('elige')
      g.open()
      await tick(60)
      expect(flowCancelled).toBe(false)
      expect(chat.replies()).not.toContain('¿B?')
      await chat.send('2')
      await chat.expectReply('elegiste 2')
      expect(ran).toEqual(['a'])
      expect(chat.replies().some((r) => r.startsWith('resultado:'))).toBe(false)
    })

    it('serialises turns per chat: a new message waits for the detached turn to finish', async () => {
      const g = gate()
      const { chat } = await botWithTools({
        a: { description: 'A', confirm: true, confirmMessage: '¿A?', handler: async () => { await g.p; return 'A ok' } },
      }, scripted('a', {}, 'paga'))
      await chat.send('paga')
      await chat.expectReply('¿A?')
      await chat.send('si')
      await tick()
      await chat.send('hola')
      await tick(60)
      expect(chat.replies()).not.toContain('eco: hola')
      g.open()
      await chat.expectReply('eco: hola')
      const r = chat.replies()
      expect(r.indexOf('resultado: A ok')).toBeGreaterThan(-1)
      expect(r.indexOf('resultado: A ok')).toBeLessThan(r.indexOf('eco: hola'))
    })

    it('/reset after approval cancels the detached turn: no reply, nothing written to the cleared history', async () => {
      const g = gate()
      const mock = scripted('a', {}, 'paga')
      const { chat } = await botWithTools({
        a: { description: 'A', confirm: true, confirmMessage: '¿A?', handler: async () => { await g.p; return 'A ok' } },
      }, mock)
      await chat.send('paga')
      await chat.expectReply('¿A?')
      await chat.send('si')
      await tick()
      await chat.send('/reset')
      await chat.expectReply(/reiniciada/)
      g.open()
      await tick(60)
      expect(chat.replies().some((r) => r.startsWith('resultado:'))).toBe(false)
      await chat.send('hola')
      await chat.expectReply('eco: hola')
      // The cancelled turn left nothing in the history the user just cleared.
      expect(mock.calls.at(-1)?.messages).toEqual([{ role: 'user', content: 'hola' }])
    })

    it('a second confirmation is still asked when the chat is idle', async () => {
      const ran: string[] = []
      const { chat } = await botWithTools({
        a: { description: 'A', confirm: true, confirmMessage: '¿A?', handler: () => { ran.push('a'); return 'A ok' } },
        b: { description: 'B', confirm: true, confirmMessage: '¿B?', handler: () => { ran.push('b'); return 'B ok' } },
      }, twoStep())
      await chat.send('paga')
      await chat.expectReply('¿A?')
      await chat.send('si')
      await chat.expectReply('¿B?')
      await chat.send('si')
      await chat.expectReply('resultado: B ok')
      expect(ran).toEqual(['a', 'b'])
    })
  })

  it('custom yes words', async () => {
    let ran = false
    const { chat } = await botWithTools(
      { pagar: { description: 'Pagar', confirm: true, handler: () => { ran = true; return 'pagado' } } },
      scripted('pagar', {}, 'paga'),
      { toolConfirm: { yes: ['adelante'] } },
    )
    await chat.send('paga la factura')
    await chat.expectReply(/Confirmas/)
    await chat.send('Adelante!')
    await chat.expectReply('resultado: pagado')
    expect(ran).toBe(true)
  })

  it('emits audit events on the bot (ai.tool) and to onToolEvent', async () => {
    const viaHook: AIToolEvent[] = []
    const { bot, chat } = await botWithTools(
      { buscar: { description: 'Busca', handler: () => 'ok' } },
      scripted('buscar', {}, 'busca'),
      { onToolEvent: (e) => viaHook.push(e) },
    )
    const viaBot: AIToolEvent[] = []
    bot.on('ai.tool', (e: AIToolEvent) => viaBot.push(e))
    await chat.send('busca algo')
    await chat.expectReply('resultado: ok')
    expect(viaBot.map((e) => e.type)).toEqual(['tool.call', 'tool.result'])
    expect(viaHook.map((e) => e.type)).toEqual(['tool.call', 'tool.result'])
  })

  it('tool handlers receive the MessageContext of the turn', async () => {
    let sender: string | undefined
    const { chat } = await botWithTools(
      { quien: { description: 'Quién soy', handler: (_a, tctx) => { sender = tctx.ctx?.sender; return 'ok' } } },
      scripted('quien', {}, 'quien'),
    )
    await chat.send('quien soy')
    await chat.expectReply('resultado: ok')
    expect(sender).toBeDefined()
  })
})

describe('confirmWith (inside your own conversation)', () => {
  it('asks through the conversation controls', async () => {
    const { bot, chat } = await createTestBot()
    let ran = false
    bot.plug(aiPlugin({
      __provider: scripted('borrar', {}),
      autoReply: false,
      tools: { borrar: { description: 'Borrar', confirm: true, confirmMessage: '¿Seguro?', handler: () => { ran = true; return 'hecho' } } },
    }))
    bot.conversation('soporte', async (c, ctx) => {
      const pedido = await c.ask('¿Qué hago?')
      const text = await ctx.tools.ai.replyInChat(chatKeyOf(ctx), pedido, { ctx, confirm: confirmWith(c) })
      await ctx.reply(text)
    })
    await chat.send('soporte')
    await chat.expectReply('¿Qué hago?')
    await chat.send('borra todo')
    await chat.expectReply('¿Seguro?')
    await chat.send('si')
    await chat.expectReply('resultado: hecho')
    expect(ran).toBe(true)
  })

  it('isAffirmative normalizes accents, case and punctuation', () => {
    expect(isAffirmative('Sí!')).toBe(true)
    expect(isAffirmative('  OK. ')).toBe(true)
    expect(isAffirmative('de acuerdo')).toBe(true)
    expect(isAffirmative('no')).toBe(false)
    expect(isAffirmative('sí, pero no')).toBe(false)
    expect(isAffirmative('')).toBe(false)
  })
})
