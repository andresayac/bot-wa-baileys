/**
 * `@bot-wa/core/internal` — engine internals.
 *
 * Building blocks the `Bot` is made of: the context builder, the reply pacer, the
 * broadcast engine, the metrics collector, the native-form runner and their helpers.
 * They are exported for engine work, custom bots and advanced tests. **No semver
 * guarantee:** any of them may change or disappear in a minor release. Applications
 * should use the `Bot` API from `@bot-wa/core` instead.
 *
 * Until v3 the main entry (`@bot-wa/core`) re-exports every name here, marked
 * `@deprecated`; import them from this subpath.
 *
 * @example
 * ```ts
 * import { createPacer, MetricsCollector } from '@bot-wa/core/internal'
 * ```
 *
 * @packageDocumentation
 */

export { buildMessageContext } from './core/context.js'
export { createControls } from './conversations/controls.js'
export {
  TYPING_REFRESH_MS,
  ExternalSendClock,
  createPacer,
  normalizeTypingConfig,
  resolveReplyTyping,
  typingDuration,
  parseReplyDelay,
} from './core/messaging.js'
export { runBroadcast } from './ops/broadcast.js'
export { MetricsCollector, formatUptime } from './ops/metrics.js'
export { runFormStep, resolveFormMode } from './forms/runForm.js'
export { newFormToken } from './forms/reply.js'
