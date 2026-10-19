/**
 * Structure guard for the core: every `core/bot/*` module stays small (< 500 lines) and
 * opens with a header comment saying what it is responsible for; so do the other
 * modules listed below. `Bot.ts` is the documented exception to the size limit: it is
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

/** Modules outside `core/bot` that must also open with a header. */
const HEADED = [
  'core/Bot.ts',
  'core/matching.ts',
  'conversations/controls.ts',
  'conversations/handler.ts',
  'conversations/interpreter.ts',
  'flows/FlowBuilder.ts',
  'store/NamespacedStore.ts',
  'utils/duration.ts',
  'testing/index.ts',
]

const botModules = readdirSync(join(src, 'core/bot')).filter((f) => f.endsWith('.ts')).map((f) => `core/bot/${f}`)

describe('core structure', () => {
  it.each(botModules)('%s is under 500 lines and opens with a header comment', (rel) => {
    const text = read(rel)
    expect(lineCount(text)).toBeLessThan(MAX_LINES)
    expect(text.startsWith('/**')).toBe(true)
  })

  it.each(HEADED)('%s opens with a header comment', (rel) => {
    expect(read(rel).startsWith('/**')).toBe(true)
  })

  it('Bot.ts has no ECMAScript #private members', () => {
    const code = read('core/Bot.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/(^|[\s.;(])#[A-Za-z_$]/m)
  })
})
