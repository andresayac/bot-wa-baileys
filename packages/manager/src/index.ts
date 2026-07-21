/**
 * @bot-wa/manager — multi-bot orchestrator for `@bot-wa/core`.
 *
 * - {@link BotManager}: registry, running-state tracking, lifecycle
 *   (`start`/`stop`/`startAll`/`stopAll`), events.
 * - {@link createManagerApi}: optional zero-dep `node:http` handler over a manager.
 */

export { BotManager } from './BotManager.js'
export type {
  AddBotOptions,
  BotEntry,
  BotManagerOptions,
  BotStatus,
  ManageableBot,
  ManagerErrorInfo,
  ManagerEventMap,
  StartStopOutcome,
} from './BotManager.js'
export { createManagerApi } from './http.js'
export type { ManagerApiHandler, ManagerApiOptions } from './http.js'
