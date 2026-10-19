/**
 * Guard: inside the monorepo, engine internals are imported from `@bot-wa/core/internal`,
 * never through the deprecated main-entry re-exports (kept only for users until v3).
 * `packages/core/tests` is exempt: its compatibility tests import the deprecated aliases
 * on purpose (see internal-entry.test.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const coreSrc = resolve(here, '../src')

/** Every name `internal.ts` exports, re-exported (deprecated) by the main entry. */
const DEPRECATED = [
  'buildMessageContext', 'createControls', 'createPacer', 'runBroadcast', 'runFormStep', 'newFormToken',
  'resolveFormMode', 'resolveReplyTyping', 'normalizeTypingConfig', 'typingDuration', 'parseReplyDelay',
  'ExternalSendClock', 'MetricsCollector', 'formatUptime', 'TYPING_REFRESH_MS',
]

const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', '.git', 'cache', 'api', 'superpowers', '.vitepress'])
const EXTENSIONS = /\.(ts|tsx|mts|js|mjs|cjs|md|txt)$/

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (EXTENSIONS.test(name)) out.push(path)
  }
  return out
}

/** Names imported/re-exported from exactly `'@bot-wa/core'` (not a subpath) in `source`. */
export function mainEntryNames(source: string): string[] {
  const names: string[] = []
  const re = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@bot-wa\/core['"]/g
  for (const m of source.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (name) names.push(name)
    }
  }
  return names
}

function scannedFiles(): string[] {
  const roots = [
    join(repo, 'examples'),
    join(repo, 'docs/guide'),
    join(repo, 'docs/examples'),
    join(repo, 'docs/es/guide'),
    join(repo, 'docs/es/ejemplos'),
    join(repo, 'docs/public'),
  ]
  for (const pkg of readdirSync(join(repo, 'packages'))) {
    roots.push(join(repo, 'packages', pkg, 'src'))
    if (pkg !== 'core') roots.push(join(repo, 'packages', pkg, 'tests'))
  }
  return roots.flatMap((r) => walk(r))
}

describe('deprecated main-entry re-exports', () => {
  it('the matcher sees named, aliased, type and multi-line imports from the main entry only', () => {
    const src = [
      "import { Bot, MetricsCollector as M } from '@bot-wa/core'",
      "import {\n  type ExternalSendClock,\n  flow,\n} from \"@bot-wa/core\"",
      "import { createPacer } from '@bot-wa/core/internal'",
      "export { runBroadcast } from '@bot-wa/core'",
    ].join('\n')
    expect(mainEntryNames(src)).toEqual(['Bot', 'MetricsCollector', 'ExternalSendClock', 'flow', 'runBroadcast'])
  })

  it('are not imported from @bot-wa/core anywhere in the monorepo (use @bot-wa/core/internal)', () => {
    const offenders: string[] = []
    const files = scannedFiles()
    expect(files.length).toBeGreaterThan(100)
    for (const file of files) {
      const used = mainEntryNames(readFileSync(file, 'utf8')).filter((n) => DEPRECATED.includes(n))
      if (used.length) offenders.push(`${relative(repo, file)}: ${used.join(', ')}`)
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
