import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRag, formatContext, Rag } from '../src/Rag.js'
import { HashEmbedder } from '../src/embeddings/hash.js'
import { RagError } from '../src/errors.js'
import type { Embedder, RagDocument } from '../src/types.js'

/** Wraps the hashing embedder and records every text it embeds. */
class CountingEmbedder implements Embedder {
  readonly id = 'count:hash'
  readonly seen: string[] = []
  private inner = new HashEmbedder({ dimensions: 256 })
  async embed(texts: readonly string[]): Promise<number[][]> {
    this.seen.push(...texts)
    return this.inner.embed(texts)
  }
}

const FAQ = `# Tienda
## Envíos
Los envíos a domicilio tardan 3 días hábiles en Bogotá.
## Pagos
Aceptamos tarjeta de crédito, PSE y efectivo contra entrega.
## Devoluciones
Puedes devolver un producto dentro de los 30 días.`

let dir: string | undefined
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined })

describe('Rag', () => {
  it('ingests documents lazily and retrieves the most relevant chunk with a citation', async () => {
    const rag = createRag({ documents: [{ id: 'faq', source: 'faq.md', text: FAQ, format: 'markdown' }], topK: 1 })
    expect(rag.size).toBe(0) // nothing happens at construction
    const [hit] = await rag.retrieve('¿cuánto tardan los envíos?')
    expect(hit).toMatchObject({ docId: 'faq', source: 'faq.md', section: 'Tienda › Envíos', citation: 'faq.md › Tienda › Envíos' })
    expect(hit!.text).toContain('3 días')
    expect(hit!.score).toBeGreaterThan(0)
    expect(hit).not.toHaveProperty('vector')
    expect(rag.size).toBe(3)
    const pay = await rag.retrieve('medios de pago tarjeta', { topK: 2 })
    expect(pay[0]!.section).toBe('Tienda › Pagos')
    expect(pay).toHaveLength(2)
  })

  it('loads files from disk relative to cwd', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rag-'))
    await writeFile(join(dir, 'faq.md'), FAQ)
    await writeFile(join(dir, 'horario.txt'), 'Atendemos de lunes a viernes de 9 a 18.')
    const rag = new Rag({ documents: ['faq.md', 'horario.txt'], cwd: dir })
    const [hit] = await rag.retrieve('horario de atención lunes')
    expect(hit!.citation).toBe('horario.txt')
  })

  it('blank queries and empty indexes return []', async () => {
    const rag = createRag()
    expect(await rag.retrieve('hola')).toEqual([])
    await rag.addText('hola mundo', { source: 'a' })
    expect(await rag.retrieve('   ')).toEqual([])
  })

  it('addText / addDocuments replace by id, removeDocument removes, filter narrows', async () => {
    const rag = createRag({ embeddings: { provider: 'local', dimensions: 128 } })
    await rag.addText('El café cuesta 10 mil pesos.', { source: 'precios', metadata: { lang: 'es' } })
    await rag.addText('El té cuesta 8 mil pesos.', { source: 'te' })
    expect(rag.size).toBe(2)
    await rag.addText('El café cuesta 12 mil pesos.', { source: 'precios' })
    expect(rag.size).toBe(2)
    const [hit] = await rag.retrieve('precio del café', { topK: 1 })
    expect(hit!.text).toContain('12 mil')
    const onlyTea = await rag.retrieve('precio del café', { filter: (c) => c.docId === 'te' })
    expect(onlyTea.map((c) => c.docId)).toEqual(['te'])
    expect(await rag.removeDocument('precios')).toBe(true)
    expect(await rag.removeDocument('precios')).toBe(false)
    expect(rag.size).toBe(1)
  })

  it('minScore filters weak matches', async () => {
    const rag = createRag({ documents: [{ id: 'a', source: 'a', text: 'gatos y perros' }], minScore: 0.99 })
    expect(await rag.retrieve('aviones')).toEqual([])
  })

  it('persists the index and only re-embeds changed chunks on restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rag-'))
    const persistPath = join(dir, 'idx', 'index.json')
    const docs: RagDocument[] = [{ id: 'faq', source: 'faq.md', text: FAQ, format: 'markdown' }]
    const e1 = new CountingEmbedder()
    await new Rag({ documents: docs, embeddings: e1, persistPath }).ready()
    expect(e1.seen).toHaveLength(3)
    const saved = JSON.parse(await readFile(persistPath, 'utf8'))
    expect(saved.embedder).toBe('count:hash')
    expect(saved.entries).toHaveLength(3)

    // same corpus → zero embedding calls
    const e2 = new CountingEmbedder()
    const rag2 = new Rag({ documents: docs, embeddings: e2, persistPath })
    await rag2.ready()
    expect(e2.seen).toEqual([])
    expect(rag2.size).toBe(3)

    // one section edited → only that chunk is embedded
    const edited = FAQ.replace('30 días', '60 días')
    const e3 = new CountingEmbedder()
    await new Rag({ documents: [{ ...docs[0]!, text: edited }], embeddings: e3, persistPath }).ready()
    expect(e3.seen).toHaveLength(1)
    expect(e3.seen[0]).toContain('60 días')

    // no documents configured → the persisted index is served as-is
    const e4 = new CountingEmbedder()
    const prebuilt = new Rag({ embeddings: e4, persistPath })
    const [hit] = await prebuilt.retrieve('devolver producto')
    expect(hit!.text).toContain('60 días')
    expect(e4.seen).toEqual(['devolver producto'])
  })

  it('discards a persisted index built with another embedder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rag-'))
    const persistPath = join(dir, 'index.json')
    const docs: RagDocument[] = [{ id: 'a', source: 'a', text: 'uno dos tres' }]
    await new Rag({ documents: docs, embeddings: { provider: 'local', dimensions: 64 }, persistPath }).ready()
    const e = new CountingEmbedder()
    await new Rag({ documents: docs, embeddings: e, persistPath }).ready()
    expect(e.seen).toEqual(['uno dos tres'])
    expect(JSON.parse(await readFile(persistPath, 'utf8')).embedder).toBe('count:hash')
  })

  it('save() writes to an explicit path; without one it throws', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rag-'))
    const rag = createRag({ documents: [{ id: 'a', source: 'a', text: 'hola' }] })
    await rag.save(join(dir, 'x.json'))
    expect(JSON.parse(await readFile(join(dir, 'x.json'), 'utf8')).entries).toHaveLength(1)
    await expect(rag.save()).rejects.toBeInstanceOf(RagError)
  })

  it('a failed ingest is retried on the next call', async () => {
    let fail = true
    const flaky: Embedder = {
      id: 'flaky',
      embed: async (texts) => {
        if (fail) throw new Error('down')
        return new HashEmbedder({ dimensions: 32 }).embed(texts)
      },
    }
    const rag = createRag({ documents: [{ id: 'a', source: 'a', text: 'hola mundo' }], embeddings: flaky })
    await expect(rag.warmup()).rejects.toThrow('down')
    fail = false
    expect(await rag.retrieve('hola')).toHaveLength(1)
  })

  it('validates options and documents', async () => {
    expect(() => createRag({ topK: 0 })).toThrow(RagError)
    expect(() => createRag({ chunkSize: 10, chunkOverlap: 20 })).toThrow(RagError)
    const rag = createRag({ documents: [{ id: 1 } as unknown as RagDocument] })
    await expect(rag.ready()).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })
  })

  it('formatContext numbers chunks with their citation', () => {
    expect(formatContext([{ text: 'A', citation: 'x.md' }, { text: 'B', citation: 'y.md › S' }])).toBe('[1] (x.md)\nA\n\n[2] (y.md › S)\nB')
  })
})
