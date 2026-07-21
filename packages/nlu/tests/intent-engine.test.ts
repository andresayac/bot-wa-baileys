import { describe, expect, it } from 'vitest'
import { IntentEngine, normalizeText } from '../src/index.js'

function greetingEngine(): IntentEngine {
  return new IntentEngine()
    .define('greeting', ['hola', 'buenas', 'buenos días'])
    .define('farewell', ['adiós', 'hasta luego', 'nos vemos'])
}

describe('normalizeText', () => {
  it('lowercases, strips diacritics and punctuation, collapses whitespace', () => {
    expect(normalizeText('  ¡Hola, SEÑOR!  ¿Cómo está? ')).toBe('hola senor como esta')
    expect(normalizeText('pedido #123')).toBe('pedido 123')
    expect(normalizeText('')).toBe('')
  })
})

describe('IntentEngine.define / validation', () => {
  it('rejects empty intent names and empty utterance lists', () => {
    const nlu = new IntentEngine()
    expect(() => nlu.define('', ['x'])).toThrow(/non-empty/)
    expect(() => nlu.define('x', [])).toThrow(/at least one/)
    expect(() => nlu.define('x', ['   '])).toThrow(/at least one/)
    expect(() => nlu.define('x', 'nope' as unknown as string[])).toThrow(/array/)
  })

  it('rejects out-of-range thresholds', () => {
    expect(() => new IntentEngine({ threshold: 1.5 })).toThrow(/threshold/)
    expect(() => new IntentEngine({ threshold: -0.1 })).toThrow(/threshold/)
  })

  it('appends utterances when define() is called twice for the same intent', () => {
    const nlu = new IntentEngine().define('greeting', ['hola']).define('greeting', ['buenas'])
    expect(nlu.match('hola')?.intent).toBe('greeting')
    expect(nlu.match('buenas')?.intent).toBe('greeting')
    expect(nlu.intents()).toEqual(['greeting'])
  })
})

describe('IntentEngine.match — exact matching & normalization', () => {
  it('matches exact utterances with confidence 1 (case/punctuation/diacritics-insensitive)', () => {
    const nlu = greetingEngine()
    const m = nlu.match('¡HOLA!')
    expect(m?.intent).toBe('greeting')
    expect(m?.confidence).toBe(1)

    const m2 = nlu.match('  Buenos   Días??? ')
    expect(m2?.intent).toBe('greeting')
    expect(m2?.confidence).toBe(1)

    // Diacritics in the input are fine too.
    expect(nlu.match('adios')?.intent).toBe('farewell')
    expect(nlu.match('ADIÓS')?.intent).toBe('farewell')
  })

  it('returns null for empty or whitespace-only input', () => {
    const nlu = greetingEngine()
    expect(nlu.match('')).toBeNull()
    expect(nlu.match('   \n\t ')).toBeNull()
  })

  it('returns null when no intent crosses the threshold', () => {
    const nlu = greetingEngine()
    expect(nlu.match('zzz qqq xrx')).toBeNull()
    expect(nlu.match('cuánto cuesta el envío a medellín')).toBeNull()
  })
})

describe('IntentEngine.match — paraphrase via token overlap', () => {
  const orderEngine = () =>
    new IntentEngine().define('order.status', ['quiero ver el estado de mi pedido'])

  it('scores a subsequence paraphrase (utterance contained in the input) above threshold', () => {
    const m = orderEngine().match('ver el estado de mi pedido por favor')
    expect(m?.intent).toBe('order.status')
    expect(m!.confidence).toBeGreaterThan(0.5)
    expect(m!.confidence).toBeLessThanOrEqual(1)
  })

  it('scores a word-order paraphrase above threshold', () => {
    const m = orderEngine().match('pedido mi de estado el ver')
    expect(m?.intent).toBe('order.status')
    expect(m!.confidence).toBeGreaterThan(0.5)
  })

  it('scores a partial paraphrase above threshold when the utterance is covered', () => {
    const m = orderEngine().match('el estado de mi pedido')
    expect(m?.intent).toBe('order.status')
    expect(m!.confidence).toBeGreaterThan(0.5)
  })

  it('stays below threshold when too few utterance tokens appear', () => {
    expect(orderEngine().match('pedido')).toBeNull()
    expect(orderEngine().match('estado')).toBeNull()
  })
})

describe('IntentEngine.match — confidence ordering & determinism', () => {
  it('picks the strongest intent when several overlap', () => {
    const nlu = new IntentEngine()
      .define('greeting', ['hola'])
      .define('order.status', ['estado de mi pedido'])
    const m = nlu.match('hola quiero el estado de mi pedido')
    expect(m?.intent).toBe('order.status')
    const ranked = nlu.rank('hola quiero el estado de mi pedido')
    expect(ranked[0].intent).toBe('order.status')
    expect(ranked[1].intent).toBe('greeting')
    expect(ranked[0].confidence).toBeGreaterThan(ranked[1].confidence)
  })

  it('rank() returns only positive scores, sorted descending', () => {
    const nlu = greetingEngine().define('order.status', ['estado de mi pedido'])
    const ranked = nlu.rank('hola')
    expect(ranked.map((r) => r.intent)).toEqual(['greeting'])
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].confidence).toBeGreaterThanOrEqual(ranked[i].confidence)
    }
  })

  it('is deterministic: identical input yields identical output', () => {
    const nlu = greetingEngine().define('order.status', ['estado de mi pedido', 'mi pedido {id}'])
    const input = 'Hola, quisiera ver el estado de mi pedido 555 por favor'
    expect(nlu.match(input)).toEqual(nlu.match(input))
    expect(nlu.rank(input)).toEqual(nlu.rank(input))
  })
})

describe('IntentEngine — threshold control', () => {
  it('honors a custom engine threshold', () => {
    const strict = new IntentEngine({ threshold: 0.95 }).define('order.status', [
      'quiero ver el estado de mi pedido',
    ])
    expect(strict.match('pedido mi de estado el ver')).toBeNull() // ~0.69 < 0.95
    expect(strict.match('quiero ver el estado de mi pedido')?.confidence).toBe(1)
  })

  it('accepts a per-call threshold override', () => {
    const nlu = new IntentEngine().define('order.status', ['quiero ver el estado de mi pedido'])
    const text = 'pedido mi de estado el ver'
    expect(nlu.match(text, 0.9)).toBeNull()
    expect(nlu.match(text, 0.3)?.intent).toBe('order.status')
  })
})

describe('IntentEngine — {slot} entities', () => {
  it('captures a single slot with confidence 1', () => {
    const nlu = new IntentEngine().define('order.status', ['mi pedido {id}'])
    const m = nlu.match('mi pedido 12345')
    expect(m?.intent).toBe('order.status')
    expect(m?.confidence).toBe(1)
    expect(m?.entities).toEqual({ id: '12345' })
  })

  it('captures multiple slots in order', () => {
    const nlu = new IntentEngine().define('travel', ['vuelo de {origen} a {destino}'])
    const m = nlu.match('vuelo de Bogotá a Lima')
    expect(m?.entities).toEqual({ origen: 'bogota', destino: 'lima' })
    expect(m?.confidence).toBe(1)
  })

  it('still matches (without entities) when the slot pattern does not line up', () => {
    const nlu = new IntentEngine().define('order.status', ['mi pedido {id}'])
    // Extra trailing tokens break the anchored slot pattern; token overlap still scores.
    const m = nlu.match('donde esta mi pedido')
    expect(m?.intent).toBe('order.status')
    expect(m!.confidence).toBeGreaterThan(0.5)
    expect(m?.entities).toBeUndefined()
  })

  it('normalizes slot values (lowercase, no diacritics)', () => {
    const nlu = new IntentEngine().define('greet', ['saluda a {nombre}'])
    expect(nlu.match('saluda a ANDRÉS')?.entities).toEqual({ nombre: 'andres' })
  })
})
