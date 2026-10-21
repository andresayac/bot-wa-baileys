/**
 * `defineBot` — the factory pattern that lets ONE bot module run both on a real
 * transport (`npm start`) and inside the `botmesh dev` terminal simulator.
 *
 * A bot module default-exports a factory that receives the transport provider
 * and returns the configured {@link Bot}. Whoever runs the module decides which
 * provider to inject:
 *  - `npm start` (`node src/bot.js`) builds the real provider in an
 *    {@link isMainModule} block at the bottom of the file;
 *  - `botmesh dev src/bot.js` imports the module, ignores that block, and calls
 *    the factory with a simulated in-memory provider (no phone, no ban risk).
 *
 * @example
 * ```js
 * import { Bot, defineBot, isMainModule } from '@botmesh/core'
 * import { BaileysProvider } from '@botmesh/baileys'
 *
 * const createBot = defineBot((provider) => {
 *   const bot = new Bot({ provider })
 *   bot.when('hola', async (ctx) => await ctx.reply('¡Hola! 👋'))
 *   return bot
 * })
 * export default createBot
 *
 * if (isMainModule(import.meta)) {
 *   const bot = await createBot(new BaileysProvider({ session: 'my-bot' }))
 *   await bot.start()
 * }
 * ```
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Bot } from '../core/Bot.js'
import type { IProvider } from '../core/provider.js'

/**
 * A bot factory: receives the transport provider to use and returns the
 * configured (not yet started) {@link Bot}. It may be async (e.g. to load data
 * before registering handlers). It must pass `provider` to `new Bot({ provider })`
 * and must NOT call `bot.start()` — the caller (your main block, or `botmesh dev`)
 * starts it.
 */
export type BotFactory = (provider: IProvider) => Bot | Promise<Bot>

/**
 * Brand stored on factories created by {@link defineBot}. A global-registry
 * symbol, so it is recognised even when the bot module and the `botmesh` CLI
 * resolve two different copies of `@botmesh/core`.
 */
const BOT_FACTORY = Symbol.for('@botmesh/core.botFactory')

/**
 * Declare a bot factory. Returns the SAME function (typed and branded), so it
 * can be default-exported for `botmesh dev` and called directly with a real
 * provider for production.
 *
 * @param factory `(provider) => Bot` — build your bot around the given provider.
 * @throws {TypeError} when `factory` is not a function.
 */
export function defineBot<F extends BotFactory>(factory: F): F {
  if (typeof factory !== 'function') {
    throw new TypeError(
      'defineBot expects a factory function: defineBot((provider) => { const bot = new Bot({ provider }); return bot })',
    )
  }
  if (!Object.prototype.hasOwnProperty.call(factory, BOT_FACTORY)) {
    Object.defineProperty(factory, BOT_FACTORY, { value: true, enumerable: false })
  }
  return factory
}

/** True when `value` is a factory created with {@link defineBot}. */
export function isBotFactory(value: unknown): value is BotFactory {
  return typeof value === 'function' && (value as unknown as Record<symbol, unknown>)[BOT_FACTORY] === true
}

/**
 * Is the module that owns `meta` (pass `import.meta`) the process entry point,
 * i.e. was it started with `node <file>` rather than imported? Use it to guard
 * the "connect the real provider" block so `botmesh dev` (and your tests) can
 * import the factory without connecting to a real transport.
 *
 * Uses `import.meta.main` when the runtime provides it (Node >= 22.18 / 24.2)
 * and otherwise compares the module's real path with `process.argv[1]`.
 *
 * Caveat: process managers that `import()` your file from their own wrapper
 * (e.g. pm2 in ESM mode) make this `false`; point them at a tiny start file that
 * imports the factory and starts it instead.
 *
 * @param meta `import.meta` of the calling module.
 */
export function isMainModule(meta: { url: string; main?: boolean }): boolean {
  if (typeof meta.main === 'boolean') return meta.main
  const entry = process.argv[1]
  if (!entry || !meta.url.startsWith('file:')) return false
  try {
    return samePath(realpath(resolve(entry)), realpath(fileURLToPath(meta.url)))
  } catch {
    return false
  }
}

/** Canonical path; the native variant also normalises Windows drive-letter casing. */
function realpath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Path equality; case-insensitive on Windows (`c:\bot.js` and `C:\bot.js` are one file). */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
