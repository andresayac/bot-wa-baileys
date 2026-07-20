/**
 * definePlugin — typed plugin factory helper.
 *
 * A plugin is an object with `name`, `version` and an `install(ctx, config)`
 * hook. Use `definePlugin` to get type inference on the config.
 *
 * @example Static plugin
 * ```ts
 * import { definePlugin } from '@bot-wa/bot-wa-baileys'
 *
 * const loggingPlugin = definePlugin({
 *   name: 'logging',
 *   version: '1.0.0',
 *   description: 'Log every message',
 *   install(ctx) {
 *     ctx.bot.before('message', async (c, next) => {
 *       ctx.logger.info(`📥 ${c.from}: ${c.body}`)
 *       await next()
 *     })
 *   },
 * })
 *
 * bot.plug(loggingPlugin)
 * ```
 *
 * @example Configurable plugin (factory form)
 * ```ts
 * const rateLimit = definePlugin({
 *   name: 'rate-limit',
 *   version: '1.0.0',
 *   install(ctx, config = {}) {
 *     const max = config.max ?? 10
 *     const windowMs = config.windowMs ?? 60_000
 *     // ... register before('message') hook ...
 *   },
 * })
 *
 * bot.plug(rateLimit, { max: 20, windowMs: 60_000 })
 * ```
 */

import type { Plugin, PluginSpec } from '../core/types.js'

export function definePlugin<TConfig = Record<string, unknown>>(
  spec: PluginSpec<TConfig>
): PluginSpec<TConfig> {
  return spec
}

/** Sentinel check to differentiate plugins from flows in bot.use(). */
export function isPlugin(x: any): x is Plugin {
  if (typeof x === 'function' && x.length === 0) return false // arrow without args?
  return (
    x &&
    typeof x === 'object' &&
    typeof x.name === 'string' &&
    typeof (x as any).install === 'function'
  )
}
