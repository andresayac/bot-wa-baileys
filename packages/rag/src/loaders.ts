/**
 * Document loaders: markdown, plain text, JSON and (through the optional
 * `pdf-parse` peer, loaded lazily) PDF. Directories are walked recursively
 * for the supported extensions.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { RagError } from './errors.js'
import type { RagDocument, RagMetadata } from './types.js'

/** Extracts the text of a PDF buffer. */
export type PdfParser = (data: Uint8Array) => Promise<string>

export interface LoadOptions {
  /** Base directory for relative paths and for the `source` label. Default `process.cwd()`. */
  cwd?: string
  /** Custom PDF parser (default: the optional `pdf-parse` package, loaded on demand). */
  pdf?: PdfParser
  /** Max bytes per file. Default 20 MiB. */
  maxFileBytes?: number
}

const TEXT_EXT = new Set(['.txt', '.text'])
const MD_EXT = new Set(['.md', '.markdown', '.mdx'])
const JSON_EXT = new Set(['.json'])
const PDF_EXT = new Set(['.pdf'])
/** Extensions picked up when a directory is given. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [...TEXT_EXT, ...MD_EXT, ...JSON_EXT, ...PDF_EXT]

const toPosix = (p: string): string => p.split('\\').join('/')

/** A markdown string as a document. */
export function fromMarkdown(text: string, source: string, metadata?: RagMetadata): RagDocument {
  return withMeta({ id: source, source, text, format: 'markdown' }, metadata)
}

/** A plain-text string as a document. */
export function fromText(text: string, source: string, metadata?: RagMetadata): RagDocument {
  return withMeta({ id: source, source, text, format: 'text' }, metadata)
}

function withMeta(doc: RagDocument, metadata?: RagMetadata): RagDocument {
  if (metadata) doc.metadata = { ...metadata }
  return doc
}

/** Flatten a JSON value into `key.path: value` lines. */
function flatten(value: unknown, prefix: string, out: string[]): void {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) {
      const items = value.filter((v) => v !== null && v !== undefined).map(String)
      if (items.length) out.push(prefix ? `${prefix}: ${items.join(', ')}` : items.join(', '))
      return
    }
    value.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out))
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
    return
  }
  out.push(prefix ? `${prefix}: ${String(value)}` : String(value))
}

/**
 * JSON data as documents: a top-level array yields one document per item
 * (`source#0`, `source#1`...), anything else a single document. Objects are
 * flattened to `key.path: value` lines, which read well to both embedders
 * and LLMs.
 */
export function fromJson(data: unknown, source: string, metadata?: RagMetadata): RagDocument[] {
  const render = (v: unknown): string => {
    if (typeof v === 'string') return v
    const lines: string[] = []
    flatten(v, '', lines)
    return lines.join('\n')
  }
  if (Array.isArray(data)) {
    return data
      .map((item, i) => withMeta({ id: `${source}#${i}`, source: `${source}#${i}`, text: render(item), format: 'text' }, metadata))
      .filter((d) => d.text.trim().length > 0)
  }
  const text = render(data)
  return text.trim() ? [withMeta({ id: source, source, text, format: 'text' }, metadata)] : []
}

interface PdfParseV1 { default?: (data: Uint8Array) => Promise<{ text?: string }> }
interface PdfParseV2 {
  PDFParse?: new (o: { data: Uint8Array }) => { getText(): Promise<{ text?: string }>; destroy?(): Promise<void> }
}

/**
 * PDF parser backed by the optional `pdf-parse` peer (v1 or v2 API), imported
 * on first use through `importer` (overridable for tests).
 */
export function createPdfParser(importer: (name: string) => Promise<unknown> = (name) => import(/* @vite-ignore */ name)): PdfParser {
  return async (data) => {
    let mod: PdfParseV1 & PdfParseV2
    try {
      mod = (await importer('pdf-parse')) as PdfParseV1 & PdfParseV2
    } catch (cause) {
      throw new RagError('MISSING_DEPENDENCY', 'Loading PDFs requires the optional "pdf-parse" package: pnpm add pdf-parse', { cause })
    }
    if (typeof mod.PDFParse === 'function') {
      const parser = new mod.PDFParse({ data })
      try {
        return (await parser.getText()).text ?? ''
      } finally {
        await parser.destroy?.()
      }
    }
    if (typeof mod.default === 'function') return (await mod.default(data)).text ?? ''
    throw new RagError('MISSING_DEPENDENCY', 'Unsupported "pdf-parse" version (expected v1 or v2 API)')
  }
}

/** Default PDF parser: the optional `pdf-parse` peer, imported on first use. */
export const defaultPdfParser: PdfParser = createPdfParser()

/** Load one file (by extension) into documents. */
export async function loadFile(path: string, options: LoadOptions = {}): Promise<RagDocument[]> {
  const cwd = options.cwd ?? process.cwd()
  const abs = resolve(cwd, path)
  const source = toPosix(relative(cwd, abs) || path)
  const ext = extname(abs).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new RagError('UNSUPPORTED_FORMAT', `unsupported document type "${ext || '(none)'}": ${source}`)
  }
  let buf: Buffer
  try {
    const info = await stat(abs)
    const max = options.maxFileBytes ?? 20 * 1024 * 1024
    if (info.size > max) throw new RagError('LOAD_FAILED', `${source} exceeds ${max} bytes`)
    buf = await readFile(abs)
  } catch (cause) {
    if (cause instanceof RagError) throw cause
    throw new RagError('LOAD_FAILED', `cannot read ${source}`, { cause })
  }
  if (PDF_EXT.has(ext)) {
    let text: string
    try {
      text = await (options.pdf ?? defaultPdfParser)(new Uint8Array(buf))
    } catch (cause) {
      if (cause instanceof RagError) throw cause
      throw new RagError('LOAD_FAILED', `cannot parse PDF ${source}`, { cause })
    }
    return text.trim() ? [{ id: source, source, text, format: 'text' }] : []
  }
  const text = buf.toString('utf8').replace(/^\uFEFF/, '')
  if (MD_EXT.has(ext)) return text.trim() ? [fromMarkdown(stripFrontMatter(text), source)] : []
  if (JSON_EXT.has(ext)) {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (cause) {
      throw new RagError('LOAD_FAILED', `${source} is not valid JSON`, { cause })
    }
    return fromJson(data, source)
  }
  return text.trim() ? [fromText(text, source)] : []
}

function stripFrontMatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
}

/** Load files and/or directories (recursively, supported extensions only, sorted). */
export async function loadPaths(paths: readonly string[], options: LoadOptions = {}): Promise<RagDocument[]> {
  const cwd = options.cwd ?? process.cwd()
  const docs: RagDocument[] = []
  for (const p of paths) {
    const abs = resolve(cwd, p)
    let isDir = false
    try {
      isDir = (await stat(abs)).isDirectory()
    } catch (cause) {
      throw new RagError('LOAD_FAILED', `cannot read ${p}`, { cause })
    }
    if (!isDir) { docs.push(...(await loadFile(abs, { ...options, cwd }))); continue }
    for (const file of await walk(abs)) docs.push(...(await loadFile(file, { ...options, cwd })))
  }
  return docs
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (e.isFile() && SUPPORTED_EXTENSIONS.includes(extname(e.name).toLowerCase())) out.push(full)
  }
  return out
}
