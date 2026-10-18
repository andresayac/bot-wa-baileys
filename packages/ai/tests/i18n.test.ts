import { describe, it, expect } from 'vitest'
import { MemoryStore } from '@bot-wa/core'
import { createTestBot } from '@bot-wa/core/testing'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { AIClient } from '../src/AIClient.js'
import { ContextManager } from '../src/ContextManager.js'
import { aiPlugin } from '../src/plugin.js'
import { AI_LOCALES, AI_MESSAGES, aiText } from '../src/i18n.js'
import { defaultConfirmPrompt } from '../src/tools/runner.js'
import { formatSources, type AIRetrievedChunk, type AIRetriever } from '../src/rag.js'
import type { GenerateInput } from '../src/types.js'

const PASSAGES: AIRetrievedChunk[] = [{ text: 'Los envíos tardan 3 días.', source: 'faq.md' }]
const retriever: AIRetriever = { retrieve: async () => PASSAGES }

/** Model: calls `tool` on a user turn mentioning `trigger`; echoes tool results afterwards. */
function scripted(tool: string, trigger: string) {
  return new MockAIProvider({
    reply: (input: GenerateInput) => {
      const last = input.messages[input.messages.length - 1]
      if (last?.role === 'tool') return `done: ${last.results.map((r) => r.content).join(' | ')}`
      if (last?.role === 'user' && last.content.includes(trigger)) return { toolCalls: [{ name: tool, args: {} }] }
      return 'ok'
    },
  })
}

const confirmTool = { borrar: { description: 'Delete order', confirm: true, handler: () => 'deleted' } }

describe('ai i18n — built-in defaults', () => {
  it('keeps the Spanish text unchanged without a context or without i18n', () => {
    expect(defaultConfirmPrompt('borrar', { description: 'Borrar pedido', handler: () => 'x' }, {}))
      .toBe('Voy a ejecutar «Borrar pedido».\n¿Confirmas? (sí/no)')
    expect(formatSources([{ text: 'x', source: 'a.md' }])).toBe('Fuentes: a.md')
    expect(aiText(undefined, AI_MESSAGES.maxSteps)).toBe('No pude completar la solicitud. Intenta de nuevo con más detalle.')
  })

  it('ships es and en catalogs under the ai. namespace', () => {
    expect(Object.keys(AI_LOCALES).sort()).toEqual(['en', 'es'])
    expect(aiText({ lang: 'en-US' }, AI_MESSAGES.sources, { sources: 'a.md' })).toBe('Sources: a.md')
    expect(aiText({ lang: 'fr' }, AI_MESSAGES.sources, { sources: 'a.md' })).toBe('Fuentes: a.md')
  })

  it('prefers a translation registered with bot.locale() (ctx.t)', () => {
    const t = (key: string) => (key === AI_MESSAGES.sources ? 'Refs: {sources}' : key)
    expect(aiText({ lang: 'es', t: (k, p) => t(k).replace('{sources}', String(p?.sources)) }, AI_MESSAGES.sources, { sources: 'a.md' }))
      .toBe('Refs: a.md')
  })
})

describe('ai i18n — follows ctx.lang through the plugin', () => {
  it('asks the tool confirmation in English when the chat language is en', async () => {
    const { bot, chat } = await createTestBot({ i18n: { defaultLocale: 'en' } })
    bot.plug(aiPlugin({ __provider: scripted('borrar', 'delete'), tools: confirmTool }))
    await chat.send('delete it')
    await chat.expectReply('About to run «Delete order».\nDo you confirm? (yes/no)')
    await chat.send('yes')
    await chat.expectReply('done: deleted')
  })

  it('a bot.locale() override wins over the built-in text', async () => {
    const { bot, chat } = await createTestBot()
    bot.locale('es', { ai: { tools: { confirm: '¿Ejecuto {tool}?' } } })
    bot.plug(aiPlugin({ __provider: scripted('borrar', 'borra'), tools: confirmTool }))
    await chat.send('borra')
    await chat.expectReply('¿Ejecuto Delete order?')
  })

  it('appendSources and maxStepsMessage use the chat language', async () => {
    const { bot, chat } = await createTestBot({ i18n: { defaultLocale: 'en' } })
    bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: 'Three days [1].' }), rag: { retriever, appendSources: true } }))
    await chat.send('shipping?')
    await chat.expectReply('Three days [1].\n\nSources: faq.md')

    const loop = new MockAIProvider({ reply: { toolCalls: [{ name: 'loop', args: {} }] } })
    const ai = new AIClient(loop, new ContextManager(new MemoryStore()), { tools: { loop: { description: 'l', handler: () => 'again' } }, maxSteps: 2 })
    const r = await ai.runTools({ messages: [{ role: 'user', content: 'x' }] }, { ctx: { lang: 'en' } as never })
    expect(r.text).toBe("I couldn't complete the request. Please try again with more detail.")
  })
})
