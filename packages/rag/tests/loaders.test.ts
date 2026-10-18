import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPdfParser, fromJson, loadFile, loadPaths } from '../src/loaders.js'
import { RagError } from '../src/errors.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rag-load-'))
  await mkdir(join(dir, 'kb', 'sub'), { recursive: true })
  await mkdir(join(dir, 'kb', '.hidden'), { recursive: true })
  await writeFile(join(dir, 'kb', 'faq.md'), String.fromCharCode(0xfeff) + '---\ntitle: FAQ\n---\n# FAQ\n## Envíos\nTardan 3 días.')
  await writeFile(join(dir, 'kb', 'notas.txt'), 'Horario: 9 a 18.')
  await writeFile(join(dir, 'kb', 'sub', 'productos.json'), JSON.stringify([{ nombre: 'Café', precio: 10, tags: ['bebida', 'caliente'] }, { nombre: 'Té', meta: { origen: 'India' } }]))
  await writeFile(join(dir, 'kb', 'sub', 'manual.pdf'), Buffer.from('%PDF-fake'))
  await writeFile(join(dir, 'kb', 'imagen.png'), Buffer.from([1, 2, 3]))
  await writeFile(join(dir, 'kb', '.hidden', 'secreto.md'), 'no')
  await writeFile(join(dir, 'bad.json'), '{nope')
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

/** Smallest valid one-page PDF showing `text` in Helvetica. */
function minimalPdf(text: string): Buffer {
  const NL = '\n'
  const content = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    ['<< /Length ' + content.length + ' >>', 'stream', content, 'endstream'].join(NL),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4' + NL
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += [`${i + 1} 0 obj`, o, 'endobj', ''].join(NL)
  })
  const xref = out.length
  out += ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `), ''].join(NL)
  out += ['trailer', `<< /Size ${objs.length + 1} /Root 1 0 R >>`, 'startxref', String(xref), '%%EOF', ''].join(NL)
  return Buffer.from(out, 'latin1')
}

const fakePdf = async (data: Uint8Array) => `PDF de ${data.byteLength} bytes`

describe('loaders', () => {
  it('loads markdown (front matter and BOM stripped) with a cwd-relative posix source', async () => {
    const [doc] = await loadFile('kb/faq.md', { cwd: dir })
    expect(doc).toMatchObject({ id: 'kb/faq.md', source: 'kb/faq.md', format: 'markdown' })
    expect(doc!.text.startsWith('# FAQ')).toBe(true)
  })

  it('loads JSON arrays as one document per item, flattened', async () => {
    const docs = await loadFile(join(dir, 'kb', 'sub', 'productos.json'), { cwd: dir })
    expect(docs.map((d) => d.id)).toEqual(['kb/sub/productos.json#0', 'kb/sub/productos.json#1'])
    expect(docs[0]!.text).toBe('nombre: Café\nprecio: 10\ntags: bebida, caliente')
    expect(docs[1]!.text).toBe('nombre: Té\nmeta.origen: India')
    expect(fromJson({ a: 'x' }, 's')).toEqual([{ id: 's', source: 's', text: 'a: x', format: 'text' }])
    expect(fromJson('texto', 's')[0]!.text).toBe('texto')
  })

  it('loads PDFs through the injected parser', async () => {
    const [doc] = await loadFile('kb/sub/manual.pdf', { cwd: dir, pdf: fakePdf })
    expect(doc).toMatchObject({ source: 'kb/sub/manual.pdf', text: 'PDF de 9 bytes', format: 'text' })
  })

  it('extracts real PDF text with the optional pdf-parse peer (lazy import)', async () => {
    await writeFile(join(dir, 'real.pdf'), minimalPdf('Hola PDF de prueba'))
    const [doc] = await loadFile('real.pdf', { cwd: dir })
    expect(doc!.text).toContain('Hola PDF de prueba')
    // a corrupt file surfaces as LOAD_FAILED, not as a raw pdf.js exception
    await expect(loadFile('kb/sub/manual.pdf', { cwd: dir })).rejects.toMatchObject({ code: 'LOAD_FAILED' })
  })

  it('a missing pdf-parse peer is reported as MISSING_DEPENDENCY', async () => {
    const parser = createPdfParser(async () => { throw new Error('Cannot find package') })
    const err = await loadFile('kb/sub/manual.pdf', { cwd: dir, pdf: parser }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RagError)
    expect((err as RagError).code).toBe('MISSING_DEPENDENCY')
    const v1 = createPdfParser(async () => ({ default: async (d: Uint8Array) => ({ text: `v1:${d.byteLength}` }) }))
    expect(await v1(new Uint8Array(3))).toBe('v1:3')
    await expect(createPdfParser(async () => ({}))(new Uint8Array(1))).rejects.toMatchObject({ code: 'MISSING_DEPENDENCY' })
  })

  it('walks directories recursively (sorted, supported types only, dotfiles skipped)', async () => {
    const docs = await loadPaths(['kb'], { cwd: dir, pdf: fakePdf })
    expect(docs.map((d) => d.id)).toEqual(['kb/faq.md', 'kb/notas.txt', 'kb/sub/manual.pdf', 'kb/sub/productos.json#0', 'kb/sub/productos.json#1'])
  })

  it('rejects unsupported types, invalid JSON, missing files and oversized files', async () => {
    await expect(loadFile('kb/imagen.png', { cwd: dir })).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
    await expect(loadFile('bad.json', { cwd: dir })).rejects.toMatchObject({ code: 'LOAD_FAILED' })
    await expect(loadPaths(['nope.md'], { cwd: dir })).rejects.toMatchObject({ code: 'LOAD_FAILED' })
    await expect(loadFile('kb/notas.txt', { cwd: dir, maxFileBytes: 3 })).rejects.toMatchObject({ code: 'LOAD_FAILED' })
  })
})
