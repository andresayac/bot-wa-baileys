import { describe, it, expect } from 'vitest'
import { createTestBot } from '@bot-wa/core/testing'
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
  const { bot, chat } = await createTestBot()
  bot.plug(aiPlugin({ __provider: mock, tools, ...cfg }))
  return { bot, chat }
}

describe('aiPlugin tools (autoreply)', () => {
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
