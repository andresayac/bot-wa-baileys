#!/usr/bin/env node
/**
 * Packaging smoke test — simulates installing the public packages from npm
 * WITHOUT publishing anything.
 *
 *   pnpm pack:smoke                 # build, pack, install in a clean consumer, verify
 *   pnpm pack:smoke --no-build      # reuse the current lib/ output
 *   pnpm pack:smoke --no-scaffold-install   # skip the per-template npm installs (faster)
 *   pnpm pack:smoke --keep          # keep the temp dir for inspection
 *
 * Steps:
 *  1. `pnpm pack` every public (non-private) package into a temp dir OUTSIDE
 *     the repo (pnpm rewrites `workspace:` ranges to real versions).
 *  2. Inspect each tarball: required files (README, LICENSE, main/types/bin and
 *     every `exports` target), nothing that should not ship (src, tests, maps,
 *     configs, env/session files), no relative links in the README (they break
 *     on npmjs.com), no lib/ file without a source (stale build
 *     output), manifest sanity (engines, type, no `workspace:` left, no
 *     dependency on a private workspace package, internal ranges satisfied by
 *     the packed versions) and size budgets.
 *  3. Create a clean npm consumer project, install every tarball plus
 *     TypeScript, and check: every exports subpath imports at runtime; a
 *     consumer .ts typechecks with moduleResolution nodenext AND bundler
 *     (including the `ctx.tools.ai` DefaultTools augmentation); a small runtime
 *     scenario (createTestBot, aiPlugin + MockAIProvider, SQLiteStore); optional
 *     AI SDK peers absent → import works, a clear lazy error only on use; the
 *     `botmesh` and `create-botmesh` bins run.
 *  4. Scaffold every create-botmesh template, check its @botmesh ranges resolve
 *     to the packed versions (npm prerelease rules), then `npm install` it with
 *     its ranges UNTOUCHED: a throwaway local registry (scripts/smoke/registry.mjs,
 *     routed with a scoped `@botmesh:registry=`) serves the packed tarballs, so
 *     npm itself must resolve every stamped range. `node --check` every .js and
 *     boot it in `botmesh dev` (non-interactive).
 *
 * Network: npm still downloads third-party dependencies (baileys, redis, ...).
 * Never publishes, never touches the npm registry with our packages.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { relativeLinks } from './smoke/readme-links.mjs'
import { satisfies } from './smoke/semver.mjs'

/* -------------------------------------------------------------------------- */
/* Consumer sources                                                           */
/* -------------------------------------------------------------------------- */

const CONSUMER_TS = `import { Bot, flow, defineBot, isMainModule } from '@botmesh/core'
import type { IProvider, MessageContext } from '@botmesh/core'
import { createTestBot, MockProvider } from '@botmesh/core/testing'
import { runCli } from '@botmesh/core/dev'
import { createPacer } from '@botmesh/core/internal'
import { aiPlugin, MockAIProvider, type AIClient } from '@botmesh/ai'
import { TelegramProvider } from '@botmesh/telegram'
import { CloudAPIProvider } from '@botmesh/meta'
import { BaileysProvider } from '@botmesh/baileys'
import { SQLiteStore } from '@botmesh/sqlite-store'
import { RedisStore } from '@botmesh/redis-store'
import { secureFetch } from '@botmesh/http'
import { verifySignature } from '@botmesh/graph-core'
import { scaffold } from 'create-botmesh'

export const providers: IProvider[] = [
  // logger takes any LoggerLike (console included), not only pino.
  new TelegramProvider({ token: 'x', logger: console }),
  new CloudAPIProvider({ accessToken: 'a', phoneNumberId: '1', verifyToken: 'v', appSecret: 's', logger: console }),
  new BaileysProvider({ session: 'demo', logger: console }),
]
export const store = new SQLiteStore({ file: ':memory:' })
export const refs = [RedisStore, secureFetch, verifySignature, scaffold, runCli, createPacer]

const createBot = defineBot((provider) => {
  const bot = new Bot({ provider })
  bot.plug(aiPlugin({ instance: new MockAIProvider({ reply: 'hi' }) }))
  // Hook contexts are typed by the event name: no annotation needed to read ctx.body.
  bot.before('message', async (ctx, next) => { void ctx.body.length; await next() })
  bot.after('send', (payload) => { void payload.content.kind })
  // An async install() is a compile error (PluginSpec.install returns void | SyncInstallError).
  // @ts-expect-error async install is rejected at compile time
  bot.plug({ name: 'p', version: '0', async install() {} })
  bot.when('hola', async (ctx) => {
    // DefaultTools augmentation from @botmesh/ai: no cast needed.
    const ai: AIClient = ctx.tools.ai
    await ctx.reply(typeof ai)
  })
  bot.use(flow('registrar').say('x').ask('name?', 'name').say((_ctx, c) => \`ok \${String(c.state.name)}\`))
  return bot
})
export default createBot
if (isMainModule(import.meta)) void createBot(new MockProvider())

const t = await createTestBot()
await t.chat.send('hola')
export const ctxType: MessageContext | undefined = undefined
`

const RUNTIME_MJS = `import assert from 'node:assert/strict'
import { createTestBot } from '@botmesh/core/testing'
import { aiPlugin, MockAIProvider } from '@botmesh/ai'
import { SQLiteStore } from '@botmesh/sqlite-store'

const t = await createTestBot()
t.bot.when('hola', (ctx) => ctx.reply('hi there'))
await t.chat.send('hola')
await t.chat.expectReply('hi there')

const t2 = await createTestBot()
t2.bot.plug(aiPlugin({ instance: new MockAIProvider({ reply: 'from ai' }), humanizeTyping: false }))
await t2.chat.send('anything')
await t2.chat.expectReply(/from ai/)

const s = new SQLiteStore({ file: ':memory:' })
await s.upsertChat({ id: 'c1', name: 'x' })
assert.equal((await s.getChat('c1'))?.name, 'x')

// Optional SDK peers are absent: plugging works, the clear error comes only on use.
const noop = () => {}
const silent = { level: 'silent', fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, child() { return silent } }
const t3 = await createTestBot({ logger: silent })
t3.bot.plug(aiPlugin({ provider: 'openai', apiKey: 'k', humanizeTyping: false }))
const err = await t3.bot.injectTools.ai.ask('x').then(() => undefined, (e) => e)
assert.ok(err instanceof Error, 'expected a lazy error for the missing openai SDK')
assert.match(err.message, /openai/)
console.log('RUNTIME OK')
process.exit(0)
`

const DEV_BOT = `import { Bot, defineBot } from '@botmesh/core'
export default defineBot((provider) => {
  const bot = new Bot({ provider })
  bot.when('hola', (ctx) => ctx.reply('PONG-SMOKE'))
  return bot
})
`

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const KEEP = args.has('--keep')
const BUILD = !args.has('--no-build')
const SCAFFOLD_INSTALL = !args.has('--no-scaffold-install')
const IS_WIN = process.platform === 'win32'

/** Size budgets per tarball (bytes). Generous; they catch accidental bloat. */
const MAX_PACKED = 1024 * 1024
const MAX_UNPACKED = 5 * 1024 * 1024

/** Files that must never ship in a tarball (paths are relative to the package root). */
const FORBIDDEN = [
  [/^src\//, 'source dir'],
  [/(^|\/)(tests?|__tests__|test-utils|examples|fixtures)\//, 'tests/examples'],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, 'test file'],
  [/\.map$/, 'source map'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'tsconfig'],
  [/(^|\/)vitest\.(config|workspace)\.[cm]?[jt]s$/, 'vitest config'],
  [/(^|\/)typedoc\.json$/, 'typedoc config'],
  [/\.tsbuildinfo$/, 'tsbuildinfo'],
  [/(^|\/)\.env(\..*)?$/, 'env file'],
  [/(^|\/)(sessions?|[^/]*_sessions)\//, 'session data'],
  [/(^|\/)creds\.json$/, 'credentials'],
  [/(^|\/)baileys_store\.json$/, 'baileys store'],
  [/\.qr\.png$/, 'QR image'],
  [/(^|\/)node_modules\//, 'node_modules'],
]

const failures = []
/** Kills the local registry child, if one was started (also on early exits). */
let stopRegistry = () => {}
const fail = (scope, msg) => {
  failures.push(`${scope}: ${msg}`)
  console.log(`  FAIL ${scope}: ${msg}`)
}
const step = (msg) => console.log(`\n== ${msg}`)

/* -------------------------------------------------------------------------- */
/* Process helpers                                                            */
/* -------------------------------------------------------------------------- */

const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)

/** Run a command; npm/pnpm go through the shell on Windows (.cmd shims). */
function run(cmd, cmdArgs, opts = {}) {
  const shell = IS_WIN && (cmd === 'npm' || cmd === 'pnpm' || cmd === 'npx')
  const res = spawnSync(shell ? [cmd, ...cmdArgs].map(quote).join(' ') : cmd, shell ? [] : cmdArgs, {
    cwd: opts.cwd ?? ROOT,
    input: opts.input,
    encoding: 'utf8',
    shell,
    timeout: opts.timeout ?? 600_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (res.error) return { ok: false, code: -1, out: `${out}\n${res.error.message}` }
  return { ok: res.status === 0, code: res.status, out }
}

function mustRun(scope, cmd, cmdArgs, opts) {
  const r = run(cmd, cmdArgs, opts)
  if (!r.ok) {
    fail(scope, `\`${cmd} ${cmdArgs.join(' ')}\` exited ${r.code}\n${r.out.split('\n').slice(-25).join('\n')}`)
  }
  return r
}

/* -------------------------------------------------------------------------- */
/* Tarball reader (ustar + pax long names)                                    */
/* -------------------------------------------------------------------------- */

function readTarball(file) {
  const buf = gunzipSync(readFileSync(file))
  const entries = new Map()
  let off = 0
  let paxPath
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const str = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(str(124, 136).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = str(345, 500)
    let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100)
    const body = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      paxPath = m?.[1]
      continue
    }
    if (paxPath) {
      name = paxPath
      paxPath = undefined
    }
    if (type === '0' || type === '\0') entries.set(name.replace(/^package\//, ''), Buffer.from(body))
  }
  return entries
}

/* -------------------------------------------------------------------------- */
/* Workspace discovery                                                        */
/* -------------------------------------------------------------------------- */

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))
const workspace = readdirSync(join(ROOT, 'packages'))
  .map((d) => join(ROOT, 'packages', d))
  .filter((d) => existsSync(join(d, 'package.json')))
  .map((dir) => ({ dir, pkg: readJson(join(dir, 'package.json')) }))
const privateNames = new Set(workspace.filter((w) => w.pkg.private).map((w) => w.pkg.name))
const publicPkgs = workspace.filter((w) => !w.pkg.private)
const publicNames = new Set(publicPkgs.map((w) => w.pkg.name))

/** Every exports target path (strings), flattened over conditions. */
function exportTargets(exp) {
  if (typeof exp === 'string') return [exp]
  if (!exp || typeof exp !== 'object') return []
  return Object.values(exp).flatMap(exportTargets)
}
/** Subpaths of an exports map (`.`, `./testing`, ...), excluding ./package.json. */
function exportSubpaths(pkg) {
  const exp = pkg.exports
  if (!exp) return ['.']
  if (typeof exp === 'string' || !Object.keys(exp).some((k) => k.startsWith('.'))) return ['.']
  return Object.keys(exp).filter((k) => k !== './package.json' && !k.includes('*'))
}
const norm = (p) => p.replace(/^\.\//, '')
const specifier = (name, sub) => (sub === '.' ? name : `${name}/${sub.slice(2)}`)

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

const tmpBase = mkdtempSync(join(tmpdir(), 'botmesh-pack-smoke-'))
if (resolve(tmpBase).toLowerCase().startsWith(ROOT.toLowerCase() + sep)) {
  console.error(`temp dir ${tmpBase} is inside the repo; refusing`)
  process.exit(2)
}
const PACKS = join(tmpBase, 'packs')
const CONSUMER = join(tmpBase, 'consumer')
const SCAFFOLDS = join(tmpBase, 'scaffolds')
mkdirSync(PACKS)
console.log(`pack smoke — temp dir ${tmpBase}`)
console.log(`public packages (${publicPkgs.length}): ${[...publicNames].join(', ')}`)

if (BUILD) {
  step('pnpm build')
  if (!mustRun('build', 'pnpm', ['build']).ok) finish()
}

/** Per-package report rows. */
const report = new Map()
const row = (name) => {
  if (!report.has(name)) report.set(name, { files: 0, packed: 0, unpacked: 0, entries: [], issues: 0 })
  return report.get(name)
}
const failFor = (name, msg) => {
  row(name).issues++
  fail(name, msg)
}

/* 1. pack ------------------------------------------------------------------ */
step('pnpm pack (nothing is published)')
const tarballs = new Map()
for (const { dir, pkg } of publicPkgs) {
  const before = new Set(readdirSync(PACKS))
  const r = mustRun(pkg.name, 'pnpm', ['pack', '--pack-destination', PACKS], { cwd: dir })
  const created = readdirSync(PACKS).filter((f) => !before.has(f) && f.endsWith('.tgz'))
  if (!r.ok || created.length !== 1) {
    failFor(pkg.name, `pack did not produce exactly one tarball (${created.join(', ')})`)
    continue
  }
  tarballs.set(pkg.name, join(PACKS, created[0]))
  console.log(`  packed ${pkg.name} → ${created[0]}`)
}

/* 2. inspect tarballs ------------------------------------------------------ */
step('inspect tarballs')
const packedVersions = new Map()
const packedManifests = new Map()
for (const { dir, pkg: srcPkg } of publicPkgs) {
  const name = srcPkg.name
  const file = tarballs.get(name)
  if (!file) continue
  const entries = readTarball(file)
  const r = row(name)
  r.files = entries.size
  r.packed = statSync(file).size
  r.unpacked = [...entries.values()].reduce((n, b) => n + b.length, 0)
  const pkgBuf = entries.get('package.json')
  if (!pkgBuf) {
    failFor(name, 'package.json missing from tarball')
    continue
  }
  const pkg = JSON.parse(pkgBuf.toString('utf8'))
  packedManifests.set(name, pkg)
  packedVersions.set(name, pkg.version)

  // Required files.
  const readme = [...entries.keys()].find((f) => /^readme(\.md)?$/i.test(f))
  if (!readme) failFor(name, 'README missing')
  else {
    const rel = relativeLinks(entries.get(readme).toString('utf8'))
    if (rel.length) failFor(name, `README has relative links (broken on npmjs.com): ${rel.join(', ')}`)
  }
  if (![...entries.keys()].some((f) => /^licen[cs]e(\.md|\.txt)?$/i.test(f))) failFor(name, 'LICENSE missing')
  const need = new Set()
  if (pkg.main) need.add(norm(pkg.main))
  if (pkg.types) need.add(norm(pkg.types))
  for (const t of exportTargets(pkg.exports)) need.add(norm(t))
  const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {})
  for (const b of Object.values(bins)) need.add(norm(b))
  for (const f of need) if (!entries.has(f)) failFor(name, `declared file not shipped: ${f}`)
  for (const b of Object.values(bins)) {
    const content = entries.get(norm(b))?.toString('utf8') ?? ''
    if (!content.startsWith('#!/usr/bin/env node')) failFor(name, `bin ${b} lacks a node shebang`)
  }
  // Every runtime JS entry has its declaration file next to it.
  for (const t of exportTargets(pkg.exports).filter((t) => t.endsWith('.js'))) {
    if (!entries.has(norm(t).replace(/\.js$/, '.d.ts'))) failFor(name, `no .d.ts next to ${t}`)
  }

  // Nothing that should not ship.
  for (const f of entries.keys()) {
    const hit = FORBIDDEN.find(([re]) => re.test(f))
    if (hit) failFor(name, `ships ${hit[1]}: ${f}`)
  }
  // No @internal symbol leaks into the published types (tsconfig.base.json sets stripInternal).
  for (const [f, buf] of entries) {
    if (!f.endsWith('.d.ts')) continue
    const text = buf.toString('utf8')
    const at = text.indexOf('@internal')
    if (at >= 0) failFor(name, `internal symbol leaked into ${f}:${text.slice(0, at).split('\n').length}`)
  }
  // Stale build output: every lib/*.js must come from a source file.
  for (const f of entries.keys()) {
    const m = /^lib\/(.+)\.js$/.exec(f)
    if (!m) continue
    const base = join(dir, 'src', m[1])
    if (!['.ts', '.mts', '.tsx', '.js', '.mjs'].some((ext) => existsSync(base + ext))) {
      failFor(name, `stale build output (no source): ${f}`)
    }
  }

  // Manifest sanity.
  if (pkg.type !== 'module') failFor(name, `"type" is ${pkg.type ?? 'unset'}, expected "module"`)
  if (!pkg.engines?.node || !/>=\s*22/.test(pkg.engines.node)) failFor(name, `engines.node is ${pkg.engines?.node ?? 'unset'}, expected >=22`)
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) failFor(name, '"files" allow-list missing')
  if (!pkg.license) failFor(name, 'license missing')
  if (!pkg.repository) failFor(name, 'repository missing')
  if ('sideEffects' in pkg && typeof pkg.sideEffects !== 'boolean' && !Array.isArray(pkg.sideEffects)) {
    failFor(name, 'sideEffects must be a boolean or an array')
  }
  if (pkg.private) failFor(name, 'packed manifest is private')
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (String(range).startsWith('workspace:')) failFor(name, `${field}.${dep} still uses ${range}`)
      if (privateNames.has(dep)) failFor(name, `${field} depends on private workspace package ${dep}`)
      if (/^(file|link|portal):/.test(String(range))) failFor(name, `${field}.${dep} uses a local protocol (${range})`)
    }
  }
  if (r.packed > MAX_PACKED) failFor(name, `packed size ${r.packed} B exceeds ${MAX_PACKED} B`)
  if (r.unpacked > MAX_UNPACKED) failFor(name, `unpacked size ${r.unpacked} B exceeds ${MAX_UNPACKED} B`)
  r.entries = exportSubpaths(pkg).map((s) => specifier(name, s))
}
// Internal ranges must be satisfied by the versions we just packed.
for (const [name, pkg] of packedManifests) {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (!publicNames.has(dep)) continue
      const v = packedVersions.get(dep)
      if (v && !satisfies(v, range)) failFor(name, `${field}.${dep}@${range} is not satisfied by packed ${dep}@${v}`)
    }
  }
}
console.log(`  inspected ${packedManifests.size} tarballs`)

/* 3. clean consumer ---------------------------------------------------------- */
step('clean consumer project (npm)')
mkdirSync(CONSUMER)
writeFileSync(
  join(CONSUMER, 'package.json'),
  JSON.stringify({ name: 'botmesh-pack-smoke-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2),
)
const install = mustRun('consumer', 'npm', [
  'install',
  '--no-audit',
  '--no-fund',
  '--loglevel=error',
  ...[...tarballs.values()],
  'typescript@5.9.3',
  '@types/node@22',
], { cwd: CONSUMER })
const consumerOk = install.ok
if (consumerOk) {
  const nm = join(CONSUMER, 'node_modules')
  // One copy of each of our packages (no nested duplicates of @botmesh/core).
  const dupes = []
  const walk = (d, depth) => {
    if (depth > 6 || !existsSync(d)) return
    for (const e of readdirSync(d)) {
      if (e === '.bin') continue
      const p = join(d, e)
      if (e.startsWith('@')) {
        walk(p, depth)
        continue
      }
      if (depth > 0 && relative(nm, p).split(sep).slice(-2).join('/') === '@botmesh/core') dupes.push(relative(CONSUMER, p))
      if (existsSync(join(p, 'node_modules'))) walk(join(p, 'node_modules'), depth + 1)
    }
  }
  walk(nm, 0)
  if (dupes.length) fail('consumer', `duplicate @botmesh/core copies: ${dupes.join(', ')}`)
  for (const sdk of ['@anthropic-ai/sdk', 'openai', '@google/generative-ai']) {
    if (existsSync(join(nm, sdk))) fail('consumer', `optional peer ${sdk} got installed`)
  }

  // 3a. every exports subpath imports at runtime.
  const specs = [...report.entries()].flatMap(([, r]) => r.entries)
  writeFileSync(
    join(CONSUMER, 'imports.mjs'),
    `const specs = ${JSON.stringify(specs)}
let bad = 0
for (const s of specs) {
  try { const m = await import(s); console.log('OK', s, Object.keys(m).length) }
  catch (e) { bad++; console.log('FAIL', s, e && e.message) }
}
process.exit(bad ? 1 : 0)
`,
  )
  const imp = run('node', ['imports.mjs'], { cwd: CONSUMER })
  for (const line of imp.out.split('\n')) {
    const m = /^(OK|FAIL) (\S+)(?: (.*))?$/.exec(line.trim())
    if (!m) continue
    const owner = [...report.keys()].find((n) => m[2] === n || m[2].startsWith(`${n}/`))
    if (m[1] === 'FAIL') failFor(owner ?? 'consumer', `runtime import ${m[2]} failed: ${m[3]}`)
    else if (owner) (row(owner).imported ??= []).push(m[2])
  }
  if (!imp.ok && !imp.out.includes('FAIL')) fail('consumer', `imports.mjs crashed\n${imp.out}`)

  // 3b. types, nodenext + bundler.
  mkdirSync(join(CONSUMER, 'src'))
  writeFileSync(join(CONSUMER, 'src', 'consumer.ts'), CONSUMER_TS)
  for (const [mode, mod] of [
    ['nodenext', 'nodenext'],
    ['bundler', 'esnext'],
  ]) {
    for (const skipLibCheck of [true, false]) {
      const cfg = `tsconfig.${mode}${skipLibCheck ? '' : '.libcheck'}.json`
      writeFileSync(
        join(CONSUMER, cfg),
        JSON.stringify({
          compilerOptions: {
            target: 'es2022',
            module: mod,
            moduleResolution: mode,
            strict: true,
            noEmit: true,
            skipLibCheck,
            types: ['node'],
          },
          include: ['src'],
        }),
      )
      const tsc = run('node', [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', cfg], { cwd: CONSUMER })
      // With skipLibCheck off, only our own declarations (and the consumer code) count:
      // third-party .d.ts (Baileys' own typings) are outside this smoke test's control.
      const errors = tsc.out
        .split('\n')
        .filter((l) => /error TS\d+/.test(l))
        .filter((l) => skipLibCheck || /^(src[\\/]|node_modules[\\/](@botmesh|create-botmesh)[\\/])/.test(l))
      if (errors.length) fail('types', `tsc (${mode}, skipLibCheck=${skipLibCheck}):\n    ${errors.join('\n    ')}`)
      else console.log(`  types OK (${mode}, skipLibCheck=${skipLibCheck})`)
    }
  }

  // 3c. runtime scenario + optional peers.
  writeFileSync(join(CONSUMER, 'runtime.mjs'), RUNTIME_MJS)
  const rt = run('node', ['runtime.mjs'], { cwd: CONSUMER, timeout: 60_000 })
  if (!rt.ok || !rt.out.includes('RUNTIME OK')) fail('runtime', rt.out.split('\n').slice(-20).join('\n'))
  else console.log('  runtime scenario OK (createTestBot, aiPlugin+MockAIProvider, SQLiteStore, lazy SDK error)')

  // 3d. bins.
  const binOf = (pkgName, bin) => {
    const pkg = packedManifests.get(pkgName)
    const rel = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.[bin]
    return rel ? join(nm, ...pkgName.split('/'), rel) : undefined
  }
  for (const [pkgName, bin] of [
    ['@botmesh/core', 'botmesh'],
    ['create-botmesh', 'create-botmesh'],
  ]) {
    const shim = join(nm, '.bin', IS_WIN ? `${bin}.cmd` : bin)
    if (!existsSync(shim)) failFor(pkgName, `npm did not link the ${bin} bin`)
    const target = binOf(pkgName, bin)
    if (!target) continue
    const help = run('node', [target, '--help'], { cwd: CONSUMER })
    if (!help.ok || !/Usage/.test(help.out)) failFor(pkgName, `${bin} --help failed:\n${help.out}`)
  }
  const coreBin = binOf('@botmesh/core', 'botmesh')
  if (coreBin) {
    const ver = run('node', [coreBin, '--version'], { cwd: CONSUMER })
    if (!ver.out.includes(packedVersions.get('@botmesh/core'))) failFor('@botmesh/core', `botmesh --version printed ${ver.out.trim()}`)
    writeFileSync(join(CONSUMER, 'devbot.mjs'), DEV_BOT)
    const dev = run('node', [coreBin, 'dev', 'devbot.mjs', '--no-watch', '--no-color'], {
      cwd: CONSUMER,
      input: 'hola\n:quit\n',
      timeout: 60_000,
    })
    if (!dev.ok || !dev.out.includes('PONG-SMOKE')) failFor('@botmesh/core', `botmesh dev did not answer:\n${dev.out}`)
    else console.log('  botmesh dev answered from a defineBot entry')
  }

  /* 4. scaffolds ------------------------------------------------------------ */
  step('create-botmesh templates')
  const createBin = binOf('create-botmesh', 'create-botmesh')
  const helpText = createBin ? run('node', [createBin, '--help'], { cwd: CONSUMER }).out : ''
  const templates = (/one of: ([^\n(]+)/.exec(helpText)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!templates.length) failFor('create-botmesh', 'could not read the template list from --help')
  mkdirSync(SCAFFOLDS)
  // Local registry for the @botmesh scope: scaffolds install their stamped ranges as-is.
  const registry = SCAFFOLD_INSTALL ? await startRegistry() : undefined
  for (const t of templates) {
    const dirName = `bot-${t}`
    const scope = `create-botmesh[${t}]`
    const gen = run('node', [createBin, dirName, '--template', t, '--yes'], { cwd: SCAFFOLDS })
    const proj = join(SCAFFOLDS, dirName)
    if (!gen.ok || !existsSync(join(proj, 'package.json'))) {
      failFor('create-botmesh', `${t}: scaffold failed\n${gen.out}`)
      continue
    }
    const pj = readJson(join(proj, 'package.json'))
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [dep, range] of Object.entries(pj[field] ?? {})) {
        if (!tarballs.has(dep)) continue
        const v = packedVersions.get(dep)
        if (!satisfies(v, range)) failFor('create-botmesh', `${t}: ${dep}@${range} does not resolve to packed ${v}`)
      }
    }
    const jsFiles = []
    const collect = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue
        const p = join(d, e.name)
        if (e.isDirectory()) collect(p)
        else if (/\.m?js$/.test(e.name)) jsFiles.push(p)
      }
    }
    collect(proj)
    for (const f of jsFiles) {
      const c = run('node', ['--check', f])
      if (!c.ok) failFor('create-botmesh', `${t}: node --check ${relative(proj, f)}\n${c.out}`)
    }
    let status = `${jsFiles.length} js checked`
    if (registry) {
      // The scaffold's package.json is not touched: npm resolves its @botmesh ranges
      // against the packed versions served by the local registry.
      writeFileSync(join(proj, '.npmrc'), `@botmesh:registry=${registry.url}\n`)
      const inst = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--prefer-online'], { cwd: proj })
      if (!inst.ok) {
        failFor('create-botmesh', `${t}: npm install failed\n${inst.out.split('\n').slice(-15).join('\n')}`)
        continue
      }
      for (const dep of Object.keys(pj.dependencies ?? {})) {
        if (!tarballs.has(dep)) continue
        const got = readJson(join(proj, 'node_modules', ...dep.split('/'), 'package.json')).version
        if (got !== packedVersions.get(dep)) failFor('create-botmesh', `${t}: npm installed ${dep}@${got}, expected packed ${packedVersions.get(dep)}`)
      }
      const entry = pj.scripts?.dev?.match(/botmesh dev (\S+)/)?.[1] ?? 'src/bot.js'
      const devBin = join(proj, 'node_modules', '@botmesh', 'core', ...String(packedManifests.get('@botmesh/core')?.bin?.['botmesh'] ?? 'lib/dev/bin.js').split('/'))
      const dev = run('node', [devBin, 'dev', entry, '--no-watch', '--no-color'], { cwd: proj, input: ':quit\n', timeout: 60_000 })
      if (!dev.ok || !dev.out.includes('terminal simulator')) failFor('create-botmesh', `${t}: botmesh dev ${entry} failed\n${dev.out}`)
      else status += ', installed, boots in botmesh dev'
    }
    console.log(`  ${scope}: ${status}`)
  }
  row('create-botmesh').templates = templates.length
  registry?.stop()
}

finish()

/* -------------------------------------------------------------------------- */

/** Start scripts/smoke/registry.mjs over the packed @botmesh tarballs. */
async function startRegistry() {
  const list = [...tarballs]
    .filter(([n]) => n.startsWith('@botmesh/') && packedManifests.has(n))
    .map(([n, file]) => ({ manifest: packedManifests.get(n), file }))
  const listFile = join(tmpBase, 'registry.json')
  writeFileSync(listFile, JSON.stringify(list))
  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'smoke', 'registry.mjs'), listFile], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise((res, rej) => {
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      const m = /LISTENING (\d+)/.exec(buf)
      if (m) res(Number(m[1]))
    })
    child.once('exit', (code) => rej(new Error(`local registry exited (${code})`)))
  })
  console.log(`  local @botmesh registry on 127.0.0.1:${port} (${list.length} packages)`)
  stopRegistry = () => child.kill()
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() }
}

function finish() {
  stopRegistry()
  step('report')
  const kb = (n) => `${(n / 1024).toFixed(1)} kB`
  const rows = [['package', 'version', 'files', 'packed', 'unpacked', 'entry points', 'result']]
  for (const { pkg } of publicPkgs) {
    const r = report.get(pkg.name) ?? { files: 0, packed: 0, unpacked: 0, entries: [], issues: 0 }
    const entries = r.entries.map((e) => (e === pkg.name ? '.' : e.slice(pkg.name.length + 1))).join(' ')
    const extra = r.templates ? ` +${r.templates} templates` : ''
    rows.push([pkg.name, packedVersions.get(pkg.name) ?? pkg.version, String(r.files), kb(r.packed), kb(r.unpacked), entries + extra, r.issues ? `FAIL (${r.issues})` : 'ok'])
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '))
  if (KEEP) console.log(`\nkept ${tmpBase}`)
  else rmSync(tmpBase, { recursive: true, force: true, maxRetries: 3 })
  if (failures.length) {
    console.log(`\n${failures.length} problem(s):`)
    for (const f of failures) console.log(`- ${f.split('\n')[0]}`)
    process.exit(1)
  }
  console.log('\npack smoke OK — nothing was published')
  process.exit(0)
}
