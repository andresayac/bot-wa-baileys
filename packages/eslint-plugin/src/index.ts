/**
 * eslint-plugin-bot-wa — static lint rules for @bot-wa bots (FEATURES.md #40).
 *
 * Complements the runtime `bot.lint()` / `lintFlows()` (broken gotos,
 * unreachable steps, duplicate triggers…) with source-level checks that need
 * no running bot.
 *
 * @example
 * ```js
 * // eslint.config.js
 * import botWa from 'eslint-plugin-bot-wa'
 *
 * export default [
 *   botWa.configs.recommended,
 *   // or pick rules:
 *   { plugins: { 'bot-wa': botWa }, rules: { 'bot-wa/require-timeout-on-ask': ['error', { methods: ['ask', 'choose'] }] } },
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

/** Every rule of the plugin, by name (without the `bot-wa/` prefix). */
export const rules: Record<string, Rule.RuleModule> = {
  'no-v1-api': noV1Api,
  'no-await-runtime-enter': noAwaitRuntimeEnter,
  'no-async-plugin-install': noAsyncPluginInstall,
  'no-empty-trigger': noEmptyTrigger,
  'require-timeout-on-ask': requireTimeoutOnAsk,
  'prefer-ctx-user-over-global-state': preferCtxUser,
}

/** Plugin namespace used in rule ids (`bot-wa/<rule>`). */
export const PLUGIN_NAMESPACE = 'bot-wa'

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
  meta: { name: 'eslint-plugin-bot-wa', version: '0.1.0', namespace: PLUGIN_NAMESPACE },
  rules,
  configs: {} as BotWaConfigs,
} satisfies BotWaPlugin

plugin.configs.recommended = {
  name: 'bot-wa/recommended',
  plugins: { [PLUGIN_NAMESPACE]: plugin },
  rules: {
    'bot-wa/no-v1-api': 'error',
    'bot-wa/no-await-runtime-enter': 'error',
    'bot-wa/no-async-plugin-install': 'error',
    'bot-wa/no-empty-trigger': 'error',
    'bot-wa/require-timeout-on-ask': 'warn',
    'bot-wa/prefer-ctx-user-over-global-state': 'warn',
  },
}

plugin.configs.strict = {
  name: 'bot-wa/strict',
  plugins: { [PLUGIN_NAMESPACE]: plugin },
  rules: {
    'bot-wa/no-v1-api': 'error',
    'bot-wa/no-await-runtime-enter': 'error',
    'bot-wa/no-async-plugin-install': 'error',
    'bot-wa/no-empty-trigger': 'error',
    'bot-wa/require-timeout-on-ask': ['error', { methods: ['ask', 'waitText', 'waitMedia', 'choose', 'waitAny'] }],
    'bot-wa/prefer-ctx-user-over-global-state': 'error',
  },
}

export const configs: BotWaConfigs = plugin.configs

export { noAsyncPluginInstall, noAwaitRuntimeEnter, noEmptyTrigger, noV1Api, preferCtxUser, requireTimeoutOnAsk }

const botWa: BotWaPlugin = plugin
export default botWa
