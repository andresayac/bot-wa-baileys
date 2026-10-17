import { describe, it, expect, vi } from 'vitest'
import { createTestBot } from '@bot-wa/core/testing'
import { MemoryStore, UserDataService } from '@bot-wa/core'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { AIClient } from '../src/AIClient.js'
import { ContextManager } from '../src/ContextManager.js'
import { aiPlugin } from '../src/plugin.js'
import { MemoryManager } from '../src/memory/MemoryManager.js'
import { extractionPrompt, factsSchema, parseFacts } from '../src/memory/extract.js'
import type { GenerateInput } from '../src/types.js'

function manager(config: ConstructorParameters<typeof MemoryManager>[1] = {}, now = () => 1_000) {
  const users = new UserDataService(new MemoryStore())
  return { mem: new MemoryManager((id) => users.for(id), config, now), users }
}

/** A provider that answers extraction calls with `extract` and chat calls with `reply`. */
function dualProvider(extract: (input: GenerateInput) => string, reply = 'ok') {
  return new MockAIProvider({
    reply: (input) => (input.system?.includes('long-term memory about the USER') ? extract(input) : reply),
  })
}

describe('MemoryManager', () => {
  it('stores facts in ctx.user namespace "ai.memory" and lists them oldest first', async () => {
    const { mem, users } = manager()
    expect(await mem.add('u1', ['Prefiere español', 'Es de Bogotá'])).toEqual(['Prefiere español', 'Es de Bogotá'])
    expect(await mem.list('u1')).toEqual(['Prefiere español', 'Es de Bogotá'])
    const raw = await users.for('u1', 'ai.memory').get<unknown[]>('facts')
    expect(raw).toHaveLength(2)
    expect(await mem.list('u2')).toEqual([])
  })

  it('dedupes case/punctuation-insensitively (renewing the fact) and trims to maxFacts', async () => {
    let t = 1_000
    const { mem } = manager({ maxFacts: 3 }, () => t)
    await mem.add('u', ['A', 'B', 'C'])
    t = 2_000
    expect(await mem.add('u', 'a.')).toEqual([])
    expect(await mem.list('u')).toEqual(['B', 'C', 'A'])
    await mem.add('u', 'D')
    expect(await mem.list('u')).toEqual(['C', 'A', 'D'])
    const facts = await mem.facts('u')
    expect(facts.find((f) => f.text === 'A')).toMatchObject({ createdAt: 1_000, updatedAt: 2_000, source: 'manual' })
  })

  it('rejects empty and over-long facts', async () => {
    const { mem } = manager({ maxFactLength: 5 })
    expect(await mem.add('u', ['', '   ', 'demasiado largo', 'ok'])).toEqual(['ok'])
  })

  it('expires facts after their TTL (per fact, renewable)', async () => {
    let t = 0
    const { mem } = manager({ ttl: '1h' }, () => t)
    await mem.add('u', 'viejo')
    t = 30 * 60_000
    await mem.add('u', 'nuevo')
    await mem.add('u', 'permanente', { ttl: '1d' })
    t = 61 * 60_000
    expect(await mem.list('u')).toEqual(['nuevo', 'permanente'])
    t = 91 * 60_000
    expect(await mem.list('u')).toEqual(['permanente'])
  })

  it('remove / clear', async () => {
    const { mem } = manager()
    await mem.add('u', ['Uno', 'Dos'])
    expect(await mem.remove('u', 'uno')).toBe(true)
    expect(await mem.remove('u', 'uno')).toBe(false)
    expect(await mem.list('u')).toEqual(['Dos'])
    await mem.clear('u')
    expect(await mem.list('u')).toEqual([])
  })

  it('serialises concurrent writes of one user (no lost facts)', async () => {
    const { mem } = manager()
    await Promise.all(Array.from({ length: 10 }, (_, i) => mem.add('u', `fact ${i}`)))
    expect(await mem.list('u')).toHaveLength(10)
  })

  it('validates config', () => {
    expect(() => manager({ maxFacts: 0 })).toThrow()
    expect(() => manager({ ttl: 'nope' })).toThrow()
  })
})

describe('strict extraction schema', () => {
  it('accepts exactly {"facts": string[]} (optionally fenced)', () => {
    expect(parseFacts('{"facts":["Prefiere español"]}', 5, 100)).toEqual(['Prefiere español'])
    expect(parseFacts('```json\n{"facts":[" Es de Cali "]}\n```', 5, 100)).toEqual(['Es de Cali'])
    expect(parseFacts('{"facts":[]}', 5, 100)).toEqual([])
  })

  it('rejects anything else', () => {
    for (const bad of [
      'Prefiere español',
      'Sure! {"facts":["x"]}',
      '{"facts":"x"}',
      '{"facts":[1]}',
      '{"facts":[""]}',
      '{"facts":["x"],"extra":true}',
      '["x"]',
      'null',
      '{"facts":["a","b","c"]}',
      `{"facts":["${'x'.repeat(101)}"]}`,
    ]) {
      expect(parseFacts(bad, 2, 100), bad).toBeUndefined()
    }
  })

  it('the prompt carries the schema, known facts and the exchange', () => {
    const p = extractionPrompt({ known: ['Es de Bogotá'], userText: 'hola', assistantText: 'qué tal', maxItems: 3, maxLength: 50, instructions: 'Solo compras.' })
    expect(p.system).toContain(JSON.stringify(factsSchema(3, 50)))
    expect(p.system).toContain('Solo compras.')
    expect(p.user).toContain('- Es de Bogotá')
    expect(p.user).toContain('USER: hola')
  })
})

describe('AIClient memory', () => {
  function client(mock: MockAIProvider, config: ConstructorParameters<typeof MemoryManager>[1] = { autoExtract: true }) {
    const store = new MemoryStore()
    const users = new UserDataService(store)
    const memory = new MemoryManager((id) => users.for(id), config)
    const errors: unknown[] = []
    const ai = new AIClient(mock, new ContextManager(store), { persona: 'ACME', memory, onError: (e) => errors.push(e) })
    return { ai, memory, errors }
  }

  it('injects facts into the system prompt of replyInChat (after the persona)', async () => {
    const mock = new MockAIProvider({ reply: 'hola Juan' })
    const { ai } = client(mock, {})
    await ai.remember('u', ['Se llama Juan', 'Prefiere español'])
    await ai.replyInChat('chat', 'hola', { userId: 'u' })
    const sys = mock.calls[0]!.system!
    expect(sys.startsWith('ACME')).toBe(true)
    expect(sys).toContain('- Se llama Juan\n- Prefiere español')
    // no userId → no memory
    await ai.replyInChat('chat2', 'hola')
    expect(mock.calls[1]!.system).toBe('ACME')
  })

  it('inject:false keeps facts out of the prompt', async () => {
    const mock = new MockAIProvider()
    const { ai } = client(mock, { inject: false })
    await ai.remember('u', 'x')
    await ai.replyInChat('c', 'hola', { userId: 'u' })
    expect(mock.calls[0]!.system).toBe('ACME')
  })

  it('autoExtract stores validated facts in the background', async () => {
    const mock = dualProvider(() => '{"facts":["Es de Bogotá","Compró una cafetera"]}')
    const { ai } = client(mock)
    expect(await ai.replyInChat('c', 'Soy de Bogotá y ayer compré una cafetera', { userId: 'u' })).toBe('ok')
    await ai.idle()
    expect(await ai.memory('u')).toEqual(['Es de Bogotá', 'Compró una cafetera'])
    const facts = await ai.memoryFacts('u')
    expect(facts.every((f) => f.source === 'auto')).toBe(true)
    // the extraction call saw the exchange and is not part of the chat history
    const extractCall = mock.calls.find((c) => c.system?.includes('long-term memory'))!
    expect(extractCall.messages[0]!.content).toContain('USER: Soy de Bogotá')
    expect(extractCall.maxTokens).toBe(300)
  })

  it('invalid extraction output is ignored and reported, never stored', async () => {
    const mock = dualProvider(() => 'Claro, el usuario es de Bogotá')
    const { ai, errors } = client(mock)
    await ai.replyInChat('c', 'Soy de Bogotá', { userId: 'u' })
    await ai.idle()
    expect(await ai.memory('u')).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('extraction respects maxFactsPerTurn, filter and model overrides', async () => {
    const mock = dualProvider(() => '{"facts":["Tarjeta 4111 1111 1111 1111","Le gusta el café"]}')
    const { ai } = client(mock, { autoExtract: { maxFactsPerTurn: 2, model: 'mini', filter: (f) => !/\d{4}/.test(f) } })
    await ai.replyInChat('c', 'x', { userId: 'u' })
    await ai.idle()
    expect(await ai.memory('u')).toEqual(['Le gusta el café'])
    expect(mock.calls.find((c) => c.model === 'mini')).toBeDefined()
  })

  it('a failing memory read never fails the reply', async () => {
    const mock = new MockAIProvider({ reply: 'sigo' })
    const { ai, memory, errors } = client(mock, {})
    vi.spyOn(memory, 'list').mockRejectedValue(new Error('store down'))
    expect(await ai.replyInChat('c', 'hola', { userId: 'u' })).toBe('sigo')
    expect(errors).toHaveLength(1)
  })

  it('forget(userId, fact) and forget(userId)', async () => {
    const { ai } = client(new MockAIProvider(), {})
    await ai.remember('u', ['a', 'b'])
    expect(await ai.forget('u', 'a')).toBe(true)
    expect(await ai.memory('u')).toEqual(['b'])
    expect(await ai.forget('u')).toBe(true)
    expect(await ai.memory('u')).toEqual([])
  })

  it('without a MemoryManager the memory API rejects', async () => {
    const ai = new AIClient(new MockAIProvider(), new ContextManager(new MemoryStore()))
    await expect(ai.memory('u')).rejects.toThrow(/memory/)
  })
})

describe('aiPlugin({ memory })', () => {
  it('ctx.tools.ai.memory(ctx.sender) returns what the bot learned; facts are per user across chats', async () => {
    const mock = dualProvider((input) =>
      input.messages[0]!.content.includes('español') ? '{"facts":["Prefiere atención en español"]}' : '{"facts":[]}',
    )
    const { bot, chat, provider } = await createTestBot()
    bot.plug(aiPlugin({ __provider: mock, memory: { autoExtract: true, maxFacts: 10 } }))
    bot.when('memoria', async (ctx) => {
      const facts = await ctx.tools.ai.memory(ctx.sender)
      await ctx.reply(`facts=${facts.join('|')}`)
    })
    await chat.send('Por favor atiéndeme en español')
    await chat.expectReply('ok')
    await bot.injectTools.ai.idle()
    await chat.send('memoria')
    await chat.expectReply('facts=Prefiere atención en español')

    // same person writing in a group: facts are injected there too
    provider.incoming('hola grupo', { from: 'group@g.us', sender: chat.jid, isGroup: true } as never)
    await vi.waitFor(() => {
      const groupCall = mock.calls.filter((c) => !c.system?.includes('long-term memory')).at(-1)!
      expect(groupCall.messages.at(-1)!.content).toBe('hola grupo')
      expect(groupCall.system).toContain('Prefiere atención en español')
    })
  })

  it('without memory config: API works, but nothing is injected or extracted', async () => {
    const mock = new MockAIProvider({ reply: 'ok' })
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: mock }))
    await bot.injectTools.ai.remember(chat.jid, 'Es VIP')
    await chat.send('hola')
    await chat.expectReply('ok')
    await bot.injectTools.ai.idle()
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]!.system).toBeUndefined()
    expect(await bot.injectTools.ai.memory(chat.jid)).toEqual(['Es VIP'])
  })

  it('bot.deleteSubject(userId) erases the memory (GDPR erasure)', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: new MockAIProvider(), memory: true }))
    await bot.injectTools.ai.remember(chat.jid, ['Es de Bogotá'])
    expect((await bot.exportSubject(chat.jid)).userData.some((e) => e.namespace === 'ai.memory')).toBe(true)
    const res = await bot.deleteSubject(chat.jid)
    expect(res.userData).toBeGreaterThanOrEqual(1)
    expect(await bot.injectTools.ai.memory(chat.jid)).toEqual([])
  })

  it('/reset clears the chat context but keeps long-term memory', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: new MockAIProvider(), memory: true }))
    await bot.injectTools.ai.remember(chat.jid, 'Es de Bogotá')
    await chat.send('/reset')
    await chat.expectReply('reiniciada')
    expect(await bot.injectTools.ai.memory(chat.jid)).toEqual(['Es de Bogotá'])
  })
})
