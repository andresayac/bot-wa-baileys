import { describe, it, expect, expectTypeOf } from 'vitest'
import { aiPlugin, defineTool, MockAIProvider } from '../src/index.js'
import type { AIToolSet, SafeParseSchema } from '../src/index.js'

describe('tool typing', () => {
  it('defineTool infers handler args from a safeParse schema and fits an AIToolSet', () => {
    const schema: SafeParseSchema<{ q: string }> = { safeParse: (v) => ({ success: true, data: v as { q: string } }) }
    const buscar = defineTool({
      description: 'Busca',
      schema,
      confirmMessage: (a) => `¿Buscar ${a.q}?`,
      handler: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ q: string }>()
        return args.q
      },
    })
    const tools: AIToolSet = { buscar }
    // Annotated handler params in a plain object literal are accepted too.
    const plain: AIToolSet = { hora: { description: 'Hora', handler: (_args: { tz?: string }) => '12:00' } }
    expect(Object.keys({ ...tools, ...plain })).toEqual(['buscar', 'hora'])
    expect(typeof aiPlugin({ __provider: new MockAIProvider(), tools })).toBe('object')
  })
})
