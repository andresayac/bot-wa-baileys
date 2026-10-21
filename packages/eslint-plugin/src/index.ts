/**
 * eslint-plugin-botmesh — static lint rules for @botmesh bots (FEATURES.md #40).
 *
 * Complements the runtime `bot.lint()` / `lintFlows()` (broken gotos,
 * unreachable steps, duplicate triggers…) with source-level checks that need
 * no running bot.
 *
 * @example
 * ```js
 * // eslint.config.js
 * import botWa from 'eslint-plugin-botmesh'
 *
 * export default [
 *   botWa.configs.recommended,
 *   // or pick rules:
 *   { plugins: { 'botmesh': botWa }, rules: { 'botmesh/require-timeout-on-ask': ['error', { methods: ['ask', 'choose'] }] } },
 * ]
 * ```
 */

import type { ESLint, Linter, Rule } from 'eslint'

import { noAsyncPluginInstall } from './rules/noAsyncPluginInstall.js'
import { noAwaitRuntimeEnter } from './rules/noAwaitRuntimeEnter.js'
import { noEmptyTrigger } from './rules/noEmptyTrigger.js'
import { noV1Api } from './rules/noV1Api.js'
import { preferCtxUser } from './rules/preferCtxUser.js'
import { requireTimeoutOnAsk } from './rules/requireTimeoutOnAsk.js'

/** Every rule of the plugin, by name (without the `botmesh/` prefix). */
export const rules: Record<string, Rule.RuleModule> = {
  'no-v1-api': noV1Api,
  'no-await-runtime-enter': noAwaitRuntimeEnter,
  'no-async-plugin-install': noAsyncPluginInstall,
  'no-empty-trigger': noEmptyTrigger,
  'require-timeout-on-ask': requireTimeoutOnAsk,
  'prefer-ctx-user-over-global-state': preferCtxUser,
}

/** Plugin namespace used in rule ids (`botmesh/<rule>`). */
export const PLUGIN_NAMESPACE = 'botmesh'

/** The plugin's flat configs (a type alias, so it fits ESLint's `Record<string, Config>`). */
export type BotWaConfigs = {
  /** Problems as errors, style/robustness rules as warnings. */
  recommended: Linter.Config
  /** Every rule as an error; `require-timeout-on-ask` also checks waitText/waitMedia/choose/waitAny. */
  strict: Linter.Config
}

/** The plugin object (`meta`, `rules`, `configs`) — the default export. */
export interface BotWaPlugin extends ESLint.Plugin {
  meta: { name: string; version: string; namespace: string }
  rules: Record<string, Rule.RuleModule>
  configs: BotWaConfigs
}

const plugin = {
  meta: { name: 'eslint-plugin-botmesh', version: '0.1.0', namespace: PLUGIN_NAMESPACE },
  rules,
  configs: {} as BotWaConfigs,
} satisfies BotWaPlugin

plugin.configs.recommended = {
  name: 'botmesh/recommended',
  plugins: { [PLUGIN_NAMESPACE]: plugin },
  rules: {
    'botmesh/no-v1-api': 'error',
    'botmesh/no-await-runtime-enter': 'error',
    'botmesh/no-async-plugin-install': 'error',
    'botmesh/no-empty-trigger': 'error',
    'botmesh/require-timeout-on-ask': 'warn',
    'botmesh/prefer-ctx-user-over-global-state': 'warn',
  },
}

plugin.configs.strict = {
  name: 'botmesh/strict',
  plugins: { [PLUGIN_NAMESPACE]: plugin },
  rules: {
    'botmesh/no-v1-api': 'error',
    'botmesh/no-await-runtime-enter': 'error',
    'botmesh/no-async-plugin-install': 'error',
    'botmesh/no-empty-trigger': 'error',
    'botmesh/require-timeout-on-ask': ['error', { methods: ['ask', 'waitText', 'waitMedia', 'choose', 'waitAny'] }],
    'botmesh/prefer-ctx-user-over-global-state': 'error',
  },
}

export const configs: BotWaConfigs = plugin.configs

export { noAsyncPluginInstall, noAwaitRuntimeEnter, noEmptyTrigger, noV1Api, preferCtxUser, requireTimeoutOnAsk }

const botWa: BotWaPlugin = plugin
export default botWa
