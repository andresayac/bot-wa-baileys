import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Bot } from '../src/core/Bot.js'
import type { LoggerLike } from '../src/core/provider.js'
import { defineBot } from '../src/dev/defineBot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { parseCliArgs, runCli, CLI_USAGE, DevUsageError, type CliIO } from '../src/dev/cli.js'

const silent: LoggerLike = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } }

const tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmesh-dev-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

/** Collects everything written to a PassThrough so tests can poll it. */
function sink() {
  const stream = new PassThrough()
  let data = ''
  stream.on('data', (chunk: Buffer) => { data += chunk.toString('utf8') })
  return {
    stream,
    text: () => data,
    async until(pattern: string | RegExp, timeoutMs = 3000) {
      const ok = () => (typeof pattern === 'string' ? data.includes(pattern) : pattern.test(data))
      const deadline = Date.now() + timeoutMs
      while (!ok()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${String(pattern)}. Output:\n${data}`)
        await new Promise((r) => setTimeout(r, 5))
      }
    },
  }
}

function makeIO(overrides: Partial<CliIO> = {}) {
  const stdin = new PassThrough()
  const out = sink()
  const err = sink()
  const io: CliIO = {
    stdin,
    stdout: out.stream,
    stderr: err.stream,
    env: {},
    installHooks: false,
    ...overrides,
  }
  return { io, stdin, out, err }
}

describe('parseCliArgs', () => {
  it('parses `dev <entry>` with defaults', () => {
    expect(parseCliArgs(['dev', 'src/bot.js'])).toEqual({
      command: 'dev', entry: 'src/bot.js', watch: true, envFiles: [],
      user: undefined, name: undefined, group: undefined, watchDir: undefined, color: undefined,
    })
  })

  it('parses every option, in both --opt value and --opt=value forms', () => {
    expect(parseCliArgs([
      'dev', '--user', 'alice', '--name=Alice Smith', '--group', 'team', 'src/bot.ts',
      '--env-file', '.env', '--env-file=.env.local', '--watch', 'src', '--no-color',
    ])).toEqual({
      command: 'dev', entry: 'src/bot.ts', watch: true, watchDir: 'src', envFiles: ['.env', '.env.local'],
      user: 'alice', name: 'Alice Smith', group: 'team', color: false,
    })
    expect(parseCliArgs(['dev', 'a.js', '--no-watch', '--color'])).toMatchObject({ watch: false, color: true })
  })

  it('recognises help and version', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h'], ['dev', '--help']]) expect(parseCliArgs(argv).command).toBe('help')
    for (const argv of [['--version'], ['-v']]) expect(parseCliArgs(argv).command).toBe('version')
  })

  it('throws DevUsageError for bad input', () => {
    expect(() => parseCliArgs(['dev'])).toThrow(DevUsageError)
    expect(() => parseCliArgs(['dev'])).toThrow(/entry/)
    expect(() => parseCliArgs(['dev', 'a.js', 'b.js'])).toThrow(/Unexpected argument: b\.js/)
    expect(() => parseCliArgs(['dev', 'a.js', '--bogus'])).toThrow(/Unknown option: --bogus/)
    expect(() => parseCliArgs(['dev', 'a.js', '--user'])).toThrow(/--user needs a value/)
    expect(() => parseCliArgs(['serve'])).toThrow(/Unknown command: serve/)
  })
})

describe('runCli', () => {
  it('prints usage for help and exits 0', async () => {
    const { io, out } = makeIO()
    expect(await runCli(['--help'], io)).toBe(0)
    expect(out.text()).toContain('botmesh dev <entry>')
    expect(CLI_USAGE).toContain('--env-file')
  })

  it('prints the version', async () => {
    const { io, out } = makeIO()
    expect(await runCli(['--version'], io)).toBe(0)
    expect(out.text()).toMatch(/^botmesh \d+\.\d+\.\d+/)
  })

  it('exits 2 with usage on bad arguments', async () => {
    const { io, err } = makeIO()
    expect(await runCli(['dev'], io)).toBe(2)
    expect(err.text()).toContain('entry')
    expect(err.text()).toContain('Usage:')
  })

  it('exits 1 when the entry does not exist', async () => {
    const dir = await makeTempDir()
    const { io, err } = makeIO({ cwd: dir })
    expect(await runCli(['dev', 'nope.js'], io)).toBe(1)
    expect(err.text()).toContain('entry not found')
  })

  it('exits 1 with a hint for TypeScript entries when Node cannot strip types', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.ts'), 'export default 1\n')
    const { io, err } = makeIO({ cwd: dir, features: { typescript: false }, nodeVersion: '22.11.0' })
    expect(await runCli(['dev', 'bot.ts'], io)).toBe(1)
    expect(err.text()).toContain('--experimental-strip-types')
  })

  it('runs a session over injected streams, hot-reloads on change and quits', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.mjs'), '// loaded through the injected importer\n')
    let version = 1
    const urls: string[] = []
    const fakeWatch: { dir?: string; trigger?: (files: string[]) => void; closed: boolean } = { closed: false }
    const env: Record<string, string | undefined> = {}
    const { io, stdin, out } = makeIO({
      cwd: dir,
      env,
      importModule: async (url) => {
        urls.push(url)
        const v = version
        return { default: defineBot((provider) => {
          const bot = new Bot({ provider, logger: silent })
          bot.when('hola', async (ctx) => { await ctx.reply(`hola v${v}`) })
          return bot
        }) }
      },
      watch: (watchDir, onChange) => {
        fakeWatch.dir = watchDir
        fakeWatch.trigger = onChange
        return { close: () => { fakeWatch.closed = true } }
      },
    })
    const exit = runCli(['dev', 'bot.mjs', '--user', 'ana'], io)
    await out.until('terminal simulator')
    expect(env.BOT_WA_DEV).toBe('1')

    stdin.write('hola\n')
    await out.until('bot › hola v1')
    expect(resolve(fakeWatch.dir!)).toBe(resolve(dir))
    expect(out.text()).toContain('ana › hola') // non-TTY input is echoed into the transcript

    version = 2
    fakeWatch.trigger!(['bot.mjs'])
    await out.until('↻ reloaded (bot.mjs changed)')
    stdin.write('hola\n')
    await out.until('bot › hola v2')

    stdin.write(':quit\n')
    expect(await exit).toBe(0)
    expect(fakeWatch.closed).toBe(true)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toMatch(/bot\.mjs\?botwa_v=1$/)
    expect(urls[1]).toMatch(/bot\.mjs\?botwa_v=2$/)
  })

  it('finishes pending lines and exits 0 when stdin ends', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.mjs'), '\n')
    const { io, stdin, out } = makeIO({
      cwd: dir,
      importModule: async () => defineBot((provider) => {
        const bot = new Bot({ provider, logger: silent })
        bot.when('ping', async (ctx) => { await ctx.reply('pong') })
        return bot
      }),
    })
    const exit = runCli(['dev', 'bot.mjs', '--no-watch'], io)
    stdin.end('ping\n')
    expect(await exit).toBe(0)
    expect(out.text()).toContain('bot › pong')
    expect(out.text()).toContain('watch  off')
  })

  it('loads --env-file files and warns about missing ones', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.mjs'), '\n')
    await writeFile(join(dir, '.env'), 'X=1\n')
    const loaded: string[] = []
    const { io, stdin, out } = makeIO({
      cwd: dir,
      loadEnvFile: (path) => { loaded.push(path) },
      importModule: async () => defineBot((provider) => new Bot({ provider, logger: silent })),
    })
    const exit = runCli(['dev', 'bot.mjs', '--no-watch', '--env-file', '.env', '--env-file', '.env.missing'], io)
    stdin.end()
    expect(await exit).toBe(0)
    expect(loaded).toEqual([join(dir, '.env')])
    expect(out.text()).toContain('.env.missing not found')
  })

  it('exits even in watch mode when the entry ran but exports no factory (it may have connected for real)', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.mjs'), '\n')
    let closed = false
    const { io, out } = makeIO({
      cwd: dir,
      importModule: async () => ({ somethingElse: true }),
      watch: () => ({ close: () => { closed = true } }),
    })
    expect(await runCli(['dev', 'bot.mjs'], io)).toBe(1)
    expect(out.text()).toContain('exports no bot factory')
    expect(out.text()).toContain('isMainModule(import.meta)')
    expect(closed).toBe(true)
  })

  it('keeps watching after a syntax error so the fix can be saved', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.mjs'), '\n')
    let broken = true
    let trigger: ((files: string[]) => void) | undefined
    const { io, stdin, out } = makeIO({
      cwd: dir,
      importModule: async () => {
        if (broken) throw new SyntaxError('Unexpected end of input')
        return defineBot((provider) => {
          const bot = new Bot({ provider, logger: silent })
          bot.when('hola', async (ctx) => { await ctx.reply('arreglado') })
          return bot
        })
      },
      watch: (_dir, onChange) => { trigger = onChange; return { close() {} } },
    })
    const exit = runCli(['dev', 'bot.mjs'], io)
    await out.until('Unexpected end of input')
    await out.until('reloads automatically')
    broken = false
    trigger!(['bot.mjs'])
    await out.until('↻ reloaded')
    stdin.end('hola\n')
    expect(await exit).toBe(0)
    expect(out.text()).toContain('bot › arreglado')
  })

  it('exits 1 when the entry fails to load and watching is off', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.mjs'), '\n')
    const { io, out } = makeIO({ cwd: dir, importModule: async () => ({}) })
    expect(await runCli(['dev', 'bot.mjs', '--no-watch'], io)).toBe(1)
    expect(out.text()).toContain('defineBot')
  })

  it('waits for slow replies (e.g. AI calls) before exiting when piped input ends', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.mjs'), '\n')
    const { io, stdin, out } = makeIO({
      cwd: dir,
      importModule: async () => defineBot((provider) => {
        const bot = new Bot({ provider, logger: silent })
        bot.when('hola', async (ctx) => {
          await new Promise((r) => setTimeout(r, 600))
          await ctx.reply('slow reply')
        })
        bot.when('chau', async (ctx) => { await ctx.reply('bye') })
        return bot
      }),
    })
    const exit = runCli(['dev', 'bot.mjs', '--no-watch'], io)
    stdin.end('hola\nchau\n')
    expect(await exit).toBe(0)
    const t = out.text()
    expect(t).toContain('bot › slow reply')
    // The transcript stays in order: the slow reply comes before the next message.
    expect(t.indexOf('bot › slow reply')).toBeLessThan(t.indexOf('user › chau'))
    expect(t).toContain('bot › bye')
  })

  it('exits even in watch mode when the factory builds its own provider, closing it', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.mjs'), '\n')
    const counters = { starts: 0, stops: 0 }
    class RealProvider extends MockProvider {
      override async start() { counters.starts++; await super.start() }
      override async stop() { counters.stops++; await super.stop() }
    }
    let closed = false
    let trigger: ((files: string[]) => void) | undefined
    const { io, out } = makeIO({
      cwd: dir,
      importModule: async () => defineBot(async () => {
        const bot = new Bot({ provider: new RealProvider(), logger: silent })
        await bot.start()
        return bot
      }),
      watch: (_dir, onChange) => { trigger = onChange; return { close: () => { closed = true } } },
    })
    expect(await runCli(['dev', 'bot.mjs'], io)).toBe(1)
    expect(out.text()).toContain('refusing to start your bot')
    expect(out.text()).toContain('stopping')
    expect(closed).toBe(true)
    expect(counters).toEqual({ starts: 1, stops: 1 })
    trigger?.(['bot.mjs']) // a late save must not call the factory again
    await new Promise((r) => setTimeout(r, 20))
    expect(counters.starts).toBe(1)
  })

  it('exits when a hot reload switches the factory to its own provider', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.mjs'), '\n')
    let foreign = false
    let realStarts = 0
    let realStops = 0
    class RealProvider extends MockProvider {
      override async start() { realStarts++; await super.start() }
      override async stop() { realStops++; await super.stop() }
    }
    let trigger: ((files: string[]) => void) | undefined
    let closed = false
    const { io, stdin, out } = makeIO({
      cwd: dir,
      importModule: async () => defineBot(async (provider) => {
        const bot = new Bot({ provider: foreign ? new RealProvider() : provider, logger: silent })
        bot.when('hola', async (ctx) => { await ctx.reply('hola dev') })
        if (foreign) await bot.start()
        return bot
      }),
      watch: (_dir, onChange) => { trigger = onChange; return { close: () => { closed = true } } },
    })
    const exit = runCli(['dev', 'bot.mjs'], io)
    stdin.write('hola\n')
    await out.until('bot › hola dev')
    foreign = true
    trigger!(['bot.mjs'])
    expect(await exit).toBe(1)
    expect(out.text()).toContain('refusing to start your bot')
    expect(closed).toBe(true)
    expect(realStarts).toBe(1)
    expect(realStops).toBe(1)
  })
})

/* ---------------------------------------------------------------------------
 * End to end: the real bin (lib/dev/bin.js) in a child process — real module
 * loading, real fs.watch hot reload, Node type stripping. Requires `pnpm build`.
 * ------------------------------------------------------------------------ */

const coreRoot = fileURLToPath(new URL('..', import.meta.url))
const binPath = join(coreRoot, 'lib', 'dev', 'bin.js')
const libIndexUrl = pathToFileURL(join(coreRoot, 'lib', 'index.js')).href
const hasTypeStripping = Boolean((process.features as { typescript?: unknown }).typescript)

function startBin(cwd: string, args: string[]) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [binPath, ...args], { cwd, stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  let data = ''
  child.stdout.on('data', (c: Buffer) => { data += c.toString('utf8') })
  child.stderr.on('data', (c: Buffer) => { data += c.toString('utf8') })
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
  return {
    child,
    exited,
    text: () => data,
    async until(pattern: string, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      while (!data.includes(pattern)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}. Output:\n${data}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    },
  }
}

describe.skipIf(!existsSync(binPath))('botmesh dev (end to end, built bin)', () => {
  it('hot-reloads relative imports of a JS entry', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'greeting.mjs'), "export const greeting = 'saludo v1'\n")
    await writeFile(join(dir, 'bot.mjs'), [
      `import { Bot, defineBot } from '${libIndexUrl}'`,
      "import { greeting } from './greeting.mjs'",
      'export default defineBot((provider) => {',
      '  const bot = new Bot({ provider })',
      "  bot.when('hola', async (ctx) => { await ctx.reply(greeting) })",
      '  return bot',
      '})',
      '',
    ].join('\n'))
    const run = startBin(dir, ['dev', 'bot.mjs'])
    try {
      await run.until('terminal simulator')
      run.child.stdin.write('hola\n')
      await run.until('bot › saludo v1')
      await new Promise((r) => setTimeout(r, 200)) // let the watcher settle before editing
      await writeFile(join(dir, 'greeting.mjs'), "export const greeting = 'saludo v2'\n")
      await run.until('↻ reloaded')
      run.child.stdin.write('hola\n')
      await run.until('bot › saludo v2')
      run.child.stdin.write(':quit\n')
      expect(await run.exited).toBe(0)
    } finally {
      run.child.kill()
    }
  }, 40_000)

  it.skipIf(!hasTypeStripping)('runs a TypeScript entry with Node type stripping', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'bot.ts'), [
      `import { Bot, defineBot } from '${libIndexUrl}'`,
      `import type { IProvider } from '${libIndexUrl}'`,
      'const reply: string = "desde TS"',
      'export default defineBot((provider: IProvider) => {',
      '  const bot = new Bot({ provider })',
      "  bot.when('hola', async (ctx) => { await ctx.reply(reply) })",
      '  return bot',
      '})',
      '',
    ].join('\n'))
    const run = startBin(dir, ['dev', 'bot.ts', '--no-watch'])
    try {
      await run.until('terminal simulator')
      run.child.stdin.end('hola\n')
      await run.until('bot › desde TS')
      expect(await run.exited).toBe(0)
    } finally {
      run.child.kill()
    }
  }, 40_000)
})
