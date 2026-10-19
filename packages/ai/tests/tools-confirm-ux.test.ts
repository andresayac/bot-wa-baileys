import { describe, it, expect } from 'vitest'
import { MemoryStore } from '@bot-wa/core'
import { createTestBot } from '@bot-wa/core/testing'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { AIClient } from '../src/AIClient.js'
import { ContextManager } from '../src/ContextManager.js'
import { aiPlugin, type AIPluginConfig } from '../src/plugin.js'
import { classifyConfirmation } from '../src/tools/confirm.js'
import { defaultConfirmPrompt } from '../src/tools/runner.js'
import { argLines, humanizeName, summarizeValue } from '../src/tools/present.js'
import type { AITool, AIToolEvent, AIToolSet, SafeParseSchema, ToolConfirmRequest } from '../src/tools/types.js'
import type { GenerateInput } from '../src/types.js'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

const MENU = ['torta_chocolate', 'pan_queso', 'cafe']
const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { producto: { type: 'string', enum: MENU }, cantidad: { type: 'integer', minimum: 1 } },
        required: ['producto', 'cantidad'],
      },
    },
  },
  required: ['items'],
}

function lastOf(input: GenerateInput) {
  return input.messages[input.messages.length - 1]
}

/** Parsed JSON of the last tool result, if it is JSON. */
function lastToolJson(input: GenerateInput): Record<string, unknown> | undefined {
  const last = lastOf(input)
  if (last?.role !== 'tool') return undefined
  try { return JSON.parse(last.results[0]?.content ?? '') as Record<string, unknown> } catch { return undefined }
}

/**
 * Bakery model: "pide N torta" → crear_pedido(N × torta_chocolate). When the
 * confirmation comes back as a user reply mentioning a number, it re-proposes
 * with that quantity. Otherwise it echoes the tool result.
 */
function bakeryModel() {
  return new MockAIProvider({
    reply: (input) => {
      const last = lastOf(input)
      if (last?.role === 'tool') {
        const json = lastToolJson(input)
        const qty = typeof json?.userReply === 'string' ? /(\d+)/.exec(json.userReply)?.[1] : undefined
        if (json?.reason === 'user_replied' && qty) {
          return { toolCalls: [{ name: 'crear_pedido', args: { items: [{ producto: 'torta_chocolate', cantidad: Number(qty) }] } }] }
        }
        return `final: ${last.results.map((r) => `${r.isError ? 'ERR ' : ''}${r.content}`).join(' | ')}`
      }
      const n = last?.role === 'user' ? /pide (\d+)/.exec(last.content)?.[1] : undefined
      if (n) return { toolCalls: [{ name: 'crear_pedido', args: { items: [{ producto: 'torta_chocolate', cantidad: Number(n) }] } }] }
      return `eco: ${last?.role === 'user' ? last.content : ''}`
    },
  })
}

function orderTool(ran: unknown[], extra: Partial<AITool<unknown>> = {}): AIToolSet {
  return {
    crear_pedido: {
      description: 'Registra un pedido. items: lista de {producto, cantidad} usando las claves del menú',
      schema: ORDER_SCHEMA,
      confirm: true,
      handler: (args) => { ran.push(args); return { pedido: ran.length, total: 25000 } },
      ...extra,
    },
  }
}

async function bakeryBot(tools: AIToolSet, mock = bakeryModel(), cfg: Partial<AIPluginConfig> = {}) {
  // A channel without native buttons (WhatsApp via Baileys): the typed yes/no question.
  const { bot, chat } = await createTestBot({}, { provider: { buttons: false } })
  bot.plug(aiPlugin({ __provider: mock, tools, ...cfg }))
  return { bot, chat, mock }
}

describe('human-readable confirmation prompt', () => {
  it('humanizes tool names', () => {
    expect(humanizeName('crear_pedido')).toBe('Crear pedido')
    expect(humanizeName('createOrder')).toBe('Create order')
    expect(humanizeName('cancel-order')).toBe('Cancel order')
  })

  it('never shows the description nor JSON: title + one readable line per item', () => {
    const tool = orderTool([])['crear_pedido']!
    const prompt = defaultConfirmPrompt('crear_pedido', tool, {
      items: [{ producto: 'torta_chocolate', cantidad: 5 }, { producto: 'cafe', cantidad: 2 }],
    })
    expect(prompt).toBe('Voy a: Crear pedido\n• 5 × torta_chocolate\n• 2 × cafe\n¿Confirmas? (sí/no)')
    expect(prompt).not.toContain('Registra')
    expect(prompt).not.toContain('{')
  })

  it('uses the tool title and renders mixed arguments', () => {
    const prompt = defaultConfirmPrompt('agendar', { description: 'x', title: 'Agendar cita', handler: () => 'ok' }, {
      fechaHora: '2026-10-20 10:00', paraOtro: false, notas: '', extras: ['agua', 'toalla'],
      direccion: { calle: 'Calle 1', ciudad: 'Bogotá' },
    })
    expect(prompt).toBe([
      'Voy a: Agendar cita',
      '• Fecha hora: 2026-10-20 10:00',
      '• Para otro: no',
      '• Extras: agua, toalla',
      '• Direccion: Calle: Calle 1, Ciudad: Bogotá',
      '¿Confirmas? (sí/no)',
    ].join('\n'))
  })

  it('lists nested objects under their key and truncates long lists', () => {
    expect(argLines({ cliente: 'Ana', items: [{ sku: 'a', qty: 1 }] })).toEqual(['• Cliente: Ana', '• Items:', '   ◦ 1 × a'])
    const many = argLines({ items: Array.from({ length: 20 }, (_v, i) => ({ producto: `p${i}`, cantidad: 1 })) })
    expect(many).toHaveLength(12)
    expect(many.at(-1)).toBe('… y 9 más')
    expect(argLines({ items: [] })).toEqual([])
  })

  it('English and custom confirmMessage still work', () => {
    const tool = orderTool([])['crear_pedido']!
    expect(defaultConfirmPrompt('crear_pedido', tool, { items: [{ producto: 'cafe', cantidad: 1 }] }, { lang: 'en' }))
      .toBe('About to: Crear pedido\n• 1 × cafe\nDo you confirm? (yes/no)')
    expect(defaultConfirmPrompt('x', { description: 'd', confirmMessage: (a) => `¿Seguro ${(a as { n: number }).n}?`, handler: () => 0 }, { n: 3 }))
      .toBe('¿Seguro 3?')
  })

  it('labels: argument values render with their human label (nested items, lists, top-level)', () => {
    const tool: AITool<unknown> = {
      description: 'd',
      title: 'Crear pedido',
      labels: {
        producto: { torta_chocolate: 'Torta de chocolate', pan_queso: 'Pan de queso' },
        entrega: { domicilio: 'A domicilio' },
        extras: { velas: 'Velas' },
      },
      handler: () => 'ok',
    }
    expect(defaultConfirmPrompt('crear_pedido', tool, {
      items: [{ producto: 'torta_chocolate', cantidad: 2 }, { producto: 'cafe', cantidad: 1 }],
    })).toBe('Voy a: Crear pedido\n• 2 × Torta de chocolate\n• 1 × cafe\n¿Confirmas? (sí/no)')
    expect(argLines({ cliente: 'Ana', entrega: 'domicilio', extras: ['velas', 'globos'], items: [{ producto: 'pan_queso', cantidad: 3 }] }, undefined, tool.labels))
      .toEqual(['• Cliente: Ana', '• Entrega: A domicilio', '• Extras: Velas, globos', '• Items:', '   ◦ 3 × Pan de queso'])
    // Labels only apply under their own key.
    expect(argLines({ cliente: 'domicilio' }, undefined, tool.labels)).toEqual(['• Cliente: domicilio'])
  })

  it('confirmLines: code-computed lines replace the argument lines inside the localized prompt', () => {
    const tool: AITool<{ items: Array<{ producto: string; cantidad: number }> }> = {
      description: 'd',
      title: 'Crear pedido',
      labels: { producto: { cafe: 'Café' } },
      confirmLines: (a) => [...a.items.map((i) => `• ${i.cantidad} × ${i.producto}`), `Total: $${a.items.length * 1000}`],
      handler: () => 'ok',
    }
    const prompt = defaultConfirmPrompt('crear_pedido', tool as AITool<unknown>, { items: [{ producto: 'cafe', cantidad: 2 }] }, { lang: 'en' })
    expect(prompt).toBe('About to: Crear pedido\n• 2 × cafe\nTotal: $1000\nDo you confirm? (yes/no)')
    // confirmMessage still wins over everything.
    expect(defaultConfirmPrompt('x', { ...tool, confirmMessage: 'custom' } as AITool<unknown>, { items: [] })).toBe('custom')
    // An empty list renders the bare prompt.
    expect(defaultConfirmPrompt('x', { description: 'd', confirmLines: () => [], handler: () => 0 }, {})).toBe('Voy a: X\n¿Confirmas? (sí/no)')
  })

  it('the plugin asks with labels applied', async () => {
    const tools = orderTool([])
    tools['crear_pedido'] = { ...tools['crear_pedido']!, labels: { producto: { torta_chocolate: 'Torta de chocolate' } } }
    const { chat } = await bakeryBot(tools)
    await chat.send('pide 2')
    await chat.expectReply('Voy a: Crear pedido\n• 2 × Torta de chocolate\n¿Confirmas? (sí/no)')
  })

  it('the plugin asks with the readable prompt', async () => {
    const ran: unknown[] = []
    const { chat } = await bakeryBot(orderTool(ran))
    await chat.send('pide 1')
    await chat.expectReply('Voy a: Crear pedido\n• 1 × torta_chocolate\n¿Confirmas? (sí/no)')
  })
})

describe('answers to a pending confirmation', () => {
  it('classifies clear yes / clear no / anything else', () => {
    for (const yes of ['si', 'Sí!', 'sí, por favor', 'ok perfecto', 'dale', 'de acuerdo', 'Yes please', 'listo']) {
      expect(classifyConfirmation(yes), yes).toBe('approved')
    }
    for (const no of ['no', 'No, gracias', 'cancelar', 'mejor no', 'nope']) {
      expect(classifyConfirmation(no), no).toBe('denied')
    }
    for (const other of ['si pero cambia a 5 unidades', 'sí, y agrega un café', 'no, mejor 3', 'cuánto cuesta?', 'si no', '']) {
      expect(classifyConfirmation(other), other).toEqual({ reply: other.trim() })
    }
    expect(classifyConfirmation('adelante', { yes: ['adelante'] })).toBe('approved')
    expect(classifyConfirmation('jamás', { no: ['jamas'] })).toBe('denied')
  })

  it('"sí pero cambia a 5 unidades" does not run the tool: the model gets the reply and re-proposes', async () => {
    const ran: unknown[] = []
    const events: AIToolEvent[] = []
    const { chat, mock } = await bakeryBot(orderTool(ran), undefined, { onToolEvent: (e) => events.push(e) })
    await chat.send('pide 1')
    await chat.expectReply(/• 1 × torta_chocolate/)
    await chat.send('si pero cambia a 5 unidades')
    await chat.expectReply('Voy a: Crear pedido\n• 5 × torta_chocolate\n¿Confirmas? (sí/no)')
    expect(ran).toEqual([])
    // The model saw a non-executed result carrying the user's text.
    const replied = mock.calls.map(lastToolJson).find((j) => j?.reason === 'user_replied')
    expect(replied).toMatchObject({ executed: false, reason: 'user_replied', userReply: 'si pero cambia a 5 unidades' })
    await chat.send('sí')
    await chat.expectReply(/final: \{"pedido":1/)
    expect(ran).toEqual([{ items: [{ producto: 'torta_chocolate', cantidad: 5 }] }])
    expect(events.map((e) => e.type)).toContain('tool.confirm.replied')
  })

  it('an explicit "no" is still a denial', async () => {
    const ran: unknown[] = []
    const { chat } = await bakeryBot(orderTool(ran))
    await chat.send('pide 1')
    await chat.expectReply(/¿Confirmas\?/)
    await chat.send('No, gracias')
    await chat.expectReply(/final: ERR The user declined to run "crear_pedido"/)
    expect(ran).toEqual([])
  })

  it('confirmWith classifies the same way (custom confirmer path)', async () => {
    const ran: unknown[] = []
    const ai = new AIClient(bakeryModel(), new ContextManager(new MemoryStore()), { tools: orderTool(ran) })
    const answers = ['si pero mejor 3', 'si']
    const prompts: string[] = []
    const { confirmWith } = await import('../src/tools/confirm.js')
    const confirm = confirmWith({ ask: async (q: unknown) => { prompts.push(String(q)); return answers.shift() ?? 'no' } } as never)
    const text = await ai.replyInChat('k', 'pide 1', { confirm })
    expect(text).toMatch(/final: \{"pedido":1/)
    expect(ran).toEqual([{ items: [{ producto: 'torta_chocolate', cantidad: 3 }] }])
    expect(prompts[1]).toContain('• 3 × torta_chocolate')
  })
})

describe('system prompt note for confirm tools', () => {
  it('tells the model the system confirms these tools (autoreply), localized', async () => {
    const { chat, mock } = await bakeryBot(orderTool([]), undefined, { persona: 'Eres la panadería.' })
    await chat.send('hola')
    await chat.expectReply('eco: hola')
    const system = mock.calls[0]?.system ?? ''
    expect(system.startsWith('Eres la panadería.')).toBe(true)
    expect(system).toContain('confirma el sistema')
    expect(system).toContain('crear_pedido')
    expect(system).toContain('No pidas confirmación tú mismo')
  })

  it('English with ctx.lang en; a custom string; off with systemNote: false', async () => {
    const en = await createTestBot({ i18n: { defaultLocale: 'en' } })
    const m1 = bakeryModel()
    en.bot.plug(aiPlugin({ __provider: m1, tools: orderTool([]) }))
    await en.chat.send('hi')
    await en.chat.expectReply('eco: hi')
    expect(m1.calls[0]?.system).toContain('Do not ask for confirmation yourself')

    const custom = await bakeryBot(orderTool([]), undefined, { toolConfirm: { systemNote: 'NOTA PROPIA' } })
    await custom.chat.send('hola')
    await custom.chat.expectReply('eco: hola')
    expect(custom.mock.calls[0]?.system).toBe('NOTA PROPIA')

    const off = await bakeryBot(orderTool([]), undefined, { toolConfirm: { systemNote: false } })
    await off.chat.send('hola')
    await off.chat.expectReply('eco: hola')
    expect(off.mock.calls[0]?.system).toBeUndefined()
  })

  it('is not added without a confirmer (the tools would be denied anyway) nor without confirm tools', async () => {
    const m = bakeryModel()
    const ai = new AIClient(m, new ContextManager(new MemoryStore()), { tools: orderTool([]) })
    await ai.ask('hola')
    expect(m.calls[0]?.system).toBeUndefined()
    const plain = await bakeryBot({ buscar: { description: 'b', handler: () => 'x' } })
    await plain.chat.send('hola')
    await plain.chat.expectReply('eco: hola')
    expect(plain.mock.calls[0]?.system).toBeUndefined()
  })
})

describe('repeated side effects', () => {
  it('summarizes a result without unreadable "…" placeholders for nested lists', () => {
    const order = {
      orderId: 'B-1001',
      status: 'pending',
      lines: [{ product: 'croissant', name: 'Croissant', quantity: 3, subtotal: '$9.00' }, { product: 'bagel', name: 'Bagel', quantity: 1, subtotal: '$2.00' }],
      total: '$11.00',
    }
    expect(summarizeValue(order)).toBe('Order id: B-1001, Status: pending, Total: $11.00')
    // Lists of plain values are still shown.
    expect(summarizeValue({ ids: ['a', 'b'], status: 'ok' })).toBe('Ids: a, b, Status: ok')
  })

  it('a second call of an already-run confirm tool mentions the previous run, and the model is told about it', async () => {
    const ran: unknown[] = []
    const { chat, mock } = await bakeryBot(orderTool(ran))
    await chat.send('pide 1')
    await chat.expectReply(/¿Confirmas/)
    await chat.send('si')
    await chat.expectReply(/final: \{"pedido":1/)
    // New turn: the model's system prompt lists the action already done.
    await chat.send('no nada mas')
    await chat.expectReply('eco: no nada mas')
    const system = mock.calls.at(-1)?.system ?? ''
    expect(system).toContain('Acciones ya ejecutadas')
    expect(system).toContain('Crear pedido (crear_pedido): 1 × torta_chocolate → Pedido: 1, Total: 25000')
    // The model calls it again anyway: the user is warned before confirming.
    await chat.send('pide 1')
    await chat.expectReply([
      'Ojo: ya hice «Crear pedido» hace un momento (resultado: Pedido: 1, Total: 25000). Si confirmas, se hará otra vez.',
      '',
      'Voy a: Crear pedido',
      '• 1 × torta_chocolate',
      '¿Confirmas? (sí/no)',
    ].join('\n'))
    await chat.send('no')
    await chat.expectReply(/declined/)
    expect(ran).toHaveLength(1)
  })

  it('a call with DIFFERENT arguments is not warned as a repeat (e.g. changing 3 → 2 units)', async () => {
    const ran: unknown[] = []
    const requests: ToolConfirmRequest[] = []
    const ai = new AIClient(bakeryModel(), new ContextManager(new MemoryStore()), { tools: orderTool(ran) })
    const confirm = async (req: ToolConfirmRequest) => { requests.push(req); return 'approved' as const }
    await ai.replyInChat('k', 'pide 3', { confirm })
    await ai.replyInChat('k', 'pide 2', { confirm })
    expect(ran).toHaveLength(2)
    expect(requests[1]?.previous).toBeUndefined()
    expect(requests[1]?.prompt).not.toMatch(/Ojo|otra vez/)
    // The same arguments again: warned, with the previous run.
    await ai.replyInChat('k', 'pide 3', { confirm })
    expect(requests[2]?.previous?.args).toEqual({ items: [{ producto: 'torta_chocolate', cantidad: 3 }] })
    expect(requests[2]?.prompt).toMatch(/^Ojo: ya hice «Crear pedido» hace un momento \(resultado: .*\)\. Si confirmas, se hará otra vez\./)
  })

  it('the confirmer receives `previous`; /reset forgets it', async () => {
    const ran: unknown[] = []
    const { chat } = await bakeryBot(orderTool(ran))
    await chat.send('pide 1')
    await chat.send('si')
    await chat.expectReply(/final:/)
    await chat.send('/reset')
    await chat.expectReply(/reiniciada/)
    await chat.send('pide 2')
    await chat.expectReply('Voy a: Crear pedido\n• 2 × torta_chocolate\n¿Confirmas? (sí/no)')
  })

  it('a run that returns { error } is not remembered as done (no repeat notice, no dedupe block)', async () => {
    const ran: unknown[] = []
    const requests: ToolConfirmRequest[] = []
    const mock = bakeryModel()
    const ai = new AIClient(mock, new ContextManager(new MemoryStore()), {
      tools: orderTool(ran, { dedupe: 'args', handler: (args) => { ran.push(args); return { error: 'Sin stock' } } }),
    })
    const confirm = async (req: ToolConfirmRequest) => { requests.push(req); return 'approved' as const }
    expect(await ai.replyInChat('k', 'pide 1', { confirm })).toBe('final: {"error":"Sin stock"}')
    await ai.replyInChat('k', 'pide 1', { confirm })
    expect(ran).toHaveLength(2)
    expect(requests.map((r) => r.previous)).toEqual([undefined, undefined])
    expect(mock.calls.at(-1)?.system ?? '').not.toContain('Acciones ya ejecutadas')
  })

  it('dedupe: an identical call within the window is not run nor confirmed; the model gets { reason: duplicate }', async () => {
    const ran: unknown[] = []
    const events: AIToolEvent[] = []
    const requests: ToolConfirmRequest[] = []
    const mock = bakeryModel()
    const ai = new AIClient(mock, new ContextManager(new MemoryStore()), {
      tools: orderTool(ran, { dedupe: 'args' }),
      onToolEvent: (e) => events.push(e),
    })
    const confirm = async (req: ToolConfirmRequest) => { requests.push(req); return 'approved' as const }
    await ai.replyInChat('k', 'pide 1', { confirm })
    const second = await ai.replyInChat('k', 'pide 1', { confirm })
    expect(ran).toHaveLength(1)
    expect(requests).toHaveLength(1)
    const dup = JSON.parse(second.replace(/^final: /, '')) as Record<string, unknown>
    expect(dup).toMatchObject({ executed: false, reason: 'duplicate', previous: { result: { pedido: 1, total: 25000 } } })
    expect(events.map((e) => e.type)).toContain('tool.duplicate')
    // Different arguments are not a duplicate, nor a repeat: no "will be done again" warning.
    await ai.replyInChat('k', 'pide 4', { confirm })
    expect(ran).toHaveLength(2)
    expect(requests[1]?.previous).toBeUndefined()
    expect(requests[1]?.prompt).toBe('Voy a: Crear pedido\n• 4 × torta_chocolate\n¿Confirmas? (sí/no)')
    // Another chat is independent.
    await ai.replyInChat('other', 'pide 1', { confirm })
    expect(ran).toHaveLength(3)
  })

  it('dedupe { windowMs } expires', async () => {
    const ran: unknown[] = []
    const ai = new AIClient(bakeryModel(), new ContextManager(new MemoryStore()), { tools: orderTool(ran, { dedupe: { windowMs: 20 } }) })
    const confirm = async () => 'approved' as const
    await ai.replyInChat('k', 'pide 1', { confirm })
    await tick(40)
    await ai.replyInChat('k', 'pide 1', { confirm })
    expect(ran).toHaveLength(2)
  })

  it('dedupe works for tools without confirm too', async () => {
    let n = 0
    const mock = new MockAIProvider({
      reply: (input) => lastOf(input)?.role === 'tool' ? `final: ${(lastOf(input) as { content: string }).content}` : { toolCalls: [{ name: 'enviar', args: { a: 1 } }] },
    })
    const ai = new AIClient(mock, new ContextManager(new MemoryStore()), { tools: { enviar: { description: 'e', dedupe: 'args', handler: () => ++n } } })
    await ai.replyInChat('k', 'x')
    expect(await ai.replyInChat('k', 'x')).toMatch(/"reason":"duplicate"/)
    expect(n).toBe(1)
    // Without a chat key (ask) there is no ledger.
    await ai.ask('x')
    expect(n).toBe(2)
  })
})

describe('argument validation happens before the confirmation', () => {
  it('an enum violation (nested in items) never reaches the user; the model gets the error', async () => {
    const ran: unknown[] = []
    const requests: ToolConfirmRequest[] = []
    const events: AIToolEvent[] = []
    const mock = new MockAIProvider({
      reply: (input) => {
        const last = lastOf(input)
        if (last?.role === 'tool') return `final: ${last.results.map((r) => `${r.isError ? 'ERR ' : ''}${r.content}`).join(' | ')}`
        return { toolCalls: [{ name: 'crear_pedido', args: { items: [{ producto: 'torta de chocolate', cantidad: 1 }] } }] }
      },
    })
    const ai = new AIClient(mock, new ContextManager(new MemoryStore()), { tools: orderTool(ran), onToolEvent: (e) => events.push(e) })
    const text = await ai.replyInChat('k', 'x', { confirm: async (r) => { requests.push(r); return 'approved' } })
    expect(requests).toEqual([])
    expect(ran).toEqual([])
    expect(text).toContain('ERR Error: invalid arguments for "crear_pedido": $.items[0].producto: must be one of "torta_chocolate", "pan_queso", "cafe"')
    expect(text).toContain('the user was not asked')
    expect(events.map((e) => e.type)).toEqual(['tool.invalid_args'])
  })

  it('required, types, minimum and minItems are enforced', async () => {
    const { validateArgs } = await import('../src/tools/schema.js')
    const tool = orderTool([])['crear_pedido']!
    expect(validateArgs(tool, { items: [] })).toMatchObject({ ok: false, error: expect.stringContaining('at least 1 items') })
    expect(validateArgs(tool, { items: [{ producto: 'cafe', cantidad: 0 }] })).toMatchObject({ ok: false, error: expect.stringContaining('>= 1') })
    expect(validateArgs(tool, { items: [{ producto: 'cafe', cantidad: 1.5 }] })).toMatchObject({ ok: false, error: expect.stringContaining('expected integer') })
    expect(validateArgs(tool, { items: [{ producto: 'cafe' }] })).toMatchObject({ ok: false, error: expect.stringContaining('cantidad: is required') })
    expect(validateArgs(tool, {})).toMatchObject({ ok: false, error: expect.stringContaining('items: is required') })
    expect(validateArgs(tool, { items: [{ producto: 'cafe', cantidad: 2 }] })).toEqual({ ok: true, data: { items: [{ producto: 'cafe', cantidad: 2 }] } })
    expect(validateArgs({ description: 'n', schema: { type: 'object', properties: { s: { type: 'string', minLength: 2, maxLength: 3 } } }, handler: () => 0 }, { s: 'abcd' }))
      .toMatchObject({ ok: false })
  })

  it('a failing safeParse validator does not prompt either', async () => {
    const schema: SafeParseSchema<{ n: number }> = {
      safeParse: (input) => (input as { n?: unknown }).n === 1 ? { success: true, data: { n: 1 } } : { success: false, error: { issues: [{ path: ['n'], message: 'must be 1' }] } },
    }
    const requests: unknown[] = []
    const mock = new MockAIProvider({
      reply: (input) => lastOf(input)?.role === 'tool' ? 'final' : { toolCalls: [{ name: 't', args: { n: 2 } }] },
    })
    const ai = new AIClient(mock, new ContextManager(new MemoryStore()), { tools: { t: { description: 't', schema, confirm: true, handler: () => 'x' } } })
    await ai.replyInChat('k', 'x', { confirm: async (r) => { requests.push(r); return 'approved' } })
    expect(requests).toEqual([])
    const toolTurn = mock.calls[1]?.messages.at(-1)
    expect(toolTurn?.role === 'tool' && toolTurn.results[0]?.content).toMatch(/n: must be 1/)
  })
})
