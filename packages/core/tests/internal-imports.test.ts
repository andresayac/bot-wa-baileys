/**
 * Guard: inside the monorepo, engine internals are imported from `@botmesh/core/internal`,
 * never through the deprecated main-entry re-exports (kept only for users until v3).
 * The names come from `internal.ts` itself, and the whole repo is scanned (packages,
 * examples, scripts, test utilities, READMEs and guides; see `isSkipped`) for named,
 * star re-export, namespace, dynamic and `require` imports of them. `packages/core/tests` is exempt: its
 * compatibility tests import the deprecated aliases on purpose (see internal-entry.test.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const coreSrc = resolve(here, '../src')

/** Every name re-exported by `source` (`export { a, type B } from '...'`). */
export function exportedNames(source: string): string[] {
  const names: string[] = []
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim()
      if (name) names.push(name)
    }
  }
  return names
}

/** Every name `internal.ts` exports, re-exported (deprecated) by the main entry. */
const DEPRECATED = exportedNames(readFileSync(join(coreSrc, 'internal.ts'), 'utf8'))

/**
 * Not scanned (AGENTS.md lists the same): `packages/core/tests` (its compatibility tests
 * import the deprecated aliases on purpose, see internal-entry.test.ts), every
 * `CHANGELOG.md` (release notes quote historical import lines), the historical design
 * notes (`docs/superpowers/`), and what is not the project's own source: dependencies
 * and generated output (`node_modules`, `lib`, `dist`, `coverage` at any depth; the
 * TypeDoc output `docs/api/` and the VitePress cache/temp), git and CI internals,
 * changesets, third-party reference repos (`terceros/`), local tool folders and the
 * WhatsApp session folders. Everything else in the repo is: every package's sources,
 * tests, test utilities, examples, scripts and README, the root `test-utils/` and
 * `scripts/`, the examples and the guides in both languages.
 */
/** Skipped wherever they appear (by folder or file name). */
const SKIP_NAMES = new Set(['node_modules', 'lib', 'dist', 'coverage', '.git', 'sessions', 'CHANGELOG.md'])
/** Skipped only at this exact repo-relative path (a `src/api/` folder is still scanned). */
const SKIP_PATHS = new Set([
  'packages/core/tests', 'docs/superpowers', 'docs/api', 'docs/.vitepress/cache', 'docs/.vitepress/.temp',
  '.github', '.changeset', 'terceros', '.claude', '.playwright-mcp',
])
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|md|txt)$/

/** True when the repo-relative path `rel` (`/`-separated) is left out of the scan. */
export function isSkipped(rel: string): boolean {
  const name = rel.split('/').pop()!
  return SKIP_NAMES.has(name) || name.endsWith('_sessions') || SKIP_PATHS.has(rel)
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (isSkipped(relative(repo, join(dir, name)).split(sep).join('/'))) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (EXTENSIONS.test(name)) out.push(path)
  }
  return out
}

/** Exactly the main entry, quoted (not a subpath such as `@botmesh/core/internal`). */
const MAIN = String.raw`['"]@botmesh/core['"]`

function namesIn(list: string): string[] {
  const names: string[] = []
  for (const part of list.split(',')) {
    // `type X`, `X as Y` (import) and `X: y` (destructuring) all name `X`.
    const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:/)[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
  }
  return names
}

/**
 * Stands for a star re-export of the main entry (`export * from '@botmesh/core'` or
 * `export * as ns from '@botmesh/core'`): it re-exports every deprecated internal too.
 */
export const STAR = '*'

/** True when a name reported by {@link mainEntryNames} reaches an internal through the main entry. */
export function isOffending(name: string): boolean {
  return name === STAR || DEPRECATED.includes(name)
}

/**
 * Names taken from exactly `'@botmesh/core'` (not a subpath) in `source`: named imports
 * and re-exports (also next to a default import), star re-exports ({@link STAR}),
 * namespace imports (`ns.X`), dynamic imports and `require` (destructured, bound to a
 * name, or `import('@botmesh/core').X` in a type position).
 */
export function mainEntryNames(source: string): string[] {
  const names: string[] = []
  const star = new RegExp(String.raw`export\s+(?:type\s+)?\*\s*(?:as\s+[\w$]+\s+)?from\s*` + MAIN, 'g')
  for (const _ of source.matchAll(star)) names.push(STAR)
  const named = new RegExp(String.raw`(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*` + MAIN, 'g')
  for (const m of source.matchAll(named)) names.push(...namesIn(m[1]))
  const call = String.raw`(?:await\s+)?(?:import|require)\s*\(\s*` + MAIN + String.raw`\s*\)`
  for (const m of source.matchAll(new RegExp(String.raw`\{([^}]*)\}\s*=\s*` + call, 'g'))) names.push(...namesIn(m[1]))
  const member = new RegExp(String.raw`(?:import|require)\s*\(\s*` + MAIN + String.raw`\s*\)\s*\.\s*([A-Za-z_$][\w$]*)`, 'g')
  for (const m of source.matchAll(member)) names.push(m[1])
  const namespaces = [
    ...source.matchAll(new RegExp(String.raw`import\s+(?:type\s+)?\*\s+as\s+([\w$]+)\s+from\s*` + MAIN, 'g')),
    ...source.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*` + call, 'g')),
  ].map((m) => m[1])
  for (const ns of namespaces) {
    const use = new RegExp(String.raw`(?<![\w$.])` + ns.replace(/\$/g, '\\$') + String.raw`\s*\.\s*([A-Za-z_$][\w$]*)`, 'g')
    for (const m of source.matchAll(use)) names.push(m[1])
  }
  return names
}

/** The subpaths `@botmesh/core` publishes (`exports` of its package.json). */
const CORE_SUBPATHS = new Set(
  Object.keys((JSON.parse(readFileSync(resolve(coreSrc, '../package.json'), 'utf8')) as { exports: Record<string, unknown> }).exports)
    .map((key) => (key === '.' ? '@botmesh/core' : `@botmesh/core/${key.slice(2)}`)),
)

/**
 * Module specifiers in `source` (a file in `dir`) that bypass the published entries of
 * `@botmesh/core`: an unexported `@botmesh/core/...` subpath, or a relative path into
 * `packages/core`.
 */
export function deepCoreImports(source: string, dir: string): string[] {
  const core = join(repo, 'packages', 'core')
  const out: string[] = []
  const specifiers = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm
  for (const m of source.matchAll(specifiers)) {
    const spec = m[1]
    if (spec.startsWith('@botmesh/core/') && !CORE_SUBPATHS.has(spec)) out.push(spec)
    else if (spec.startsWith('.')) {
      const target = resolve(dir, spec)
      if (target === core || target.startsWith(core + sep)) out.push(spec)
    }
  }
  return out
}

function scannedFiles(): string[] {
  return walk(repo)
}

describe('deprecated main-entry re-exports', () => {
  it('the matcher sees named, aliased, type and multi-line imports from the main entry only', () => {
    const src = [
      "import { Bot, MetricsCollector as M } from '@botmesh/core'",
      "import {\n  type ExternalSendClock,\n  flow,\n} from \"@botmesh/core\"",
      "import { createPacer } from '@botmesh/core/internal'",
      "export { runBroadcast } from '@botmesh/core'",
    ].join('\n')
    expect(mainEntryNames(src)).toEqual(['Bot', 'MetricsCollector', 'ExternalSendClock', 'flow', 'runBroadcast'])
  })

  it('the matcher also sees namespace, dynamic and require imports of the main entry', () => {
    const src = [
      "import * as core from '@botmesh/core'",
      'const pacer = core.createPacer()',
      "const { MemoryStore, typingDuration: td } = await import('@botmesh/core')",
      "let clock: import('@botmesh/core').ExternalSendClock",
      "const { runFormStep } = require('@botmesh/core')",
      "const bw = await import('@botmesh/core')",
      'bw.formatUptime(1)',
      "import * as internal from '@botmesh/core/internal'",
      'internal.newFormToken()',
      "const { resolveFormMode } = await import('@botmesh/core/internal')",
      "import Default, { buildMessageContext } from '@botmesh/core'",
    ].join('\n')
    expect(mainEntryNames(src).sort()).toEqual([
      'ExternalSendClock', 'MemoryStore', 'buildMessageContext', 'createPacer', 'formatUptime', 'runFormStep', 'typingDuration',
    ])
  })

  it('the matcher flags star re-exports of the main entry (they re-export every internal)', () => {
    const src = [
      "export * from '@botmesh/core'",
      'export type * from "@botmesh/core"',
      "export * as core from '@botmesh/core'",
      "export * from '@botmesh/core/internal'",
      "export * as internal from '@botmesh/core/internal'",
      "export * from '@botmesh/core/testing'",
    ].join('\n')
    expect(mainEntryNames(src)).toEqual([STAR, STAR, STAR])
    expect(isOffending(STAR)).toBe(true)
    expect(isOffending('Bot')).toBe(false)
  })

  it('skips exactly what the guard documents (AGENTS.md), anchored where it is generated', () => {
    for (const rel of [
      'node_modules', 'packages/ai/node_modules', 'packages/ai/lib', 'docs/dist', '.git', '.github', '.changeset',
      'terceros', 'sessions', 'packages/core/sessions', 'bot_sessions', '.claude', '.playwright-mcp',
      'docs/superpowers', 'docs/api', 'docs/.vitepress/cache', 'docs/.vitepress/.temp', 'packages/ai/coverage',
      'packages/core/tests', 'CHANGELOG.md', 'packages/ai/CHANGELOG.md',
    ]) expect(isSkipped(rel), rel).toBe(true)
    for (const rel of [
      'packages/manager/src/api', 'packages/ai/src/cache', 'packages/x/superpowers', 'docs/guide', 'docs/es/guide',
      'docs/.vitepress/theme', 'packages/core/src', 'test-utils', 'scripts',
    ]) expect(isSkipped(rel), rel).toBe(false)
  })

  it('takes the deprecated names from internal.ts', () => {
    expect(DEPRECATED).toEqual(expect.arrayContaining(['createPacer', 'MetricsCollector', 'TYPING_REFRESH_MS', 'newFormToken', 'buildMessageContext']))
    expect(DEPRECATED.length).toBeGreaterThanOrEqual(15)
  })

  it('scans every package, example, script, test utility, README and guide', () => {
    const files = scannedFiles().map((f) => relative(repo, f).split(sep).join('/'))
    for (const expected of [
      'packages/core/src/index.ts', 'packages/ai/tests/', 'packages/core/README.md', 'packages/baileys-provider/examples/',
      'test-utils/store-conformance.ts', 'scripts/pack-smoke.mjs', 'examples/', 'README.md',
      'docs/guide/', 'docs/es/guide/', 'docs/examples/', 'docs/es/ejemplos/', 'docs/public/', 'docs/MIGRATION-v1-to-v2.md',
    ]) {
      expect(files.some((f) => f === expected || (expected.endsWith('/') && f.startsWith(expected))), expected).toBe(true)
    }
    expect(files.some((f) => f.startsWith('packages/core/tests/'))).toBe(false)
    expect(files.some((f) => /(^|\/)(node_modules|lib|terceros)\//.test(f))).toBe(false)
  })

  it('are not imported from @botmesh/core anywhere in the monorepo (use @botmesh/core/internal)', () => {
    const offenders: string[] = []
    const files = scannedFiles()
    expect(files.length).toBeGreaterThan(100)
    for (const file of files) {
      const used = mainEntryNames(readFileSync(file, 'utf8')).filter(isOffending)
      if (used.length) offenders.push(`${relative(repo, file)}: ${used.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('the deep-import matcher flags unexported subpaths and paths into packages/core', () => {
    const src = [
      "import { createPacer } from '@botmesh/core/lib/core/messaging.js'",
      "import { x } from '../../core/src/core/context.js'",
      "const m = await import('@botmesh/core/src/ops/metrics.js')",
      "import { Bot } from '@botmesh/core'",
      "import { createPacer as p } from '@botmesh/core/internal'",
      "import { createTestBot } from '@botmesh/core/testing'",
      "import { defineBot } from '@botmesh/core/dev'",
      "import { y } from './core/helpers.js'",
    ].join('\n')
    expect(deepCoreImports(src, join(repo, 'packages', 'ai', 'src'))).toEqual([
      '@botmesh/core/lib/core/messaging.js', '../../core/src/core/context.js', '@botmesh/core/src/ops/metrics.js',
    ])
  })

  it('are reached only through the published subpaths, never by a deep import into packages/core', () => {
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      if (file.startsWith(join(repo, 'packages', 'core') + sep)) continue
      const deep = deepCoreImports(readFileSync(file, 'utf8'), dirname(file))
      if (deep.length) offenders.push(`${relative(repo, file)}: ${deep.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('stay re-exported (marked @deprecated) by the main entry for users', () => {
    const index = readFileSync(join(coreSrc, 'index.ts'), 'utf8')
    for (const name of DEPRECATED) {
      expect(index, name).toMatch(new RegExp(`@deprecated[^\\n]*\\n\\s*${name},`))
    }
    const internal = readFileSync(join(coreSrc, 'internal.ts'), 'utf8')
    for (const name of DEPRECATED) expect(internal, name).toContain(name)
  })
})
