/**
 * Loading the developer's bot module for `botmesh dev`: cache-busting
 * re-imports, the reload hooks, TypeScript support checks and turning a module
 * namespace into a {@link BotFactory} with actionable errors.
 */

import * as nodeModule from 'node:module'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { BotFactory } from './defineBot.js'
import { RELOAD_PARAM, resolveSync } from './reloadHooks.js'

/**
 * The bot entry could not be turned into a running simulator bot (wrong export
 * shape, factory returned something else, unsupported TypeScript setup, ...).
 * The message is written for the developer and says how to fix it.
 */
export class DevEntryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DevEntryError'
  }
}

const FACTORY_HINT =
  'Default-export a bot factory:\n' +
  '  export default defineBot((provider) => {\n' +
  '    const bot = new Bot({ provider })\n' +
  '    // ...handlers and flows\n' +
  '    return bot\n' +
  '  })'

function looksLikeBot(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    typeof (value as { start?: unknown }).start === 'function' &&
    typeof (value as { when?: unknown }).when === 'function'
}

/**
 * Extract the bot factory from what the entry module exported: either the
 * factory itself or a module namespace whose `default` export is a function.
 *
 * @throws {DevEntryError} with a fix-it hint for any other shape (no default
 * export, a `Bot` instance instead of a factory, ...).
 */
export function resolveBotFactory(loaded: unknown): BotFactory {
  if (typeof loaded === 'function') return loaded as BotFactory
  const exported = typeof loaded === 'object' && loaded !== null ? (loaded as { default?: unknown }).default : undefined
  if (typeof exported === 'function') return exported as BotFactory
  if (looksLikeBot(exported)) {
    throw new DevEntryError(
      'The entry exports a Bot instance, but botmesh dev needs a factory so it can inject the simulator provider.\n' + FACTORY_HINT,
    )
  }
  throw new DevEntryError(`The entry has no default-exported bot factory.\n${FACTORY_HINT}`)
}

/** Options for {@link createEntryLoader}. */
export interface EntryLoaderOptions {
  /** Module importer; defaults to native `import()`. Injected by tests. */
  importModule?: (url: string) => Promise<unknown>
}

/**
 * Build a loader that (re-)imports `entryPath` with an increasing
 * `?botwa_v=<n>` query, so every call evaluates a fresh copy of the module
 * (and, with {@link installReloadHooks}, of its relative imports).
 */
export function createEntryLoader(entryPath: string, options: EntryLoaderOptions = {}): () => Promise<unknown> {
  const base = pathToFileURL(entryPath).href
  const importModule = options.importModule ?? ((url: string) => import(url))
  let generation = 0
  return () => importModule(`${base}?${RELOAD_PARAM}=${++generation}`)
}

/** How hot reload re-versions local modules in this process. */
export type ReloadHooksMode = 'sync' | 'async' | 'none'

let hooksMode: ReloadHooksMode | undefined

/**
 * Install the reload resolve hooks once per process: `module.registerHooks`
 * (in-thread) when available, else `module.register` (off-thread). Returns
 * `'none'` when neither works — then only the entry file itself is reloaded.
 */
export function installReloadHooks(): ReloadHooksMode {
  if (hooksMode) return hooksMode
  const api = nodeModule as unknown as {
    registerHooks?: (hooks: { resolve: typeof resolveSync }) => unknown
    register?: (specifier: string | URL, parentURL?: string | URL) => void
  }
  try {
    if (typeof api.registerHooks === 'function') {
      api.registerHooks({ resolve: resolveSync })
      return (hooksMode = 'sync')
    }
    if (typeof api.register === 'function') {
      api.register(new URL('./reloadHooks.js', import.meta.url))
      return (hooksMode = 'async')
    }
  } catch {
    // Fall through: reload still works for the entry module itself.
  }
  return (hooksMode = 'none')
}

const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts'])

/** True for `.ts` / `.mts` / `.cts` entries. */
export function isTypeScriptEntry(entry: string): boolean {
  return TS_EXTENSIONS.has(extname(entry).toLowerCase())
}

function parseVersion(version: string): [number, number] {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  return [major, minor]
}

/**
 * Can this Node run `entry` directly? JavaScript always can; TypeScript needs
 * Node's built-in type stripping (`process.features.typescript`, on by default
 * since Node 22.18 / 23.6, behind `--experimental-strip-types` since 22.6).
 *
 * @returns `undefined` when the entry can run, otherwise a multi-line hint
 * explaining how to enable TypeScript support.
 */
export function checkTypeScriptSupport(entry: string, runtime: { typescript?: unknown; nodeVersion: string }): string | undefined {
  const ext = extname(entry).toLowerCase()
  if (ext === '.tsx' || ext === '.jsx') {
    return `botmesh dev: "${entry}" is a ${ext === '.tsx' ? 'TSX' : 'JSX'} file; Node cannot run JSX/TSX directly. ` +
      'Compile it to JavaScript first and point botmesh dev at the .js output.'
  }
  if (!TS_EXTENSIONS.has(ext) || runtime.typescript) return undefined
  const [major, minor] = parseVersion(runtime.nodeVersion)
  const hasFlag = major > 22 || (major === 22 && minor >= 6)
  const lines = [
    `botmesh dev: "${entry}" is a TypeScript entry, but this Node.js (v${runtime.nodeVersion.replace(/^v/, '')}) is not stripping types.`,
    '  • Upgrade to Node.js >= 22.18 (or >= 23.6): built-in type stripping is on by default.',
  ]
  if (hasFlag) lines.push(`  • Or enable it for this run: NODE_OPTIONS=--experimental-strip-types botmesh dev ${entry}`)
  lines.push(
    '  • Or compile to JavaScript first and run botmesh dev on the .js output.',
    'Note: type stripping needs explicit .ts extensions in relative imports and `import type` for type-only imports.',
  )
  return lines.join('\n')
}

/**
 * Add a TypeScript-specific hint to module-loading errors of a TS entry (the
 * classic one: `import './flows.js'` pointing at `flows.ts`). Other errors are
 * returned unchanged.
 */
export function explainLoadError(error: unknown, entry: string): unknown {
  if (!isTypeScriptEntry(entry) || !(error instanceof Error)) return error
  const code = (error as Error & { code?: unknown }).code
  if (code === 'ERR_MODULE_NOT_FOUND') {
    return new DevEntryError(
      `${error.message}\nHint: with Node's type stripping, relative imports must use the real file name with its .ts extension ` +
        "(import './flows.ts', not './flows.js').",
      { cause: error },
    )
  }
  if (code === 'ERR_UNKNOWN_FILE_EXTENSION' || code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
    return new DevEntryError(
      `${error.message}\nHint: Node only strips types from your own .ts files (not from node_modules); ` +
        'make sure type stripping is enabled (Node >= 22.18, or NODE_OPTIONS=--experimental-strip-types).',
      { cause: error },
    )
  }
  return error
}
