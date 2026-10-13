/**
 * The `bot-wa` command line: `bot-wa dev <entry>` runs the terminal chat
 * simulator with hot reload.
 *
 * {@link runCli} is the whole program with its I/O injected (streams, module
 * importer, watcher, env loader), so it is testable without a TTY; `bin.ts` is
 * the 5-line executable that calls it with `process.*`.
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline'

import {
  checkTypeScriptSupport,
  createEntryLoader,
  explainLoadError,
  installReloadHooks,
  resolveBotFactory,
  type ReloadHooksMode,
} from './loader.js'
import { DevSession } from './session.js'
import { watchForChanges, type ReloadWatcher } from './watch.js'

/** Bad command-line usage; `runCli` prints it with the usage text and exits 2. */
export class DevUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevUsageError'
  }
}

/** Parsed `bot-wa` arguments. */
export interface DevCliOptions {
  command: 'dev' | 'help' | 'version'
  /** Bot module path (relative to cwd), for `dev`. */
  entry?: string
  /** `--user`: initial simulated sender id. */
  user?: string
  /** `--name`: initial display name. */
  name?: string
  /** `--group`: start inside this group chat. */
  group?: string
  /** Hot reload on file changes (`--no-watch` turns it off). */
  watch: boolean
  /** `--watch <dir>`: directory to watch; default the entry's folder. */
  watchDir?: string
  /** `--env-file <path>` (repeatable): env files loaded before importing the bot. */
  envFiles: string[]
  /** `--color` / `--no-color`; `undefined` = auto (TTY and no `NO_COLOR`). */
  color?: boolean
}

/** Everything `runCli` touches outside of itself. Only the streams are required. */
export interface CliIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
  stderr: NodeJS.WritableStream
  /** Working directory for relative paths. Default `process.cwd()`. */
  cwd?: string
  /** Environment to read (`NO_COLOR`) and mark with `BOT_WA_DEV=1`. Default `process.env`. */
  env?: Record<string, string | undefined>
  /** Module importer for the entry. Default native `import()`. */
  importModule?: (url: string) => Promise<unknown>
  /** Install the hot-reload resolve hooks (default `true`). */
  installHooks?: boolean
  /** File watcher factory. Default {@link watchForChanges}. */
  watch?: (dir: string, onChange: (files: string[]) => void) => ReloadWatcher
  /** Env-file loader. Default `process.loadEnvFile`. */
  loadEnvFile?: (path: string) => void
  /** Runtime features (TypeScript check). Default `process.features`. */
  features?: { typescript?: unknown }
  /** Runtime version (TypeScript hint). Default `process.versions.node`. */
  nodeVersion?: string
}

/** `bot-wa --help` text. */
export const CLI_USAGE = [
  'Usage: bot-wa dev <entry> [options]',
  '',
  'Chat with your bot in the terminal: no phone, no real transport, no ban risk.',
  'Hot reload: saving a file in the entry folder restarts the bot with the new code.',
  '',
  '<entry> must default-export a bot factory:',
  "  import { Bot, defineBot } from '@bot-wa/core'",
  '  export default defineBot((provider) => {',
  '    const bot = new Bot({ provider })',
  "    bot.when('hola', (ctx) => ctx.reply('¡Hola!'))",
  '    return bot',
  '  })',
  '',
  'Options:',
  '  --user <id>          simulated sender id (default: user)',
  '  --name <name>        simulated display name (default: Dev User)',
  '  --group <id>         start inside group chat <id>',
  '  --env-file <path>    load environment variables from a file (repeatable)',
  "  --watch <dir>        folder to watch for hot reload (default: the entry's folder)",
  '  --no-watch           disable hot reload (type :reload to re-import)',
  '  --color, --no-color  force ANSI colours on or off (default: auto)',
  '  -h, --help           show this help',
  '  -v, --version        print the version',
  '',
  'Inside the simulator type :help for commands (:as, :group, :media, :click, :state, :reset, :quit).',
  'TypeScript entries use Node type stripping (Node >= 22.18 / 23.6, or NODE_OPTIONS=--experimental-strip-types).',
].join('\n')

/**
 * Parse `bot-wa` arguments (without `node` and the script). Pure.
 * @throws {DevUsageError} on unknown commands/options or a missing entry.
 */
export function parseCliArgs(argv: readonly string[]): DevCliOptions {
  const out: DevCliOptions = { command: 'help', watch: true, envFiles: [] }
  const first = argv[0]
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') return out
  if (first === '--version' || first === '-v') return { ...out, command: 'version' }
  if (first !== 'dev') throw new DevUsageError(`Unknown command: ${first}`)
  out.command = 'dev'

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) throw new DevUsageError(`${flag} needs a value`)
      i++
      return next
    }
    switch (flag) {
      case '-h':
      case '--help':
        return { ...out, command: 'help' }
      case '--user': out.user = value(); break
      case '--name': out.name = value(); break
      case '--group': out.group = value(); break
      case '--env-file': out.envFiles.push(value()); break
      case '--watch': out.watch = true; out.watchDir = value(); break
      case '--no-watch': out.watch = false; break
      case '--color': out.color = true; break
      case '--no-color': out.color = false; break
      default:
        if (flag.startsWith('-') && flag.length > 1) throw new DevUsageError(`Unknown option: ${arg}`)
        if (out.entry !== undefined) throw new DevUsageError(`Unexpected argument: ${arg}`)
        out.entry = arg
    }
  }
  if (!out.entry) throw new DevUsageError('bot-wa dev needs an entry file, e.g. bot-wa dev src/bot.js')
  return out
}

/** With piped input, how long one line may wait for the bot's reaction (slow AI calls included). */
const PIPED_MAX_SETTLE_MS = 30_000

const HALT_NOTICE =
  '• stopping: bot-wa dev will not call a bot factory that builds its own provider again — each call could open ' +
  'another real connection. Exiting closes anything it left open.\n'

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run the `bot-wa` CLI. Resolves with the process exit code: `0` success,
 * `1` runtime failure (missing entry, unsupported TypeScript, load failure
 * without watch, an entry that ran without exporting a factory, a factory that
 * builds its own provider), `2` usage error.
 */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  let options: DevCliOptions
  try {
    options = parseCliArgs(argv)
  } catch (error) {
    if (!(error instanceof DevUsageError)) throw error
    io.stderr.write(`bot-wa: ${error.message}\n\n${CLI_USAGE}\n`)
    return 2
  }
  if (options.command === 'help') {
    io.stdout.write(`${CLI_USAGE}\n`)
    return 0
  }
  if (options.command === 'version') {
    io.stdout.write(`bot-wa ${readVersion()}\n`)
    return 0
  }
  return runDev(options, options.entry!, io)
}

async function runDev(options: DevCliOptions, entryArg: string, io: CliIO): Promise<number> {
  const cwd = io.cwd ?? process.cwd()
  const env = io.env ?? process.env
  const entry = resolvePath(cwd, entryArg)
  if (!isFile(entry)) {
    io.stderr.write(`bot-wa dev: entry not found: ${entry}\n`)
    return 1
  }
  const tsHint = checkTypeScriptSupport(entryArg, {
    typescript: (io.features ?? (process.features as { typescript?: unknown })).typescript,
    nodeVersion: io.nodeVersion ?? process.versions.node,
  })
  if (tsHint) {
    io.stderr.write(`${tsHint}\n`)
    return 1
  }

  const notes: string[] = []
  const loadEnvFile = io.loadEnvFile ?? ((path: string) => process.loadEnvFile(path))
  for (const file of options.envFiles) {
    const path = resolvePath(cwd, file)
    if (!isFile(path)) {
      notes.push(`${file} not found — continuing without it`)
      continue
    }
    try {
      loadEnvFile(path)
    } catch (error) {
      notes.push(`could not load ${file}: ${errorMessage(error)}`)
    }
  }
  // Lets bot code detect the simulator (e.g. to skip real side effects).
  env.BOT_WA_DEV = '1'

  const hooks: ReloadHooksMode = io.installHooks === false ? 'none' : installReloadHooks()
  const loadEntry = createEntryLoader(entry, { importModule: io.importModule })
  // Set when the module was imported (its top-level code RAN) but exports no
  // factory: typically an old-style bot that starts a real provider on import.
  let ranWithoutFactory = false
  const load = async () => {
    let loaded: unknown
    try {
      loaded = await loadEntry()
    } catch (error) {
      throw explainLoadError(error, entry)
    }
    try {
      resolveBotFactory(loaded)
      ranWithoutFactory = false
    } catch {
      ranWithoutFactory = true
    }
    return loaded
  }

  const tty = Boolean(io.stdin.isTTY && io.stdout.isTTY)
  const color = options.color ?? (Boolean(io.stdout.isTTY) && !env.NO_COLOR)
  let rl: Interface | undefined
  let prompting = false
  // In a terminal, async bot output must not garble the line being typed:
  // clear it, print, then redraw the prompt with the user's partial input.
  const write = (text: string) => {
    if (tty && rl && prompting) {
      clearLine(io.stdout, 0)
      cursorTo(io.stdout, 0)
      io.stdout.write(text)
      rl.prompt(true)
    } else {
      io.stdout.write(text)
    }
  }

  // Set once the line reader exists; a halt during start() is handled below.
  let onHaltWhileRunning: (() => void) | undefined
  const session = new DevSession({
    load,
    write,
    user: options.user,
    name: options.name,
    group: options.group,
    cwd,
    color,
    // Piped input is not echoed by a terminal and arrives all at once: echo it
    // and wait for each reaction (even a slow AI call) so the transcript reads
    // in order and no reply is skipped.
    echo: !tty,
    settleMs: tty ? 0 : 200,
    maxSettleMs: tty ? undefined : PIPED_MAX_SETTLE_MS,
    onHalt: () => onHaltWhileRunning?.(),
  })

  const rel = (path: string) => relative(cwd, path) || '.'
  const watchDir = options.watchDir ? resolvePath(cwd, options.watchDir) : dirname(entry)
  const identity = session.identity
  write([
    'bot-wa dev — terminal simulator · nothing is sent to a real chat',
    `  entry  ${rel(entry)}`,
    options.watch
      ? `  watch  ${rel(watchDir)} (hot reload on save${hooks === 'none' ? '; only the entry file is re-imported' : ''})`
      : '  watch  off (type :reload to re-import)',
    `  you    "${identity.user}" in ${identity.group ? `group "${identity.group}"` : 'a DM'} · :as / :group to switch · :help for commands`,
    '',
    '',
  ].join('\n'))
  for (const note of notes) write(`• ${note}\n`)

  let watcher: ReloadWatcher | undefined
  if (options.watch) {
    try {
      watcher = (io.watch ?? watchForChanges)(watchDir, (files) => {
        const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? ` +${files.length - 3} more` : '')
        void session.reload(`${shown} changed`)
      })
    } catch (error) {
      write(`• hot reload unavailable (${errorMessage(error)}) — type :reload after editing\n`)
    }
  }

  const started = await session.start()
  if (!started && (ranWithoutFactory || session.halted || !options.watch)) {
    if (session.halted) {
      write(HALT_NOTICE)
    } else if (ranWithoutFactory) {
      write(
        '• stopping: the entry ran but exports no bot factory. If it builds and starts a real provider when ' +
          'imported, that connection is open now — exiting closes it. Export defineBot((provider) => ...) and ' +
          'start the real provider only inside if (isMainModule(import.meta)) { ... }.\n',
      )
    }
    watcher?.close()
    await session.stop()
    return 1
  }
  if (!started) write('• fix the error and save — the simulator reloads automatically\n')

  const lineReader = createInterface({ input: io.stdin, output: tty ? io.stdout : undefined, terminal: tty, prompt: session.prompt() })
  rl = lineReader
  return new Promise<number>((resolveExit) => {
    let closing = false
    // A reload (save, :reload, :reset) whose factory builds its own provider:
    // the session refuses to call it again, so there is nothing left to run.
    onHaltWhileRunning = () => {
      write(HALT_NOTICE)
      lineReader.close()
    }
    lineReader.on('line', (line) => {
      void session.handleLine(line).then((result) => {
        if (result === 'quit') lineReader.close()
        else if (tty && !closing) {
          lineReader.setPrompt(session.prompt())
          lineReader.prompt()
        }
      })
    })
    lineReader.on('SIGINT', () => lineReader.close())
    lineReader.on('close', () => {
      closing = true
      prompting = false
      watcher?.close()
      // Piped input ends right after its last line; let a reply still in flight
      // (e.g. an AI call) arrive before stopping the bot. In a terminal, quitting
      // (:quit, Ctrl+C, Ctrl+D) is immediate.
      void (tty ? session.idle() : session.drain())
        .then(() => session.stop())
        .then(() => resolveExit(session.halted ? 1 : 0), () => resolveExit(1))
    })
    if (tty) {
      prompting = true
      lineReader.prompt()
    }
  })
}
