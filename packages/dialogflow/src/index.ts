/**
 * @bot-wa/dialogflow — Dialogflow ES/CX context for `@bot-wa/core`.
 *
 * - {@link dialogflowPlugin} / {@link dialogflowContext} — detectIntent on every
 *   inbound text (before-hook), exposed as `ctx.tools.dialogflow`.
 * - {@link whenDialogflowIntent} — route an intent to a handler or flow via
 *   `bot.when`; flow parameters land in `c.state`.
 * - {@link DialogflowClient} — the REST client (service-account JWT signed with
 *   `node:crypto`, no Google SDK), usable on its own.
 */

import type { DialogflowContext } from './context.js'

export { dialogflowPlugin, dialogflowContext } from './plugin.js'
export type { DialogflowPluginConfig } from './plugin.js'
export { DialogflowContext } from './context.js'
export type { DialogflowContextOptions, SessionSubject } from './context.js'
export { whenDialogflowIntent, withDialogflowState } from './whenDialogflowIntent.js'
export type { DialogflowIntentHandler, IntentTarget, WhenDialogflowIntentOptions } from './whenDialogflowIntent.js'
export { DialogflowClient, normalizeCxResult, normalizeEsResult, toSessionId } from './client.js'
export type { DetectIntentOptions, DialogflowClientConfig, DialogflowCxAgent, DialogflowResult } from './client.js'
export {
  DIALOGFLOW_SCOPE,
  DEFAULT_TOKEN_URI,
  DialogflowError,
  ServiceAccountTokenSource,
  createServiceAccountJwt,
  parseCredentials,
} from './auth.js'
export type { AccessTokenSource, HttpOptions, ServiceAccountCredentials } from './auth.js'

/**
 * Augment `@bot-wa/core` so `ctx.tools.dialogflow` is typed once the plugin is installed.
 */
declare module '@bot-wa/core' {
  interface DefaultTools {
    /** Present when `dialogflowPlugin` is plugged into the Bot. */
    dialogflow?: DialogflowContext
  }
}
