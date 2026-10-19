import { describe, it, expect } from 'vitest'
import type { OutboundContent } from '@bot-wa/core'
import { createTestBot, type MockProviderOptions } from '@bot-wa/core/testing'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { aiPlugin, type AIPluginConfig } from '../src/plugin.js'
import { chatKeyOf } from '../src/chatKey.js'
import { confirmWith, type ConfirmWithOptions } from '../src/tools/confirm.js'
import type { GenerateInput } from '../src/types.js'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Model: on a user turn mentioning `borra`, call the tool; after the tool turn, echo its result. */
function scripted() {
  return new MockAIProvider({
    reply: (input: GenerateInput) => {
      const last = input.messages[input.messages.length - 1]
      if (last?.role === 'tool') return `resultado: ${last.results.map((r) => r.content).join(' | ')}`
      if (last?.role === 'user' && last.content.includes('borra')) return { toolCalls: [{ name: 'borrar', args: {} }] }
      return `eco: ${last?.content ?? ''}`
    },
  })
}

type ButtonsContent = Extract<OutboundContent, { kind: 'buttons' }>

/**
 * A support conversation that hands the user's request to the AI with `confirmWith(c)`,
 * then asks a follow-up question (so a later press reaches a live conversation).
 */
async function setup(opts: { provider?: MockProviderOptions; confirm?: ConfirmWithOptions; cfg?: Partial<AIPluginConfig>; explicitCtx?: boolean } = {}) {
  const runs: string[] = []
  const followUps: string[] = []
  const { bot, chat, provider } = await createTestBot({}, { provider: opts.provider ?? {} })
  bot.plug(aiPlugin({
    __provider: scripted(),
    autoReply: false,
    tools: { borrar: { description: 'Borra el pedido', title: 'Borrar pedido', confirm: true, handler: () => { runs.push('x'); return 'borrado' } } },
    ...opts.cfg,
  }))
  bot.conversation('soporte', async (c, ctx) => {
    const pedido = await c.ask('¿Qué hago?')
    const confirm = confirmWith(c, { ...opts.confirm, ...(opts.explicitCtx ? { ctx } : {}) })
    const text = await ctx.tools.ai.replyInChat(chatKeyOf(ctx), pedido, { ctx, confirm })
    await ctx.reply(text)
    followUps.push(await c.ask('¿Algo más?'))
  })
  const buttonsSent = () => provider.outbox.filter((m) => m.content.kind === 'buttons').map((m) => m.content as ButtonsContent)
  const press = async (id: string) => { provider.interaction(id, { from: chat.jid }); await tick(10) }
  const start = async () => {
    await chat.send('soporte')
    await chat.expectReply('¿Qué hago?')
    await chat.send('borra el pedido')
    await chat.expectReply('Voy a: Borrar pedido')
  }
  return { bot, chat, provider, runs, followUps, buttonsSent, press, start }
}

describe('confirmWith(c) with native buttons (inside your own conversation)', () => {
  it('asks with localized Yes/No buttons; a press runs the tool and is acknowledged', async () => {
    const { chat, provider, runs, buttonsSent, press, start } = await setup()
    await start()
    const [msg] = buttonsSent()
    expect(msg!.text).toBe('Voy a: Borrar pedido\n¿Confirmas?')
    expect(msg!.buttons.map((b) => b.title)).toEqual(['Sí', 'No'])
    await press(msg!.buttons[0]!.id)
    await chat.expectReply('resultado: borrado')
    expect(runs).toHaveLength(1)
    expect(provider.acks).toHaveLength(1)
    await chat.expectReply('¿Algo más?')
  })

  it('works with an explicit ctx option too, and No declines', async () => {
    const { chat, runs, buttonsSent, press, start } = await setup({ explicitCtx: true })
    await start()
    await press(buttonsSent()[0]!.buttons[1]!.id)
    await chat.expectReply(/resultado: The user declined/)
    expect(runs).toHaveLength(0)
  })

  it('a typed answer still works alongside the buttons', async () => {
    const { chat, runs, start } = await setup()
    await start()
    await chat.send('sí')
    await chat.expectReply('resultado: borrado')
    expect(runs).toHaveLength(1)
  })

  it('removes the buttons by editing the message once answered (when the provider edits)', async () => {
    const { chat, provider, buttonsSent, press, start } = await setup({ provider: { supports: { edit: true } } })
    await start()
    await press(buttonsSent()[0]!.buttons[0]!.id)
    await chat.expectReply('resultado: borrado')
    expect(provider.edits).toHaveLength(1)
    expect(provider.edits[0]!.content).toEqual({ kind: 'text', text: 'Voy a: Borrar pedido\n¿Confirmas?\n\n→ Sí' })
  })

  it('a second press is acknowledged and ignored: it never answers the next question of the conversation', async () => {
    const { chat, provider, runs, followUps, buttonsSent, press, start } = await setup({ provider: { supports: { edit: true } } })
    await start()
    const yes = buttonsSent()[0]!.buttons[0]!.id
    await press(yes)
    await chat.expectReply('¿Algo más?')
    const before = provider.outbox.length
    await press(yes)
    await tick()
    expect(runs).toHaveLength(1)
    expect(provider.acks).toHaveLength(2)
    // A channel that edits has removed the buttons already: no extra message.
    expect(provider.outbox.length).toBe(before)
    await chat.send('nada')
    await tick()
    expect(followUps).toEqual(['nada'])
  })

  it('buttons: false keeps the typed question', async () => {
    const { chat, provider, start } = await setup({ confirm: { buttons: false } })
    await start()
    expect(chat.replies().at(-1)).toBe('Voy a: Borrar pedido\n¿Confirmas? (sí/no)')
    expect(provider.outbox.some((m) => m.content.kind === 'buttons')).toBe(false)
  })

  it('a channel without native buttons gets the typed question', async () => {
    const { chat, provider, runs, start } = await setup({ provider: { buttons: false } })
    await start()
    expect(chat.replies().at(-1)).toBe('Voy a: Borrar pedido\n¿Confirmas? (sí/no)')
    expect(provider.outbox.some((m) => m.content.kind === 'buttons')).toBe(false)
    await chat.send('si')
    await chat.expectReply('resultado: borrado')
    expect(runs).toHaveLength(1)
  })
})

describe('confirmations on channels that cannot edit messages (Cloud API, Messenger, Instagram)', () => {
  it('a press on an answered confirmation gets a short localized notice by default', async () => {
    const { chat, provider, runs, buttonsSent, press, start } = await setup()
    await start()
    const yes = buttonsSent()[0]!.buttons[0]!.id
    await press(yes)
    await chat.expectReply('¿Algo más?')
    await press(yes)
    await chat.expectReply('Esa confirmación ya no está activa.')
    expect(runs).toHaveLength(1)
    expect(provider.acks).toHaveLength(2)
  })

  it('toolConfirm.expiredNotice: false acknowledges the press silently', async () => {
    const { chat, provider, buttonsSent, press, start } = await setup({ cfg: { toolConfirm: { expiredNotice: false } } })
    await start()
    const yes = buttonsSent()[0]!.buttons[0]!.id
    await press(yes)
    await chat.expectReply('¿Algo más?')
    const before = provider.outbox.length
    await press(yes)
    await tick()
    expect(provider.outbox.length).toBe(before)
    expect(provider.acks).toHaveLength(2)
  })

  it('answeredNotice: true confirms the picked answer (off by default)', async () => {
    const off = await setup()
    await off.start()
    await off.press(off.buttonsSent()[0]!.buttons[0]!.id)
    await off.chat.expectReply('resultado: borrado')
    expect(off.chat.replies().some((r) => r.startsWith('Respuesta recibida'))).toBe(false)

    const on = await setup({ confirm: { answeredNotice: true } })
    await on.start()
    await on.press(on.buttonsSent()[0]!.buttons[1]!.id)
    await on.chat.expectReply('Respuesta recibida: No.')
  })

  it('answeredNotice is skipped where the provider edits the buttons away', async () => {
    const { chat, buttonsSent, press, start } = await setup({ provider: { supports: { edit: true } }, confirm: { answeredNotice: true } })
    await start()
    await press(buttonsSent()[0]!.buttons[0]!.id)
    await chat.expectReply('resultado: borrado')
    expect(chat.replies().some((r) => r.startsWith('Respuesta recibida'))).toBe(false)
  })
})
