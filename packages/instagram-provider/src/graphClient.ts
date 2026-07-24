/**
 * graphClient — thin fetch wrapper over the Messenger API for Instagram (Graph).
 * Node 20 global fetch; zero runtime dependencies. Maps Graph errors to the
 * core's typed provider errors (code 4 / 613 → RateLimitedError).
 */

import { ProviderError } from '@bot-wa/core'
import { toGraphError, type GraphError } from '@bot-wa/graph-core'
import { secureFetch, type SecureFetchOptions } from '@bot-wa/http'

export interface GraphClientConfig {
  accessToken: string
  apiVersion: string
  graphUrl: string
  mediaDownload?: Omit<SecureFetchOptions, 'fetch'>
}

/**
 * Translate a Graph error into a typed provider error. Thin wrapper over the
 * shared {@link toGraphError} — now maps the full Graph code set, not just 4/613.
 */
export function toProviderError(err: GraphError, retryAfterMs?: number): ProviderError {
  return toGraphError(err, { retryAfterMs })
}

export class GraphClient {
  constructor(private cfg: GraphClientConfig) {}

  private base(path: string): string {
    return `${this.cfg.graphUrl.replace(/\/$/, '')}/${this.cfg.apiVersion}/${path}`
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' }
  }

  private async check(res: Response): Promise<unknown> {
    const body = (await res.json().catch(() => ({}))) as { error?: GraphError }
    if (!res.ok || body.error) {
      const retryAfter = Number(res.headers.get('Retry-After')) || undefined
      throw toProviderError(body.error ?? { message: `HTTP ${res.status}` }, retryAfter ? retryAfter * 1000 : undefined)
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
    const body = (await this.check(res)) ?? {}
    return body as { message_id?: string; recipient_id?: string }
  }

  /** Send a sender_action: 'mark_seen' | 'typing_on' | 'typing_off'. */
  async sendSenderAction(recipientId: string, senderAction: 'mark_seen' | 'typing_on' | 'typing_off'): Promise<void> {
    const res = await fetch(this.base('me/messages'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: senderAction }),
    })
    await this.check(res)
  }

  /** Download media bytes from a hosted URL (attachment payload.url). */
  async downloadUrl(url: string): Promise<Buffer> {
    const { response: res, body } = await secureFetch(url, this.cfg.mediaDownload)
    if (!res.ok) throw new ProviderError(`Media download failed: HTTP ${res.status}`)
    return body
  }
}
