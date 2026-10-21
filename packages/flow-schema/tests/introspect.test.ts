import { describe, expect, it } from 'vitest'
import { flow } from '@botmesh/core'
import { FlowExportError, compileFlowDocument, exportFlowDocument, type FlowDocument } from '../src/index.js'

const fullDocument = (): FlowDocument => ({
  version: 1,
  id: 'full',
  trigger: { keywords: ['hola', 'buenas'], match: 'contains', scope: 'all' },
  timeout: '5m',
  persistent: true,
  steps: [
    { kind: 'say', text: 'Hola {{$sender}}' },
    { kind: 'ask', text: '¿Nombre?', stateKey: 'name', retries: 2 },
    { kind: 'choose', text: 'Elige', stateKey: 'pick', options: [{ key: 'a', label: 'A', steps: [{ kind: 'say', text: 'A' }] }] },
    { kind: 'condition', if: 'name == "Ana"', then: [{ kind: 'say', text: 'Ana' }], else: [{ kind: 'end', text: 'Adiós' }] },
    { kind: 'delay', duration: '500ms' },
    { kind: 'goto', target: 'other' },
    { kind: 'end' },
    { kind: 'media', type: 'image', source: { url: 'https://example.com/a.png' }, caption: 'Foto' },
    { kind: 'form', form: { id: 'checkout', fields: [{ name: 'qty', label: 'Cantidad', type: 'number', min: 1, max: 9 }] }, flatten: true },
    { kind: 'guard', if: 'age >= 18', redirect: 'adult', message: 'Solo adultos' },
    { kind: 'subflow', flowId: 'child' },
    { kind: 'http', method: 'GET', url: 'https://api.example.com/x', stateKey: 'data' },
    { kind: 'handoff', reason: 'billing', message: 'Te paso' },
    { kind: 'ai', prompt: 'Resume', tools: ['lookup'], stateKey: 'summary' },
  ],
})

describe('exportFlowDocument', () => {
  it('round-trips a document compiled by the package', () => {
    const child: FlowDocument = { version: 1, id: 'child', trigger: 'child', steps: [{ kind: 'say', text: 'hijo' }] }
    const original = fullDocument()
    const flow = compileFlowDocument(original, { resolveSubflow: () => child })
    const exported = exportFlowDocument(flow)
    expect(exported).toEqual(original)
  })

  it('exports the declarative steps of a DSL flow', () => {
    const compiled = flow('hola').say('Hola').goto('other').compile()
    const exported = exportFlowDocument(compiled)
    expect(exported).toMatchObject({
      version: 1,
      id: compiled.id,
      trigger: compiled.trigger,
      steps: [{ kind: 'say', text: 'Hola' }, { kind: 'goto', target: 'other' }],
    })
  })

  it('reports opaque steps instead of dropping them', () => {
    const compiled = flow('hola').do(async () => {}).compile()
    expect(() => exportFlowDocument(compiled)).toThrow(FlowExportError)
    try {
      exportFlowDocument(compiled)
    } catch (error) {
      expect((error as FlowExportError).issues[0]).toMatchObject({ path: '/steps/0' })
    }
  })
})
