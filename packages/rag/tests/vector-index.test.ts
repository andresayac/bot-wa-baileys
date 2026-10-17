import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VectorIndex, cosine, type IndexEntry } from '../src/VectorIndex.js'
import { RagError } from '../src/errors.js'

const entry = (id: string, vector: number[], docId = 'd'): IndexEntry => ({ id, docId, source: `${docId}.md`, index: 0, text: id, hash: id, vector })

let dir: string | undefined
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined })

describe('VectorIndex', () => {
  it('cosine', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1)
    expect(cosine([1, 0], [0, 1])).toBe(0)
    expect(cosine([0, 0], [1, 0])).toBe(0)
    expect(() => cosine([1], [1, 2])).toThrow(RagError)
  })

  it('searches by cosine, honours topK, minScore and filter', () => {
    const idx = new VectorIndex('t')
    idx.upsert([entry('a', [1, 0]), entry('b', [0.7, 0.7], 'other'), entry('c', [0, 1])])
    expect(idx.search([1, 0], { topK: 2 }).map((h) => h.entry.id)).toEqual(['a', 'b'])
    expect(idx.search([1, 0], { minScore: 0.9 }).map((h) => h.entry.id)).toEqual(['a'])
    expect(idx.search([1, 0], { filter: (e) => e.docId === 'other' }).map((h) => h.entry.id)).toEqual(['b'])
    expect(idx.search([0, 0])).toEqual([])
    expect(() => idx.search([1, 0, 0])).toThrow(RagError)
  })

  it('upsert replaces by id, rejects mixed dimensions, removeWhere/clear', () => {
    const idx = new VectorIndex('t')
    idx.upsert([entry('a', [1, 0]), entry('a', [0, 1])])
    expect(idx.size).toBe(1)
    expect(idx.get('a')!.vector).toEqual([0, 1])
    expect(() => idx.upsert([entry('b', [1, 2, 3])])).toThrow(RagError)
    expect(idx.removeWhere((e) => e.id === 'a')).toBe(1)
    expect(idx.dimensions).toBeNull()
    idx.upsert([entry('z', [1, 2, 3])])
    idx.clear()
    expect(idx.size).toBe(0)
  })

  it('saves atomically and loads back; missing file → undefined; garbage → RagError', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rag-idx-'))
    const path = join(dir, 'nested', 'index.json')
    const idx = new VectorIndex('hash:2')
    idx.upsert([entry('a', [1, 0]), entry('b', [0, 1])])
    await idx.save(path)
    const loaded = await VectorIndex.load(path)
    expect(loaded!.embedder).toBe('hash:2')
    expect(loaded!.all()).toEqual(idx.all())
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1)
    expect(await VectorIndex.load(join(dir, 'nope.json'))).toBeUndefined()
    await writeFile(join(dir, 'bad.json'), '{oops')
    await expect(VectorIndex.load(join(dir, 'bad.json'))).rejects.toBeInstanceOf(RagError)
    expect(() => VectorIndex.fromJSON({ version: 2 })).toThrow(RagError)
  })
})
