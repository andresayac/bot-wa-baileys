import { describe, it, expect } from 'vitest'
import { createTestBot } from '@bot-wa/core/testing'
import { aiPlugin, MockAIProvider, type AIRetriever } from '@bot-wa/ai'
import { createRag } from '../src/Rag.js'

const FAQ = `# Tienda
## Envíos
Los envíos a domicilio tardan 3 días hábiles en Bogotá.
## Pagos
Aceptamos tarjeta de crédito, PSE y efectivo contra entrega.`

describe('@bot-wa/rag + aiPlugin', () => {
  it('createRag() is an AIRetriever and grounds the autoreply with citations', async () => {
    const rag = createRag({ documents: [{ id: 'faq', source: 'faq.md', text: FAQ, format: 'markdown' }], topK: 1 })
    const retriever: AIRetriever = rag // structural compatibility (compile-time)
    const mock = new MockAIProvider({ reply: (i) => (i.system?.includes('3 días hábiles') ? 'Tardan 3 días hábiles [1].' : 'no sé') })
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ instance: mock, rag: { retriever, appendSources: true } }))
    await chat.send('¿Cuánto tardan los envíos?')
    await chat.expectReply('Tardan 3 días hábiles [1].\n\nFuentes: [1] faq.md › Tienda › Envíos')
    expect(mock.calls[0]!.system).toContain('[1] (faq.md › Tienda › Envíos)')
    expect(mock.calls[0]!.system).not.toContain('PSE')
  })

  it('ctx.tools.ai.replyInChatDetailed exposes the citations', async () => {
    const rag = createRag({ documents: [{ id: 'faq', source: 'faq.md', text: FAQ, format: 'markdown' }], topK: 2 })
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ instance: new MockAIProvider({ reply: 'Con tarjeta [1].' }), rag, autoReply: false }))
    bot.when('pagos', async (ctx) => {
      const r = await ctx.tools.ai.replyInChatDetailed(ctx.from, 'medios de pago con tarjeta', { userId: ctx.sender })
      await ctx.reply(`${r.text} | ${r.citations.map((c) => c.citation).join(', ')}`)
    })
    await chat.send('pagos')
    await chat.expectReply(/^Con tarjeta \[1\]\. \| faq\.md › Tienda › Pagos/)
  })
})
