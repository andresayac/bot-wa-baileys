/**
 * @bot-wa/meta — types for the WhatsApp Cloud API (official Meta) transport.
 */

import type { Logger } from 'pino'
import type { SecureFetchOptions } from '@bot-wa/http'
import type { IdentityMap } from './identity.js'
import type { SessionWindowManager, SessionWindowOptions } from './sessionWindow.js'
import type { UsageTracker, UsageTrackerOptions } from './pricing.js'
import type { FlowRef } from './flows.js'

export interface CloudAPIProviderConfig {
  /** Permanent (system-user) access token with whatsapp_business_messaging. */
  accessToken: string
  /** The phone-number id of the sending number (from the Meta app dashboard). */
  phoneNumberId: string
  /** Shared secret the host configured in the webhook subscription (GET verify). */
  verifyToken: string
  /**
   * App secret — when set, inbound POSTs are verified against the
   * `X-Hub-Signature-256` header (HMAC-SHA256). Strongly recommended.
  */
  appSecret?: string
  /**
   * Explicitly allow unsigned webhook POSTs. Intended only for isolated local
   * development; production deployments should always configure `appSecret`.
   */
  allowUnsignedWebhooks?: boolean
  /** Graph API version. Default 'v21.0'. */
  apiVersion?: string
  /** Graph base URL. Default 'https://graph.facebook.com'. */
  graphUrl?: string
  /** Safe-download policy for inbound media. HTTPS/public hosts are enforced by default. */
  mediaDownload?: Omit<SecureFetchOptions, 'fetch'>
  /** The bot's own wa_id (for identity/mention logic). Optional. */
  selfId?: string
  /**
   * Where learned phone ↔ BSUID links are kept. WhatsApp username users arrive
   * with only a business-scoped user id (BSUID); a user first seen with a phone
   * number keeps the phone-based chatId only if this map remembers the link.
   * Default: a bounded in-memory {@link MemoryIdentityMap} (lost on restart).
   * Provide a persistent implementation (sync or async) to keep ids stable
   * across restarts.
   */
  identityMap?: IdentityMap
  /**
   * 24 h customer-service window management: track each chat's last inbound
   * message, reopen closed chats with an approved template and retry the
   * original send once the user replies. Pass options (or a shared
   * {@link SessionWindowManager}). Off by default: sends outside the window
   * reject with `OutsideSessionWindowError`.
   */
  sessionWindow?: SessionWindowOptions | SessionWindowManager
  /**
   * Aggregate the `pricing` of status webhooks per chat/category (see
   * `provider.usage`). Default: an in-memory bounded {@link UsageTracker};
   * `false` disables counting (pricing still reaches `platformData`).
   */
  usage?: UsageTrackerOptions | UsageTracker | false
  /**
   * Published WhatsApp Flows for `flow().form()`, keyed by form id: a Flow id
   * (all digits), a Flow name, or a {@link FlowRef} (e.g. `{ flowId, mode: 'draft' }`
   * to test an unpublished draft). Forms without a mapping (and without
   * `.form(def, { nativeId })`) fall back to field-by-field questions.
   * `publishForm()` fills this in at runtime.
   */
  flows?: Record<string, string | FlowRef>
  /** WhatsApp Business Account id — needed only by `publishForm()`. */
  wabaId?: string
  debug?: boolean
  logger?: Logger
}

/* --- Graph API request/response shapes (subset used) --------------------- */

export interface GraphErrorBody {
  error?: {
    code?: number
    message?: string
    error_subcode?: number
    fbtrace_id?: string
  }
}

export interface GraphSendMessageResponse {
  messages?: Array<{ id: string }>
  /** `input` echoes `to`/`recipient`; `wa_id` is omitted for BSUID sends Meta can't map to a phone. */
  contacts?: Array<{ input?: string; wa_id?: string; user_id?: string }>
  error?: GraphErrorBody['error']
}
