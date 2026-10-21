import { describe, expect, it } from 'vitest'
import {
  FLOW_DOCUMENT_LIMITS,
  FLOW_DOCUMENT_SCHEMA,
  FLOW_DOCUMENT_VERSION,
  FLOW_DOCUMENT_SCHEMA_ID,
  isFlowDocument,
  toMs,
  validateFlowDocument,
} from '../src/index.js'

const base = () => ({
  version: FLOW_DOCUMENT_VERSION,
  id: 'encuesta',
  trigger: 'encuesta',
  steps: [{ kind: 'say', text: 'Hola' }],
})

const issuesOf = (patch: (doc: Record<string, any>) => void): Array<{ path: string; message: string }> => {
  const doc = base() as Record<string, any>
  patch(doc)
  return validateFlowDocument(doc)
}

describe('flow document validation', () => {
  it('accepts a minimal document and the JSON Schema is published', () => {
    expect(validateFlowDocument(base())).toEqual([])
    expect(isFlowDocument(base())).toBe(true)
    expect(FLOW_DOCUMENT_SCHEMA.$schema).toContain('2020-12')
    expect(FLOW_DOCUMENT_SCHEMA.$id).toBe(FLOW_DOCUMENT_SCHEMA_ID)
    expect(FLOW_DOCUMENT_SCHEMA.$defs.media).toBeDefined()
    expect(FLOW_DOCUMENT_SCHEMA.$defs.form).toBeDefined()
    expect(FLOW_DOCUMENT_SCHEMA.$defs.http).toBeDefined()
  })

  it('rejects non-objects, unknown properties and a wrong version', () => {
    expect(validateFlowDocument(null)).toEqual([{ path: '', message: 'must be an object' }])
    expect(issuesOf((doc) => { doc.extra = true }).map((i) => i.path)).toContain('/extra')
    expect(issuesOf((doc) => { doc.version = 2 })[0]).toEqual({ path: '/version', message: 'must be 1' })
    expect(issuesOf((doc) => { doc.id = 'bad id' })[0]?.message).toMatch(/must match/)
    expect(issuesOf((doc) => { doc.steps = [] })[0]).toEqual({ path: '/steps', message: 'must be a non-empty array' })
  })

  it('validates triggers and durations', () => {
    expect(validateFlowDocument({ ...base(), trigger: ['a', 'b'] })).toEqual([])
    expect(validateFlowDocument({ ...base(), trigger: { keywords: ['a'], match: 'contains', scope: 'group' } })).toEqual([])
    expect(issuesOf((doc) => { doc.trigger = { keywords: [] } })[0]?.path).toBe('/trigger/keywords')
    expect(issuesOf((doc) => { doc.trigger = { keywords: ['a'], match: 'fuzzy' } })[0]?.path).toBe('/trigger/match')
    expect(issuesOf((doc) => { doc.timeout = '2d' })[0]?.path).toBe('/timeout')
    expect(toMs('1h')).toBe(3_600_000)
    expect(() => toMs('1d')).toThrow()
  })

  it('enforces the structural limits', () => {
    const many = Array.from({ length: FLOW_DOCUMENT_LIMITS.maxSteps + 1 }, () => ({ kind: 'say', text: 'x' }))
    expect(issuesOf((doc) => { doc.steps = many }).some((i) => /more than/.test(i.message))).toBe(true)
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'say', text: 'x'.repeat(FLOW_DOCUMENT_LIMITS.maxTextLength + 1) }] })[0]?.path).toBe('/steps/0/text')
    // Nested deeper than the limit.
    let nested: any = { kind: 'say', text: 'x' }
    for (let i = 0; i < FLOW_DOCUMENT_LIMITS.maxDepth + 1; i++) nested = { kind: 'condition', if: 'true', then: [nested] }
    expect(issuesOf((doc) => { doc.steps = [nested] }).some((i) => /nested deeper/.test(i.message))).toBe(true)
  })

  it('validates media steps (URL or state source, location coordinates)', () => {
    expect(validateFlowDocument({ ...base(), steps: [{ kind: 'media', type: 'image', source: { url: 'https://example.com/a.png' }, caption: 'Hola' }] })).toEqual([])
    expect(validateFlowDocument({ ...base(), steps: [{ kind: 'media', type: 'document', source: { stateKey: 'file' } }] })).toEqual([])
    expect(validateFlowDocument({ ...base(), steps: [{ kind: 'media', type: 'location', source: { latitude: 3.4, longitude: -76.5, name: 'Sede' } }] })).toEqual([])
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'media', type: 'image', source: {} }] })[0]?.message).toMatch(/url or a stateKey/)
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'media', type: 'image', source: { url: 'ftp://x' } }] })[0]?.message).toMatch(/http/)
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'media', type: 'location', source: { latitude: 100, longitude: 0 } }] })[0]?.path).toMatch(/latitude/)
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'media', type: 'image', source: { url: 'https://x', extra: 1 } }] })[0]?.path).toMatch(/source\/extra/)
  })

  it('validates forms: fields, options, patterns and duplicates', () => {
    const form = (fields: unknown[]) => ({ kind: 'form', form: { id: 'checkout', fields } })
    const text = { name: 'name', label: 'Nombre', type: 'text', required: true, minLength: 1, maxLength: 40 }
    expect(validateFlowDocument({ ...base(), steps: [form([text])] })).toEqual([])
    expect(validateFlowDocument({ ...base(), steps: [form([{ ...text, type: 'select', options: ['a', 'b'] }])] })).toEqual([])
    expect(validateFlowDocument({ ...base(), steps: [form([{ ...text, type: 'multiselect', options: { a: 'A' } }])] })).toEqual([])
    expect(issuesOf((doc) => { doc.steps = [form([text, text])] }).some((i) => /duplicate field/.test(i.message))).toBe(true)
    expect(issuesOf((doc) => { doc.steps = [form([{ ...text, type: 'select' }])] })[0]?.path).toMatch(/options/)
    expect(issuesOf((doc) => { doc.steps = [form([{ ...text, pattern: '[' }])] })[0]?.path).toMatch(/pattern/)
    expect(issuesOf((doc) => { doc.steps = [form([])] })[0]?.path).toMatch(/fields/)
  })

  it('validates guard, subflow, http, handoff and ai steps', () => {
    expect(validateFlowDocument({ ...base(), steps: [{ kind: 'guard', if: 'age >= 18', redirect: 'adult' }] })).toEqual([])
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'guard', if: 'true' }] })[0]?.message).toMatch(/message, a redirect/)
    expect(validateFlowDocument({ ...base(), steps: [{ kind: 'subflow', flowId: 'other' }] })).toEqual([])
    expect(validateFlowDocument({ ...base(), steps: [{ kind: 'http', method: 'POST', url: 'https://api.example.com/x', headers: { Authorization: 'Bearer {token}' }, body: { a: 1 }, stateKey: 'result' }] })).toEqual([])
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'http', method: 'TRACE', url: 'https://x' }] })[0]?.path).toMatch(/method/)
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'http', method: 'GET', url: 'https://x', headers: { Host: 'evil' } }] })[0]?.path).toMatch(/headers\/Host/)
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'http', method: 'POST', url: 'https://x', body: { x: 'x'.repeat(FLOW_DOCUMENT_LIMITS.maxHttpBodyBytes) } }] })[0]?.message).toMatch(/bytes/)
    expect(validateFlowDocument({ ...base(), steps: [{ kind: 'handoff', reason: 'billing', message: 'Te paso con un agente' }] })).toEqual([])
    expect(validateFlowDocument({ ...base(), steps: [{ kind: 'ai', prompt: 'Resume', tools: ['lookup'], stateKey: 'summary' }] })).toEqual([])
    expect(issuesOf((doc) => { doc.steps = [{ kind: 'ai', prompt: 'x', tools: [] }] })[0]?.path).toMatch(/tools/)
  })

  it('reports every issue (bounded) with JSON-pointer paths', () => {
    const issues = issuesOf((doc) => {
      doc.steps = [
        { kind: 'ask', text: '', stateKey: 'bad key' },
        { kind: 'goto', target: '' },
        { kind: 'condition', if: 'a +', then: [] },
      ]
    })
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['/steps/0/text', '/steps/0/stateKey', '/steps/1/target', '/steps/2/if']))
  })
})
