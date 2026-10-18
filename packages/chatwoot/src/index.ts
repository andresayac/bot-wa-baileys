/**
 * @bot-wa/chatwoot — Chatwoot inbox sync + human handoff for `@bot-wa/core`.
 *
 * - {@link chatwootPlugin} — the plugin (also exposes the webhook handler and helpers).
 * - {@link ChatwootClient} — the minimal Application API client it uses (via secureFetch).
 */

import type { ChatwootApi } from './chatwootPlugin.js'

export { chatwootPlugin } from './chatwootPlugin.js'
export type {
  ChatwootPluginConfig,
  ChatwootPlugin,
  ChatwootApi,
  ChatwootContactInfo,
  ChatwootWebhookRequest,
  ChatwootWebhookResponse,
} from './chatwootPlugin.js'
export { ChatwootClient, ChatwootApiError } from './client.js'
export type {
  ChatwootClientOptions,
  ChatwootHttpOptions,
  ChatwootMessageType,
  ChatwootConversationStatus,
  ChatwootContactInput,
  ChatwootContactRef,
} from './client.js'
export { ChatwootMapping, memoryKeyValue, storeKeyValue } from './mapping.js'
export type { ChatwootKeyValue, ChatwootChatLink } from './mapping.js'
export { verifyWebhook } from './webhookAuth.js'
export type { HeaderBag, WebhookAuthConfig } from './webhookAuth.js'
export { inboundText, outboundText } from './format.js'

/** Types `ctx.tools.chatwoot` once this package is imported. */
declare module '@bot-wa/core' {
  interface DefaultTools {
    /** Present when `chatwootPlugin` is plugged into the Bot. */
    chatwoot?: ChatwootApi
  }
}
