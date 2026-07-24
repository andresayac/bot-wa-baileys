/**
 * graphClient — thin fetch wrapper over the WhatsApp Cloud API (Graph).
 * Node 20 global fetch; zero runtime dependencies. Maps Graph errors to the
 * core's typed provider errors.
 */

import { ProviderError, type ChatId } from '@bot-wa/core'
import { toGraphError, type GraphError } from '@bot-wa/graph-core'

export interface GraphClientConfig {
  accessToken: string
  phoneNumberId: string
  apiVersion: string
  graphUrl: string
}

/**
 * Translate a Graph error into a typed provider error. Thin wrapper over the
 * shared {@link toGraphError} (kept for API compatibility + the chatId-first
 * signature callers expect).
 */
export function toProviderError(chatId: ChatId, err: GraphError, retryAfterMs?: number): ProviderError {
  return toGraphError(err, { chatId, retryAfterMs })
}

export class GraphClient {
  constructor(private cfg: GraphClientConfig) {}

  private base(path: string): string {
    return `${this.cfg.graphUrl.replace(/\/$/, '')}/${this.cfg.apiVersion}/${path}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.accessToken}`, ...extra }
  }

  private async check(res: Response, chatId: ChatId): Promise<unknown> {
    const body = (await res.json().catch(() => ({}))) as { error?: GraphError }
    if (!res.ok || body.error) {
      const retryAfter = Number(res.headers.get('Retry-After')) || undefined
      throw toProviderError(chatId, body.error ?? { message: `HTTP ${res.status}` }, retryAfter ? retryAfter * 1000 : undefined)
    }
    return body
  }

  /** Send a message payload (already shaped by toOutbound). */
  async sendMessage(to: ChatId, message: Record<string, unknown>): Promise<{ id?: string }> {
    const res = await fetch(this.base(`${this.cfg.phoneNumberId}/messages`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }),
    })
    const body = (await this.check(res, to)) as { messages?: Array<{ id: string }> }
    return { id: body.messages?.[0]?.id }
  }

  /** Mark an inbound message as read. */
  async markRead(messageId: string): Promise<void> {
    const res = await fetch(this.base(`${this.cfg.phoneNumberId}/messages`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    })
    await this.check(res, '')
  }

  /** Upload media (multipart) → media id. */
  async uploadMedia(buffer: Buffer, mimetype: string, filename?: string): Promise<string> {
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', mimetype)
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimetype }), filename ?? 'file')
    const res = await fetch(this.base(`${this.cfg.phoneNumberId}/media`), {
      method: 'POST',
      headers: this.headers(),
      body: form,
    })
    const body = (await this.check(res, '')) as { id?: string }
    if (!body.id) throw new ProviderError('Media upload returned no id')
    return body.id
  }

  /** Download media bytes by media id (two-step: resolve URL, then fetch it). */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimetype: string }> {
    const meta = await fetch(this.base(mediaId), { headers: this.headers() })
    const info = (await this.check(meta, '')) as { url?: string; mime_type?: string }
    if (!info.url) throw new ProviderError('Media metadata returned no url')
    const file = await fetch(info.url, { headers: this.headers() })
    if (!file.ok) throw new ProviderError(`Media download failed: HTTP ${file.status}`)
    return { buffer: Buffer.from(await file.arrayBuffer()), mimetype: info.mime_type ?? 'application/octet-stream' }
  }
}
