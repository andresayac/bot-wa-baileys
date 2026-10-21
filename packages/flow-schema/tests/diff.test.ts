import { describe, expect, it } from 'vitest'
import { canonicalJson, diffFlowDocuments, flowDigest, flowVersionOf, sameFlow, type FlowDocument } from '../src/index.js'

const doc = (steps: FlowDocument['steps'], extra: Partial<FlowDocument> = {}): FlowDocument => ({ version: 1, id: 'x', trigger: 'hola', steps, ...extra })

describe('flow diff and digest', () => {
  it('reports no changes for structurally identical documents (key order ignored)', () => {
    const a = doc([{ kind: 'say', text: 'hola' }])
    const b = { steps: [{ text: 'hola', kind: 'say' }], trigger: 'hola', id: 'x', version: 1 } as FlowDocument
    expect(sameFlow(a, b)).toBe(true)
    expect(diffFlowDocuments(a, b)).toMatchObject({ changed: false, metadata: [], added: [], removed: [], changedSteps: [] })
    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })

  it('reports metadata, added, removed and nested changes with paths', () => {
    const before = doc([{ kind: 'say', text: 'hola' }, { kind: 'goto', target: 'a' }], { trigger: 'hola', timeout: '1m' })
    const after = doc([{ kind: 'say', text: 'adiós' }, { kind: 'goto', target: 'b' }, { kind: 'end' }], { trigger: ['hola', 'hi'], timeout: '2m' })
    const diff = diffFlowDocuments(before, after)
    expect(diff.changed).toBe(true)
    expect(diff.metadata).toEqual(['trigger', 'timeout'])
    expect(diff.added).toEqual([2])
    expect(diff.changedSteps.map((c) => c.index)).toEqual([0, 1])
    expect(diff.differences.map((d) => d.path)).toEqual(expect.arrayContaining(['/trigger', '/timeout', '/steps/0/text', '/steps/1/target', '/steps/2']))
  })

  it('produces a stable digest and version', () => {
    const a = doc([{ kind: 'say', text: 'hola' }])
    const b = doc([{ kind: 'say', text: 'adiós' }])
    expect(flowDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(flowDigest(a)).toBe(flowDigest({ ...a, steps: [{ text: 'hola', kind: 'say' }] } as FlowDocument))
    expect(flowDigest(a)).not.toBe(flowDigest(b))
    expect(flowVersionOf(a)).toMatch(/^flow-[0-9a-f]{16}$/)
  })
})
