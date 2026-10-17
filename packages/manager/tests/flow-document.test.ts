import { describe, it, expect } from 'vitest'
import { createTestBot } from '@bot-wa/core/testing'
import {
  compileFlowDocument,
  evaluateExpression,
  ExpressionError,
  FLOW_DOCUMENT_SCHEMA,
  FlowDocumentError,
  parseExpression,
  renderTemplate,
  validateFlowDocument,
  type FlowDocument,
} from '../src/index.js'

const ev = (src: string, scope: Record<string, unknown> = {}) => evaluateExpression(parseExpression(src), scope)

describe('safe expressions', () => {
  it('evaluates literals, paths, comparisons and boolean logic', () => {
    expect(ev('1 + 2')).toBe(3)
    expect(ev('age >= 18 && name != ""', { age: '20', name: 'Ana' })).toBe(true)
    expect(ev('!(a == 1) || b', { a: 1, b: false })).toBe(false)
    expect(ev('user.plan == "pro"', { user: { plan: 'pro' } })).toBe(true)
    expect(ev('missing.deep == null')).toBe(true)
    expect(ev('"a" + 1')).toBe('a1')
    expect(ev('-x', { x: '3' })).toBe(-3)
  })

  it('supports the whitelisted functions only', () => {
    expect(ev('len(name) > 2 && lower(name) == "ana"', { name: 'ANA' })).toBe(true)
    expect(ev('oneOf(color, "red", "blue")', { color: 'blue' })).toBe(true)
    expect(ev('contains($body, "hola")', { $body: 'hola mundo' })).toBe(true)
    expect(ev('empty(x)')).toBe(true)
    expect(() => parseExpression('eval("1")')).toThrow(ExpressionError)
    expect(() => parseExpression('len(1, 2)')).toThrow(/argument/)
  })

  it('rejects prototype access, code-ish syntax and oversized input', () => {
    expect(() => parseExpression('a.__proto__')).toThrow(/forbidden/)
    expect(() => parseExpression('constructor')).toThrow(/forbidden/)
    expect(() => parseExpression('a[0]')).toThrow(ExpressionError)
    expect(() => parseExpression('a = 1')).toThrow(ExpressionError)
    expect(() => parseExpression('x => x')).toThrow(ExpressionError)
    expect(() => parseExpression('1 == 1 == 1')).toThrow(ExpressionError)
    expect(() => parseExpression('('.repeat(40) + '1' + ')'.repeat(40))).toThrow(/deeply|tokens/)
    expect(() => parseExpression('a'.repeat(1001))).toThrow(/longer/)
    expect(ev('toString', {})).toBeUndefined()
    expect(ev('hasOwnProperty', {})).toBeUndefined()
  })

  it('renders {{ path }} templates', () => {
    expect(renderTemplate('Hola {{ name }}, plan {{user.plan}} {{nope}}!', { name: 'Ana', user: { plan: 'pro' } })).toBe('Hola Ana, plan pro !')
    expect(renderTemplate('{{__proto__}}', {})).toBe('')
  })
})

describe('flow document validation', () => {
  it('accepts a valid document', () => {
    const doc: FlowDocument = { version: 1, id: 'f', trigger: 'hola', steps: [{ kind: 'say', text: 'hi' }] }
    expect(validateFlowDocument(doc)).toEqual([])
  })

  it('reports issues with paths', () => {
    const issues = validateFlowDocument({
      version: 2,
      id: 'bad id!',
      trigger: [],
      steps: [
        { kind: 'say' },
        { kind: 'exec', code: 'process.exit()' },
        { kind: 'condition', if: 'a ===', then: [] },
        { kind: 'delay', duration: '2h' },
        { kind: 'choose', text: 'x', options: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }] },
        { kind: 'say', text: 'x', extra: true },
      ],
    })
    const paths = issues.map((i) => i.path)
    expect(paths).toEqual(expect.arrayContaining([
      '/version', '/id', '/trigger', '/steps/0/text', '/steps/1/kind', '/steps/2/if', '/steps/3/duration', '/steps/4/options/1/key', '/steps/5/extra',
    ]))
  })

  it('compileFlowDocument throws FlowDocumentError with issues', () => {
    try {
      compileFlowDocument({ version: 1 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(FlowDocumentError)
      expect((error as FlowDocumentError).issues.length).toBeGreaterThan(0)
    }
  })

  it('exposes a versioned JSON Schema', () => {
    expect(FLOW_DOCUMENT_SCHEMA.$schema).toContain('2020-12')
    expect(FLOW_DOCUMENT_SCHEMA.$id).toMatch(/v1\.json$/)
    expect(FLOW_DOCUMENT_SCHEMA.properties.version).toEqual({ const: 1 })
  })
})

describe('compiled flow documents run on a real bot', () => {
  it('say / ask / templated say', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(compileFlowDocument({
      version: 1, id: 'encuesta', trigger: 'encuesta',
      steps: [
        { kind: 'say', text: 'Hola!' },
        { kind: 'ask', text: '¿Tu nombre?', stateKey: 'name' },
        { kind: 'say', text: 'Gracias {{name}}' },
      ],
    }))
    await chat.send('encuesta')
    await chat.expectReply('Hola!')
    await chat.expectReply('¿Tu nombre?')
    await chat.send('Ana')
    await chat.expectReply('Gracias Ana')
    await bot.stop()
  })

  it('ask.validate re-prompts until the expression holds', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(compileFlowDocument({
      version: 1, id: 'edad', trigger: 'edad',
      steps: [
        { kind: 'ask', text: '¿Edad?', stateKey: 'age', validate: { expr: 'number($answer) >= 18', message: 'Debes ser mayor' } },
        { kind: 'say', text: 'ok {{age}}' },
      ],
    }))
    await chat.send('edad')
    await chat.expectReply('¿Edad?')
    await chat.send('12')
    await chat.expectReply('Debes ser mayor')
    await chat.send('30')
    await chat.expectReply('ok 30')
    await bot.stop()
  })

  it('choose with nested steps, condition and end', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(compileFlowDocument({
      version: 1, id: 'menu', trigger: ['menu', 'inicio'],
      steps: [
        {
          kind: 'choose', text: 'Elige', stateKey: 'opt',
          options: [
            { key: 'ventas', label: 'Ventas', steps: [{ kind: 'say', text: 'Ventas!' }] },
            { key: 'soporte', label: 'Soporte' },
          ],
        },
        { kind: 'condition', if: 'opt == "soporte"', then: [{ kind: 'end', text: 'Te paso con soporte' }], else: [{ kind: 'say', text: 'seguimos {{opt}}' }] },
        { kind: 'say', text: 'fin' },
      ],
    }))
    await chat.send('inicio')
    await chat.expectReply(/Elige/)
    await chat.send('2')
    await chat.expectReply('Te paso con soporte')
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.replies()).not.toContain('fin')

    await chat.send('menu')
    await chat.send('1')
    await chat.expectReply('Ventas!')
    await chat.expectReply('seguimos ventas')
    await chat.expectReply('fin')
    await bot.stop()
  })

  it('goto jumps to another registered flow; delay waits', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(compileFlowDocument({ version: 1, id: 'b', trigger: 'zzz-b', steps: [{ kind: 'say', text: 'en B' }] }))
    bot.registerFlow(compileFlowDocument({
      version: 1, id: 'a', trigger: 'go',
      steps: [{ kind: 'delay', duration: '20ms' }, { kind: 'say', text: 'en A' }, { kind: 'goto', target: 'b' }],
    }))
    await chat.send('go')
    await chat.expectReply('en A')
    await chat.expectReply('en B')
    await bot.stop()
  })

  it('trigger object with match strategy', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(compileFlowDocument({
      version: 1, id: 'precio', trigger: { keywords: ['precio'], match: 'contains' }, steps: [{ kind: 'say', text: '$10' }],
    }))
    await chat.send('cual es el precio?')
    await chat.expectReply('$10')
    await bot.stop()
  })
})
