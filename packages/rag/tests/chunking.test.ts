import { describe, it, expect } from 'vitest'
import { chunkText, chunkDocument, splitMarkdownSections } from '../src/chunking.js'
import { RagError } from '../src/errors.js'

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('Hola mundo.', { chunkSize: 100 })).toEqual(['Hola mundo.'])
  })

  it('returns nothing for blank text', () => {
    expect(chunkText('  \n\n  ', { chunkSize: 100 })).toEqual([])
  })

  it('packs paragraphs up to chunkSize', () => {
    const text = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].join('\n\n')
    const chunks = chunkText(text, { chunkSize: 90, chunkOverlap: 0 })
    expect(chunks).toEqual([`${'a'.repeat(40)}\n\n${'b'.repeat(40)}`, 'c'.repeat(40)])
  })

  it('splits long paragraphs by sentence and long words by characters', () => {
    const text = 'Primera frase corta. Segunda frase también corta. Tercera frase final.'
    const chunks = chunkText(text, { chunkSize: 30, chunkOverlap: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30)
    const word = 'x'.repeat(75)
    const hard = chunkText(word, { chunkSize: 30, chunkOverlap: 0 })
    expect(hard.join('')).toBe(word)
    for (const c of hard) expect(c.length).toBeLessThanOrEqual(30)
  })

  it('carries an overlap from the previous chunk at a word boundary', () => {
    const text = 'uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce'
    const chunks = chunkText(text, { chunkSize: 30, chunkOverlap: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 1; i < chunks.length; i++) {
      const firstWord = chunks[i]!.split(/\s+/)[0]!
      expect(chunks[i - 1]).toContain(firstWord)
    }
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(41)
  })

  it('rejects invalid sizes', () => {
    expect(() => chunkText('x', { chunkSize: 0 })).toThrow(RagError)
    expect(() => chunkText('x', { chunkSize: 10, chunkOverlap: 10 })).toThrow(RagError)
    expect(() => chunkText('x', { chunkSize: 10, chunkOverlap: -1 })).toThrow(RagError)
  })
})

describe('markdown sections', () => {
  it('splits by headings and keeps the heading path', () => {
    const md = '# Tienda\nIntro.\n## Envíos\nTardan 3 días.\n### Internacional\nTardan 10 días.\n## Pagos\nTarjeta.'
    const sections = splitMarkdownSections(md)
    expect(sections.map((s) => s.path)).toEqual(['Tienda', 'Tienda › Envíos', 'Tienda › Envíos › Internacional', 'Tienda › Pagos'])
    expect(sections[1]!.body).toBe('Tardan 3 días.')
  })

  it('ignores # inside fenced code blocks', () => {
    const md = '## Código\n```sh\n# comentario\necho hola\n```'
    const sections = splitMarkdownSections(md)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.body).toContain('# comentario')
  })

  it('chunkDocument tags markdown chunks with their section and prefixes the heading', () => {
    const chunks = chunkDocument(
      { id: 'faq', source: 'faq.md', format: 'markdown', text: '# FAQ\n## Envíos\nTardan 3 días.\n## Pagos\nAceptamos tarjeta.', metadata: { lang: 'es' } },
      { chunkSize: 200 },
    )
    expect(chunks.map((c) => [c.id, c.section])).toEqual([['faq#0', 'FAQ › Envíos'], ['faq#1', 'FAQ › Pagos']])
    expect(chunks[0]!.text).toBe('FAQ › Envíos\n\nTardan 3 días.')
    expect(chunks[0]!.metadata).toEqual({ lang: 'es' })
    expect(chunks[1]!.index).toBe(1)
  })

  it('chunkDocument on plain text has no section', () => {
    const [c] = chunkDocument({ id: 'a', source: 'a.txt', text: 'hola' }, {})
    expect(c).toMatchObject({ id: 'a#0', docId: 'a', source: 'a.txt', index: 0, text: 'hola' })
    expect(c!.section).toBeUndefined()
  })
})
