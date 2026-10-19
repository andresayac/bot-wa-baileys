import { describe, it, expect } from 'vitest'
import type { OutboundContent } from '@bot-wa/core'
import { createTestBot, type MockProviderOptions } from '@bot-wa/core/testing'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { aiPlugin, type AIPluginConfig } from '../src/plugin.js'
import type { AIToolSet } from '../src/tools/types.js'
import type { GenerateInput } from '../src/types.js'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Model: on a user turn mentioning `trigger`, call the tool; after the tool turn, echo its result. */
function scripted(tool: string, trigger = 'borra') {
  return new MockAIProvider({
    reply: (input: GenerateInput) => {
      const last = input.messages[input.messages.length - 1]
      if (last?.role === 'tool') return `resultado: ${last.results.map((r) => r.content).join(' | ')}`
      if (last?.role === 'user' && last.content.includes(trigger)) return { toolCalls: [{ name: tool, args: {} }] }
      return `eco: ${last?.content ?? ''}`
    },
  })
}

type ButtonsContent = Extract<OutboundContent, { kind: 'buttons' }>

async function setup(opts: { provider?: MockProviderOptions; cfg?: Partial<AIPluginConfig>; lang?: string } = {}) {
  const runs: number[] = []
  const tools: AIToolSet = {
    borrar: { description: 'Borra el pedido', title: 'Borrar pedido', confirm: true, handler: () => { runs.push(Date.now()); return 'borrado' } },
  }
  const { bot, chat, provider } = await createTestBot(
    opts.lang ? { i18n: { defaultLocale: opts.lang } } : {},
    { provider: opts.provider ?? {} },
  )
  bot.plug(aiPlugin({ __provider: scripted('borrar'), tools, ...opts.cfg }))
  const buttonsSent = () => provider.outbox.filter((m) => m.content.kind === 'buttons').map((m) => m.content as ButtonsContent)
  const press = async (id: string) => { provider.interaction(id, { from: chat.jid }); await tick(5) }
  return { bot, chat, provider, runs, buttonsSent, press }
}

describe('tool confirmations with native buttons', () => {
  it('asks with localized Yes/No buttons and no typed-answer hint', async () => {
    const { chat, buttonsSent, runs } = await setup()
    await chat.send('borra el pedido')
    await chat.expectReply('Voy a: Borrar pedido\n¿Confirmas?')
    const [msg] = buttonsSent()
    expect(msg!.text).toBe('Voy a: Borrar pedido\n¿Confirmas?')
    expect(msg!.text).not.toMatch(/sí\/no/)
    expect(msg!.buttons.map((b) => b.title)).toEqual(['Sí', 'No'])
    expect(new Set(msg!.buttons.map((b) => b.id)).size).toBe(2)
    expect(runs).toHaveLength(0)
  })

  it('English chats get Yes/No labels', async () => {
    const { chat, buttonsSent } = await setup({ lang: 'en' })
    await chat.send('borra')
    await chat.expectReply('About to: Borrar pedido\nDo you confirm?')
    expect(buttonsSent()[0]!.buttons.map((b) => b.title)).toEqual(['Yes', 'No'])
  })

  it('pressing Yes runs the tool and acknowledges the interaction', async () => {
    const { chat, buttonsSent, press, provider, runs } = await setup()
    await chat.send('borra')
    await chat.expectReply(/Confirmas/)
    const yes = buttonsSent()[0]!.buttons[0]!.id
    await press(yes)
    await chat.expectReply('resultado: borrado')
    expect(runs).toHaveLength(1)
    expect(provider.acks).toHaveLength(1)
    // The chat keeps working normally afterwards.
    await chat.send('hola')
    await chat.expectReply('eco: hola')
  })

  it('pressing No declines like typing "no"', async () => {
    const { chat, buttonsSent, press, runs } = await setup()
    await chat.send('borra')
    await chat.expectReply(/Confirmas/)
    await press(buttonsSent()[0]!.buttons[1]!.id)
    await chat.expectReply(/resultado: The user declined to run "borrar"/)
    expect(runs).toHaveLength(0)
  })

  it('a typed answer still works alongside the buttons', async () => {
    const { chat, runs } = await setup()
    await chat.send('borra')
    await chat.expectReply(/Confirmas/)
    await chat.send('sí, por favor')
    await chat.expectReply('resultado: borrado')
    expect(runs).toHaveLength(1)
  })

  it('a press on an answered confirmation is acknowledged and ignored (no double run)', async () => {
    const { chat, buttonsSent, press, provider, runs } = await setup({ provider: { supports: { edit: true } } })
    await chat.send('borra')
    await chat.expectReply(/Confirmas/)
    const yes = buttonsSent()[0]!.buttons[0]!.id
    await press(yes)
    await chat.expectReply('resultado: borrado')
    const before = provider.outbox.length
    await press(yes)
    await tick()
    expect(runs).toHaveLength(1)
    expect(provider.acks).toHaveLength(2)
    // The buttons were edited away: nothing else to say.
    expect(provider.outbox.length).toBe(before)
  })

  it('where the buttons stay (no edit), a press on an answered confirmation gets a localized notice', async () => {
    const { chat, buttonsSent, press, provider, runs } = await setup({ lang: 'en' })
    await chat.send('borra')
    await chat.expectReply(/confirm/)
    const yes = buttonsSent()[0]!.buttons[0]!.id
    await press(yes)
    await chat.expectReply('resultado: borrado')
    await press(yes)
    await chat.expectReply('That confirmation is no longer active.')
    expect(runs).toHaveLength(1)
    expect(provider.acks).toHaveLength(2)
  })

  it('toolConfirm.expiredNotice: false drops the stale press silently', async () => {
    const { chat, buttonsSent, press, provider } = await setup({ cfg: { toolConfirm: { expiredNotice: false } } })
    await chat.send('borra')
    await chat.expectReply(/Confirmas/)
    const yes = buttonsSent()[0]!.buttons[0]!.id
    await press(yes)
    await chat.expectReply('resultado: borrado')
    const before = provider.outbox.length
    await press(yes)
    await tick()
    expect(provider.outbox.length).toBe(before)
    expect(provider.acks).toHaveLength(2)
  })

  it('toolConfirm.answeredNotice: true confirms the pressed answer where the buttons stay', async () => {
    const { chat, buttonsSent, press } = await setup({ cfg: { toolConfirm: { answeredNotice: true } } })
    await chat.send('borra')
    await chat.expectReply(/Confirmas/)
    await press(buttonsSent()[0]!.buttons[0]!.id)
    await chat.expectReply('Respuesta recibida: Sí.')
    await chat.expectReply('resultado: borrado')
  })

  it('a stale press does not resolve a newer pending confirmation', async () => {
    const { chat, buttonsSent, press, runs } = await setup()
    await chat.send('borra')
    await chat.expectReply(/Confirmas/)
    const oldYes = buttonsSent()[0]!.buttons[0]!.id
    await chat.send('no')
    await chat.expectReply(/declined/)
    await chat.send('borra otra vez')
    await chat.expectReply(/Confirmas/)
    await press(oldYes)
    await tick()
    expect(runs).toHaveLength(0)
    await press(buttonsSent()[1]!.buttons[0]!.id)
    await chat.expectReply('resultado: borrado')
    expect(runs).toHaveLength(1)
  })

  it('a press after a timeout is ignored', async () => {
    const { chat, buttonsSent, press, runs } = await setup({ cfg: { toolConfirm: { timeout: 30 } } })
    await chat.send('borra')
    await chat.expectReply(/Confirmas/)
    await tick(120)
    await press(buttonsSent()[0]!.buttons[0]!.id)
    await tick()
    expect(runs).toHaveLength(0)
    expect(chat.replies().some((r) => r.startsWith('resultado:'))).toBe(false)
  })

  it('removes the buttons by editing the message once answered (when the provider edits)', async () => {
    const { chat, buttonsSent, press, provider } = await setup({ provider: { supports: { edit: true } } })
    await chat.send('borra')
    await chat.expectReply(/Confirmas/)
    await press(buttonsSent()[0]!.buttons[0]!.id)
    await chat.expectReply('resultado: borrado')
    expect(provider.edits).toHaveLength(1)
    expect(provider.edits[0]!.content).toEqual({ kind: 'text', text: 'Voy a: Borrar pedido\n¿Confirmas?\n\n→ Sí' })
  })

  it('a bot.locale() override of ai.tools.confirm is used when confirmButtons is not translated', async () => {
    const { bot, chat, provider } = await createTestBot()
    bot.locale('es', { ai: { tools: { confirm: '¿Ejecuto {tool}?' } } })
    bot.plug(aiPlugin({ __provider: scripted('borrar'), tools: { borrar: { description: 'x', title: 'Borrar', confirm: true, handler: () => 'ok' } } }))
    await chat.send('borra')
    await chat.expectReply('¿Ejecuto Borrar?')
    expect(provider.outbox.at(-1)!.content.kind).toBe('buttons')
  })
})

describe('tool confirmations without native buttons', () => {
  it('asks for a typed yes/no in plain text', async () => {
    const { chat, provider, runs } = await setup({ provider: { buttons: false } })
    await chat.send('borra')
    await chat.expectReply('Voy a: Borrar pedido\n¿Confirmas? (sí/no)')
    expect(provider.outbox.some((m) => m.content.kind === 'buttons')).toBe(false)
    await chat.send('sí')
    await chat.expectReply('resultado: borrado')
    expect(runs).toHaveLength(1)
  })

  it('toolConfirm.buttons: false keeps the typed question on a channel with buttons', async () => {
    const { chat, provider } = await setup({ cfg: { toolConfirm: { buttons: false } } })
    await chat.send('borra')
    await chat.expectReply('Voy a: Borrar pedido\n¿Confirmas? (sí/no)')
    expect(provider.outbox.some((m) => m.content.kind === 'buttons')).toBe(false)
  })
})

describe('confirmation language in one chat (live Telegram report)', () => {
  /** A Telegram-like chat: the client reports `language_code` on some updates only. */
  async function telegramLike(i18n: Record<string, unknown>) {
    const { bot, provider } = await createTestBot({ i18n }, { provider: {} })
    const tools: AIToolSet = {
      borrar: { description: 'b', title: 'Delete order', confirm: true, handler: () => 'ok' },
    }
    bot.plug(aiPlugin({ __provider: scripted('borrar', 'delete'), tools, humanizeTyping: false }))
    const asks = () => provider.outbox.filter((m) => m.content.kind === 'buttons').map((m) => m.content as ButtonsContent)
    const turn = async (text: string, opts: { platformData?: Record<string, unknown> }) => {
      provider.incoming(text, { from: 'tg-1', ...opts })
      await tick(30)
      const ask = asks().at(-1)!
      provider.interaction(ask.buttons[1]!.id, { from: 'tg-1' })
      await tick(30)
      return `${ask.text} [${ask.buttons.map((b) => b.title).join('/')}]`
    }
    return { bot, turn }
  }

  it('keeps the chat language when an update reports none (no flip to the default)', async () => {
    const { bot, turn } = await telegramLike({ defaultLocale: 'en' })
    const first = await turn('delete it', { platformData: { languageCode: 'es' } })
    const second = await turn('delete it again', {})
    expect(first).toBe('Voy a: Delete order\n¿Confirmas? [Sí/No]')
    expect(second).toBe(first)
    await bot.stop()
  })

  it("a bot pinned to English (locales: ['en']) confirms in English whatever the client reports", async () => {
    const { bot, turn } = await telegramLike({ defaultLocale: 'en', locales: ['en'] })
    const first = await turn('delete it', {})
    const second = await turn('delete it again', { platformData: { languageCode: 'es' } })
    expect(first).toBe('About to: Delete order\nDo you confirm? [Yes/No]')
    expect(second).toBe(first)
    await bot.stop()
  })
})
