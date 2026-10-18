import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { scaffold } from '../src/scaffold.js'
import { TEMPLATE_NAMES } from '../src/templates.js'

/** Temp dirs created per test, removed after each test (hermetic). */
const tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'create-bot-wa-dev-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

describe('generated projects follow the defineBot factory pattern', () => {
  it.each(TEMPLATE_NAMES)('template "%s" exports a factory, guards the real provider and has a dev script', async (template) => {
    const target = join(await makeTempDir(), 'my-bot')
    await scaffold({ targetDir: target, template })

    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    expect(pkg.scripts.start).toBe('node --env-file=.env src/bot.js')
    expect(pkg.scripts.dev).toBe('bot-wa dev src/bot.js --env-file .env')

    const bot = await readFile(join(target, 'src/bot.js'), 'utf8')
    expect(bot).toMatch(/^import \{ Bot, defineBot, flow, isMainModule(, \w+)* \} from '@bot-wa\/core'$/m)
    expect(bot).toMatch(/^const createBot = defineBot\(\(provider(, store)?\) => \{$/m)
    expect(bot).toMatch(/^ {2}const bot = new Bot\(\{ provider(,| \})/m)
    expect(bot).toContain('  return bot\n})')
    expect(bot).toContain('export default createBot')
    expect(bot).toContain('if (isMainModule(import.meta)) {')
    expect(bot).toContain('  const bot = await createBot(')
    // Handlers live inside the factory (indented), so dev and start share them.
    expect(bot).toContain("  bot.when('hola'")
    // The real provider is only constructed in the main block, after the factory.
    expect(bot.indexOf('if (isMainModule(import.meta))')).toBeGreaterThan(bot.indexOf('export default createBot'))

    const readme = await readFile(join(target, 'README.md'), 'utf8')
    expect(readme).toContain('npm run dev')

    // The generated module must at least be valid ESM.
    const check = spawnSync(process.execPath, ['--check', join(target, 'src/bot.js')], { encoding: 'utf8' })
    expect(check.stderr).toBe('')
    expect(check.status).toBe(0)
  })
})

/* ---------------------------------------------------------------------------
 * Run each generated bot.js inside the real `bot-wa dev` engine (DevSession
 * from @bot-wa/core's build), with the transport/AI packages stubbed out.
 * Requires @bot-wa/core to be built (`pnpm build`).
 * ------------------------------------------------------------------------ */

const coreLib = fileURLToPath(new URL('../../core/lib/', import.meta.url))
const devEntry = join(coreLib, 'dev', 'index.js')

interface DevSessionLike {
  start(): Promise<boolean>
  handleLine(line: string): Promise<string>
  stop(): Promise<void>
}
interface DevModule {
  DevSession: new (options: { load: () => Promise<unknown>; write: (text: string) => void }) => DevSessionLike
}

const STUBS = [
  "const forbidden = (name) => class { constructor() { throw new Error(name + ' must not be built under bot-wa dev') } }",
  "export const BaileysProvider = forbidden('BaileysProvider')",
  "export const CloudAPIProvider = forbidden('CloudAPIProvider')",
  "export const TelegramProvider = forbidden('TelegramProvider')",
  "export const aiPlugin = () => ({ name: 'ai-stub', install() {} })",
  '',
].join('\n')

/** Transport templates share the hola + menu demo handlers (use-case templates: domain-templates.test.ts). */
const TRANSPORT_TEMPLATES = TEMPLATE_NAMES.filter((t) => ['baileys', 'meta', 'telegram', 'ai'].includes(t))

describe.skipIf(!existsSync(devEntry))('generated bots run in the bot-wa dev simulator', () => {
  it('covers the four transport templates', () => {
    expect(TRANSPORT_TEMPLATES).toHaveLength(4)
  })

  it.each(TRANSPORT_TEMPLATES)('template "%s" answers in the simulator without building the real provider', async (template) => {
    const target = join(await makeTempDir(), 'sim-bot')
    await scaffold({ targetDir: target, template })

    const source = await readFile(join(target, 'src/bot.js'), 'utf8')
    const runnable = source
      .replace(/from '@bot-wa\/core'/g, `from '${pathToFileURL(join(coreLib, 'index.js')).href}'`)
      .replace(/from '@bot-wa\/(?:baileys|meta|telegram|ai)'/g, "from './stubs.mjs'")
    await writeFile(join(target, 'src/stubs.mjs'), STUBS)
    await writeFile(join(target, 'src/bot.sim.mjs'), runnable)

    const dev = (await import(pathToFileURL(devEntry).href)) as DevModule
    let output = ''
    const session = new dev.DevSession({
      load: () => import(pathToFileURL(join(target, 'src/bot.sim.mjs')).href),
      write: (text) => { output += text },
    })
    const until = async (needle: string) => {
      for (let i = 0; i < 1000 && !output.includes(needle); i++) await new Promise((r) => setTimeout(r, 5))
      expect(output).toContain(needle)
    }

    expect(await session.start()).toBe(true)
    await session.handleLine('hola')
    await until('bot › ¡Hola! 👋')
    await session.handleLine('menu')
    await until('Responde 1 o 2:')
    await session.handleLine('2')
    await until('🏓 ¡pong!')
    await session.stop()
    expect(output).not.toContain('must not be built')
  })
})
