import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizeName, scaffold } from '../src/scaffold.js'
import { TEMPLATE_NAMES, TEMPLATES } from '../src/templates.js'
// Plain-JS bin; typed through its JSDoc because tsconfig sets `allowJs`.
import { parseArgs } from '../src/cli.js'

/** Temp dirs created per test, removed after each test (hermetic). */
const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'create-bot-wa-test-'))
  tempDirs.push(dir)
  return dir
}

async function read(dir: string, file: string): Promise<string> {
  return readFile(join(dir, file), 'utf8')
}

afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

describe('scaffold — every template', () => {
  it('knows the four documented templates', () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual(['ai', 'baileys', 'meta', 'telegram'])
  })

  it.each(TEMPLATE_NAMES)('template "%s" generates the full project', async (template) => {
    const base = await makeTempDir()
    const target = join(base, 'my-bot')

    const result = await scaffold({ targetDir: target, template })

    expect(result.name).toBe('my-bot')
    expect(result.template).toBe(template)
    expect(result.files.sort()).toEqual(['.env.example', '.gitignore', 'README.md', 'package.json', 'src/bot.js'])

    // package.json — valid JSON, ESM, right deps + start script.
    const pkg = JSON.parse(await read(target, 'package.json'))
    expect(pkg.name).toBe('my-bot')
    expect(pkg.type).toBe('module')
    expect(pkg.scripts.start).toBe('node --env-file=.env src/bot.js')
    expect(pkg.dependencies['@bot-wa/core']).toBeTruthy()

    // bot.js — imports core + the right provider, has the /hola handler, a flow, and starts.
    const bot = await read(target, 'src/bot.js')
    expect(bot).toContain("from '@bot-wa/core'")
    expect(bot).toContain('bot.when(\'hola\'')
    expect(bot).toContain('flow(')
    expect(bot).toContain('await bot.start()')

    // .gitignore — standard ignores for every template.
    const gitignore = await read(target, '.gitignore')
    for (const marker of ['node_modules/', 'sessions/', '.env', '*.qr.png']) expect(gitignore).toContain(marker)

    // README exists with run instructions.
    const readme = await read(target, 'README.md')
    expect(readme).toContain('npm install')
    expect(readme).toContain('npm start')

    // bot.js is syntactically valid ESM (parse only — imports are not resolved, no network).
    expect(() => execFileSync(process.execPath, ['--check', join(target, 'src/bot.js')], { stdio: 'pipe' })).not.toThrow()
  })

  it('baileys template wires BaileysProvider + BOT_SESSION', async () => {
    const base = await makeTempDir()
    const target = join(base, 'b')
    await scaffold({ targetDir: target, template: 'baileys' })

    const pkg = JSON.parse(await read(target, 'package.json'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@bot-wa/baileys', '@bot-wa/core'])

    const bot = await read(target, 'src/bot.js')
    expect(bot).toContain("import { BaileysProvider } from '@bot-wa/baileys'")
    expect(bot).toContain('new BaileysProvider(')

    expect(await read(target, '.env.example')).toContain('BOT_SESSION=')
  })

  it('meta template wires CloudAPIProvider + META_* vars', async () => {
    const base = await makeTempDir()
    const target = join(base, 'm')
    await scaffold({ targetDir: target, template: 'meta' })

    const pkg = JSON.parse(await read(target, 'package.json'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@bot-wa/core', '@bot-wa/meta'])

    const bot = await read(target, 'src/bot.js')
    expect(bot).toContain("import { CloudAPIProvider } from '@bot-wa/meta'")
    expect(bot).toContain('new CloudAPIProvider(')
    expect(bot).toContain('provider.verifyChallenge(')
    expect(bot).toContain('provider.ingest(')
    expect(bot).toContain('provider.ingest(raw, req.headers)')
    expect(bot).toContain('MAX_WEBHOOK_BYTES')
    expect(bot).toContain('res.writeHead(413)')
    expect(bot).not.toContain('provider.ingest(JSON.parse(raw)')

    const env = await read(target, '.env.example')
    expect(env).toContain('META_TOKEN=')
    expect(env).toContain('META_PHONE_ID=')
  })

  it('telegram template wires TelegramProvider + TELEGRAM_TOKEN', async () => {
    const base = await makeTempDir()
    const target = join(base, 't')
    await scaffold({ targetDir: target, template: 'telegram' })

    const pkg = JSON.parse(await read(target, 'package.json'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@bot-wa/core', '@bot-wa/telegram'])

    const bot = await read(target, 'src/bot.js')
    expect(bot).toContain("import { TelegramProvider } from '@bot-wa/telegram'")
    expect(bot).toContain('new TelegramProvider({ token: process.env.TELEGRAM_TOKEN })')

    expect(await read(target, '.env.example')).toContain('TELEGRAM_TOKEN=')
  })

  it('ai template wires Baileys + aiPlugin + Anthropic SDK/key', async () => {
    const base = await makeTempDir()
    const target = join(base, 'a')
    await scaffold({ targetDir: target, template: 'ai' })

    const pkg = JSON.parse(await read(target, 'package.json'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@anthropic-ai/sdk',
      '@bot-wa/ai',
      '@bot-wa/baileys',
      '@bot-wa/core',
    ])

    const bot = await read(target, 'src/bot.js')
    expect(bot).toContain("import { aiPlugin } from '@bot-wa/ai'")
    expect(bot).toContain('bot.plug(')
    expect(bot).toContain("provider: 'anthropic'")
    expect(bot).toContain('process.env.ANTHROPIC_API_KEY')

    expect(await read(target, '.env.example')).toContain('ANTHROPIC_API_KEY=')
  })

  it('ai template ships a business-scoped persona, not a general-purpose assistant', async () => {
    const base = await makeTempDir()
    const target = join(base, 'a2')
    await scaffold({ targetDir: target, template: 'ai' })

    const bot = await read(target, 'src/bot.js')
    // The persona is built from the business name and restricted to the business's own topics.
    expect(bot).toContain('process.env.BUSINESS_NAME')
    expect(bot).toContain('persona: PERSONA')
    expect(bot).toMatch(/solo (respondes|ayudas)/i)
    expect(bot).not.toContain('Eres un asistente amable y breve.')
    // The source points at the policy so whoever edits the persona sees it.
    expect(bot).toContain('WhatsApp Business Platform')

    expect(await read(target, '.env.example')).toContain('BUSINESS_NAME=')
  })

  it('ai template README explains the Meta 2026 AI policy', async () => {
    const base = await makeTempDir()
    const target = join(base, 'a3')
    await scaffold({ targetDir: target, template: 'ai' })

    const readme = await read(target, 'README.md')
    expect(readme).toContain('WhatsApp Business Platform')
    expect(readme).toContain('2026-01-15')
    expect(readme).toMatch(/general-purpose/i)
    expect(readme).not.toMatch(/every incoming text message is auto-replied/i)
  })

  it('ai template description is business-scoped', () => {
    expect(TEMPLATES.ai.description).toMatch(/customer support|business/i)
  })
})

describe('scaffold — naming', () => {
  it('derives a valid package name from the directory', async () => {
    const base = await makeTempDir()
    const target = join(base, 'My Cool Bot!')
    const result = await scaffold({ targetDir: target, template: 'baileys' })

    expect(result.name).toBe('my-cool-bot')
    const pkg = JSON.parse(await read(target, 'package.json'))
    expect(pkg.name).toBe('my-cool-bot')
  })

  it('honors an explicit name', async () => {
    const base = await makeTempDir()
    const target = join(base, 'dir-name')
    const result = await scaffold({ targetDir: target, name: 'custom-name', template: 'telegram' })

    expect(result.name).toBe('custom-name')
    const pkg = JSON.parse(await read(target, 'package.json'))
    expect(pkg.name).toBe('custom-name')
  })

  it('sanitizeName handles edge cases', () => {
    expect(sanitizeName('.hidden')).toBe('hidden')
    expect(sanitizeName('___')).toBe('my-bot')
    expect(sanitizeName('UPPER Case')).toBe('upper-case')
    expect(sanitizeName('ok-name')).toBe('ok-name')
  })
})

describe('scaffold — target directory guard', () => {
  it('throws when the target exists and is non-empty (no overwrite)', async () => {
    const base = await makeTempDir()
    const target = join(base, 'taken')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'existing.txt'), 'keep me')

    await expect(scaffold({ targetDir: target, template: 'baileys' })).rejects.toThrow(/not empty/i)
    // The pre-existing file must survive the failed attempt.
    expect(await read(target, 'existing.txt')).toBe('keep me')
  })

  it('scaffolds into an empty existing directory without overwrite', async () => {
    const base = await makeTempDir()
    const target = join(base, 'empty')
    await mkdir(target, { recursive: true })

    const result = await scaffold({ targetDir: target, template: 'meta' })
    expect(result.files).toContain('package.json')
  })

  it('overwrites when overwrite: true', async () => {
    const base = await makeTempDir()
    const target = join(base, 'taken2')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'existing.txt'), 'keep me')

    const result = await scaffold({ targetDir: target, template: 'baileys', overwrite: true })
    expect(result.files).toContain('src/bot.js')
    expect(await read(target, 'existing.txt')).toBe('keep me') // untouched sibling
    expect(JSON.parse(await read(target, 'package.json')).name).toBe('taken2')
  })

  it('rejects an unknown template', async () => {
    const base = await makeTempDir()
    await expect(
      scaffold({ targetDir: join(base, 'x'), template: 'nope' as never }),
    ).rejects.toThrow(/unknown template/i)
  })

  it('every template builder produces unique, non-empty files', () => {
    for (const name of TEMPLATE_NAMES) {
      const files = TEMPLATES[name].files('demo')
      expect(files.length).toBeGreaterThan(0)
      const paths = files.map((f) => f.path)
      expect(new Set(paths).size).toBe(paths.length)
      for (const f of files) expect(f.contents.length, name + ':' + f.path).toBeGreaterThan(0)
    }
  })
})

describe('cli parseArgs', () => {
  it('parses positional target + flags', () => {
    expect(parseArgs(['my-bot', '--template', 'meta', '--name', 'pkg', '--yes', '--overwrite'])).toEqual({
      targetDir: 'my-bot',
      template: 'meta',
      name: 'pkg',
      yes: true,
      overwrite: true,
      help: false,
    })
  })

  it('supports short flags and --opt=value syntax', () => {
    expect(parseArgs(['-t', 'ai', 'dir'])).toMatchObject({ targetDir: 'dir', template: 'ai' })
    expect(parseArgs(['--template=telegram', 'dir'])).toMatchObject({ template: 'telegram' })
    expect(parseArgs(['dir', '--name=pkg-name', '-y'])).toMatchObject({ name: 'pkg-name', yes: true })
    expect(parseArgs(['-h'])).toMatchObject({ help: true })
  })

  it('rejects unknown options and stray positionals', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/i)
    expect(() => parseArgs(['a', 'b'])).toThrow(/unexpected argument/i)
  })
})
