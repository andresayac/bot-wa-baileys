/**
 * Safe expression language: parsing, evaluation, templates and the hard limits that
 * keep a stored document from doing anything but reading its own scope.
 */
import { describe, expect, it } from 'vitest'
import { ExpressionError, EXPRESSION_LIMITS, evaluateCondition, evaluateExpression, hasTemplate, parseExpression, renderTemplate, resolvePath } from '../src/index.js'

const ev = (src: string, scope: Record<string, unknown> = {}) => evaluateExpression(parseExpression(src), scope)

describe('expression parsing and evaluation', () => {
  it('evaluates literals, paths, operators and whitelisted functions', () => {
    expect(ev('1 + 2')).toBe(3)
    expect(ev('"a" + 2')).toBe('a2')
    expect(ev('len(name)', { name: 'Ana' })).toBe(3)
    expect(ev('lower(name)', { name: 'ANA' })).toBe('ana')
    expect(ev('number(age) + 1', { age: '20' })).toBe(21)
  })

  it('rejects unsupported operators and code-like input', () => {
    expect(() => parseExpression('1 * 2')).toThrow(ExpressionError)
    expect(() => parseExpression('eval("1")')).toThrow(/unknown function/)
    expect(() => parseExpression('a[0]')).toThrow(ExpressionError)
    expect(() => parseExpression('x => x')).toThrow(ExpressionError)
    expect(() => parseExpression('a = 1')).toThrow(ExpressionError)
    expect(() => parseExpression('new Function("1")')).toThrow(ExpressionError)
  })

  it('resolves only plain own properties', () => {
    const scope = { a: { b: 3 }, list: [4, 5] }
    expect(ev('a.b', scope)).toBe(3)
    expect(ev('a.missing', scope)).toBeUndefined()
    expect(ev('list', scope)).toEqual([4, 5])
    expect(resolvePath(scope, ['__proto__'])).toBeUndefined()
    expect(() => parseExpression('a.__proto__')).toThrow(/forbidden/)
    expect(() => parseExpression('constructor')).toThrow(/forbidden/)
    expect(() => parseExpression('prototype.x')).toThrow(/forbidden/)
  })

  it('compares numbers and numeric strings, and coerces booleans to conditions', () => {
    expect(ev('age >= 18', { age: '21' })).toBe(true)
    expect(ev('name == "Ana"', { name: 'Ana' })).toBe(true)
    expect(ev('name != "Ana"', { name: 'Bea' })).toBe(true)
    expect(ev('!empty(name)', { name: 'x' })).toBe(true)
    expect(ev('oneOf(kind, "a", "b")', { kind: 'b' })).toBe(true)
    expect(evaluateCondition(parseExpression('n > 2'), { n: 3 })).toBe(true)
    expect(evaluateCondition(parseExpression('n'), { n: 0 })).toBe(false)
  })

  it('applies the length, depth and token limits', () => {
    expect(() => parseExpression('a'.repeat(EXPRESSION_LIMITS.maxLength + 1))).toThrow(/longer/)
    expect(() => parseExpression('('.repeat(60) + '1' + ')'.repeat(60))).toThrow(/deeply|tokens/)
    expect(() => parseExpression('len(1, 2)')).toThrow(/argument/)
    expect(() => parseExpression('')).toThrow(/non-empty/)
  })

  it('renders only {{ path }} placeholders, never expressions', () => {
    const scope = { name: 'Ana', address: { city: 'Cali' }, $body: 'hola' }
    expect(renderTemplate('Hola {{name}} de {{ address.city }} / {{$body}}', scope)).toBe('Hola Ana de Cali / hola')
    expect(renderTemplate('{{missing}}', scope)).toBe('')
    expect(hasTemplate('a {{x}}')).toBe(true)
    expect(hasTemplate('a {{x + 1}}')).toBe(false)
  })
})
