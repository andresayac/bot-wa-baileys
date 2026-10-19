/**
 * Structure guard for the core: every `core/bot/*` module stays small (< 500 lines), and
 * every module under `src/` opens with a header comment saying what it is responsible
 * for (after an optional shebang). A header is a leading doc comment that stands on its
 * own — followed by a blank line or by an `import`/re-export — so the TSDoc of the
 * file's first declaration does not count as one. `Bot.ts` is the documented exception to the size limit: it is
 * the public facade and carries the public TSDoc (splitting it would change the
 * published `.d.ts`), but it must hold no logic of its own and no `#private` fields
 * (plugin-scoped bots are `Object.create(bot)`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const MAX_LINES = 500

const read = (rel: string) => readFileSync(join(src, rel), 'utf8')
const lineCount = (text: string) => text.split('\n').length

function listModules(dir: string, prefix = ''): string[] {
  return readdirSync(join(src, dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return listModules(dir, rel)
    return entry.name.endsWith('.ts') ? [dir ? `${dir}/${rel}` : rel] : []
  })
}

/** True when `text` opens (after an optional shebang) with a standalone module header. */
export function hasModuleHeader(text: string): boolean {
  const body = text.replace(/^#![^\n]*\n/, '')
  const header = /^\/\*\*[\s\S]*?\*\/[ \t]*\r?\n/.exec(body)
  if (!header) return false
  const next = body.slice(header[0].length)
  return /^(\r?\n|import[\s{*'"]|export\s+(type\s+)?(\{|\*)|$)/.test(next)
}

/** Every module of the package. */
const ALL_MODULES = listModules('')

const botModules = readdirSync(join(src, 'core/bot')).filter((f) => f.endsWith('.ts')).map((f) => `core/bot/${f}`)

describe('core structure', () => {
  it.each(botModules)('%s is under 500 lines', (rel) => {
    const text = read(rel)
    expect(lineCount(text)).toBeLessThan(MAX_LINES)
  })

  it('the header matcher accepts module headers and rejects declaration docs', () => {
    expect(hasModuleHeader("/**\n * Module.\n */\nimport { a } from './a.js'\n")).toBe(true)
    expect(hasModuleHeader('/** Module. */\n\nexport const a = 1\n')).toBe(true)
    expect(hasModuleHeader("#!/usr/bin/env node\n/** Bin. */\nimport './cli.js'\n")).toBe(true)
    expect(hasModuleHeader("/** Module. */\nexport { a } from './a.js'\n")).toBe(true)
    expect(hasModuleHeader('/** The class. */\nexport class A {}\n')).toBe(false)
    expect(hasModuleHeader("import { a } from './a.js'\n/** Doc. */\n\nexport const b = a\n")).toBe(false)
    expect(hasModuleHeader("/* plain comment */\nimport './a.js'\n")).toBe(false)
  })

  it('finds every module of the package', () => {
    expect(ALL_MODULES).toEqual(expect.arrayContaining(['index.ts', 'core/Dispatcher.ts', 'conversations/ConversationRuntime.ts', 'dev/bin.ts']))
    expect(ALL_MODULES.length).toBeGreaterThan(100)
  })

  it.each(ALL_MODULES)('%s opens with a header comment saying what it is responsible for', (rel) => {
    expect(hasModuleHeader(read(rel))).toBe(true)
  })

  it('Bot.ts has no ECMAScript #private members', () => {
    const code = read('core/Bot.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/(^|[\s.;(])#[A-Za-z_$]/m)
  })
})
