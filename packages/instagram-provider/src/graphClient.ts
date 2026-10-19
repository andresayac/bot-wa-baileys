/**
 * graphClient — thin fetch wrapper over the Messenger API for Instagram (Graph).
 * Node 20 global fetch; zero runtime dependencies. Maps Graph errors to the
 * core's typed provider errors (code 4 / 613 → RateLimitedError).
 */

import { OutsideSessionWindowError, ProviderError, RecipientUnreachableError, type ChatId } from '@bot-wa/core'
import { toGraphError, type GraphError } from '@bot-wa/graph-core'
import { secureFetch, type SecureFetchOptions } from '@bot-wa/http'

export interface GraphClientConfig {
  accessToken: string
  apiVersion: string
  graphUrl: string
  mediaDownload?: Omit<SecureFetchOptions, 'fetch'>
}

/**
 * Messenger Platform send failures that the shared Graph mapping does not know:
 *  - outside the messaging window: code 10 with subcode 2018278 (Messenger) or
 *    2534022 (Instagram) -> {@link OutsideSessionWindowError};
 *  - recipient gone / unknown: code 551 ("This person isn't available right
 *    now"), subcodes 1545041, 2018001 and 2534014 ("No matching user found")
 *    -> {@link RecipientUnreachableError}.
 */
const WINDOW_SUBCODES = new Set([2018278, 2534022])
const UNREACHABLE_SUBCODES = new Set([1545041, 2018001, 2534014])

/**
 * Translate a Graph error into a typed provider error: the Messenger Platform
 * window/recipient codes first, then the shared {@link toGraphError} mapping.
 * `chatId` (the IGSID the call targeted) is carried on window/unreachable errors.
 */
export function toProviderError(err: GraphError, retryAfterMs?: number, chatId: ChatId = ''): ProviderError {
  const msg = err.message ?? 'Graph API error'
  const tag = `${err.code ?? '?'}${err.error_subcode ? `/${err.error_subcode}` : ''}`
  if (err.error_subcode !== undefined && WINDOW_SUBCODES.has(err.error_subcode)) {
    return new OutsideSessionWindowError(chatId, `${msg} (${tag}) — the user must write first (24h window) or use a message tag.`)
  }
  if (err.code === 551 || (err.error_subcode !== undefined && UNREACHABLE_SUBCODES.has(err.error_subcode))) {
    return new RecipientUnreachableError(chatId, `${msg} (${tag})`)
  }
  return toGraphError(err, { retryAfterMs, chatId })
}

export class GraphClient {
  constructor(private cfg: GraphClientConfig) {}

  private base(path: string): string {
    return `${this.cfg.graphUrl.replace(/\/$/, '')}/${this.cfg.apiVersion}/${path}`
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' }
  }

  private async check(res: Response, chatId: ChatId): Promise<unknown> {
    const body = (await res.json().catch(() => ({}))) as { error?: GraphError }
    if (!res.ok || body.error) {
      const retryAfter = Number(res.headers.get('Retry-After')) || undefined
      throw toProviderError(body.error ?? { message: `HTTP ${res.status}` }, retryAfter ? retryAfter * 1000 : undefined, chatId)
    }
    return body
  }

  /** Send a message payload (already shaped by toOutbound) to `me/messages`. */
  async sendMessage(recipientId: string, message: Record<string, unknown>): Promise<{ message_id?: string; recipient_id?: string }> {
    const res = await fetch(this.base('me/messages'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ recipient: { id: recipientId }, message }),
    })
    const body = (await this.check(res, recipientId)) ?? {}
    return body as { message_id?: string; recipient_id?: string }
  }

  /** Send a sender_action: 'mark_seen' | 'typing_on' | 'typing_off'. */
  async sendSenderAction(recipientId: string, senderAction: 'mark_seen' | 'typing_on' | 'typing_off'): Promise<void> {
    const res = await fetch(this.base('me/messages'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: senderAction }),
    })
    await this.check(res, recipientId)
  }

  /** Download media bytes from a hosted URL (attachment payload.url). */
  async downloadUrl(url: string): Promise<Buffer> {
    const { response: res, body } = await secureFetch(url, this.cfg.mediaDownload)
    if (!res.ok) throw new ProviderError(`Media download failed: HTTP ${res.status}`)
    return body
  }
}
