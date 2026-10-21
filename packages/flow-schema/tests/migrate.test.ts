import { describe, expect, it } from 'vitest'
import { FLOW_DOCUMENT_VERSION, FlowMigrationError, migrateFlowDocument, validateFlowDocument } from '../src/index.js'

const v1 = () => ({ version: FLOW_DOCUMENT_VERSION, id: 'x', trigger: 'x', steps: [{ kind: 'say', text: 'x' }] })

describe('migrateFlowDocument', () => {
  it('stamps a pre-versioned document as v1', () => {
    const { version, ...old } = v1()
    const result = migrateFlowDocument(old)
    expect(result.from).toBe(0)
    expect(result.applied).toEqual([{ from: 0, to: 1 }])
    expect(result.document.version).toBe(1)
    expect(validateFlowDocument(result.document)).toEqual([])
  })

  it('leaves a current document untouched', () => {
    const result = migrateFlowDocument(v1())
    expect(result.from).toBe(FLOW_DOCUMENT_VERSION)
    expect(result.applied).toEqual([])
    expect(result.document).toEqual(v1())
  })

  it('rejects newer versions, invalid versions and missing migration paths', () => {
    expect(() => migrateFlowDocument({ ...v1(), version: 2 })).toThrow(/newer/)
    expect(() => migrateFlowDocument({ ...v1(), version: 1.5 })).toThrow(/non-negative integer/)
    expect(() => migrateFlowDocument({ ...v1(), version: -1 })).toThrow(/non-negative integer/)
    expect(() => migrateFlowDocument(null)).toThrow(/object/)
    expect(() => migrateFlowDocument({ ...v1(), version: 0 }, [])).toThrow(FlowMigrationError)
  })

  it('chains several migrations', () => {
    const result = migrateFlowDocument({ id: 'x' }, [
      { from: 0, to: 1, migrate: (doc) => ({ ...doc, version: 1, one: true }) },
      { from: 1, to: 2, migrate: (doc) => ({ ...doc, version: 2, two: true }) },
    ], 2)
    expect(result.applied).toEqual([{ from: 0, to: 1 }, { from: 1, to: 2 }])
    expect(result.document).toMatchObject({ version: 2, one: true, two: true })
  })
})
