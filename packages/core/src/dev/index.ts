/**
 * `@botmesh/core/dev` — the `botmesh dev` terminal chat simulator as a library.
 *
 * Most people only use the CLI (`botmesh dev src/bot.js`) plus `defineBot` from
 * `@botmesh/core`. This subpath exposes the building blocks for custom tooling:
 * {@link DevSession} (the I/O-free simulator engine), {@link DevProvider} (the
 * in-memory transport it injects), the pure renderers/parsers, the module
 * loader with hot-reload hooks, and {@link runCli} itself.
 *
 * Zero extra dependencies: `node:readline`, `node:fs` `watch`, `node:module` hooks.
 *
 * @example
 * ```ts
 * import { DevSession } from '@botmesh/core/dev'
 *
 * const session = new DevSession({ load: () => import('./bot.js'), write: (t) => process.stdout.write(t) })
 * await session.start()
 * await session.handleLine('hola')
 * ```
 */

export { defineBot, isBotFactory, isMainModule } from './defineBot.js'
export type { BotFactory } from './defineBot.js'

export { DevSession, guessMimeType } from './session.js'
export type { DevSessionOptions, DevIdentity, DevLineResult, DevHaltReason } from './session.js'

export { DevProvider, DEV_BOT_ID } from './DevProvider.js'
export type { DevOutbound, DevSender, DevMediaInput, DevMediaKind, DevPollVoteInput } from './DevProvider.js'

export { renderOutbound, describeMedia, formatMessage, formatBytes } from './render.js'
export type { RenderedOutbound, DevChoice, DevInteractiveKind } from './render.js'

export { parseDevInput, DEV_HELP } from './commands.js'
export type { DevCommand } from './commands.js'

export {
  DevEntryError,
  resolveBotFactory,
  createEntryLoader,
  installReloadHooks,
  checkTypeScriptSupport,
  explainLoadError,
  isTypeScriptEntry,
} from './loader.js'
export type { EntryLoaderOptions, ReloadHooksMode } from './loader.js'

export { propagateVersion, RELOAD_PARAM } from './reloadHooks.js'
export type { ResolveContextLike, ResolveResultLike } from './reloadHooks.js'

export { watchForChanges, isReloadRelevant } from './watch.js'
export type { WatchOptions, WatchFunction, WatchHandle, ReloadWatcher } from './watch.js'

export { runCli, parseCliArgs, CLI_USAGE, DevUsageError } from './cli.js'
export type { CliIO, DevCliOptions } from './cli.js'
