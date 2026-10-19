/**
 * graphClient — thin fetch wrapper over the WhatsApp Cloud API (Graph).
 * Node 20 global fetch; zero runtime dependencies. Maps Graph errors to the
 * core's typed provider errors.
 */

import { PayloadTooLargeError, ProviderError, type ChatId } from '@bot-wa/core'
import { toGraphError, type GraphError } from '@bot-wa/graph-core'
import { SecureHttpError, secureFetch, type SecureFetchOptions, type SecureFetchResponse } from '@bot-wa/http'
import { isBsuid } from './identity.js'

export interface GraphClientConfig {
  accessToken: string
  phoneNumberId: string
  apiVersion: string
  graphUrl: string
  mediaDownload?: Omit<SecureFetchOptions, 'fetch'>
}

/**
 * Translate a Graph error into a typed provider error. Thin wrapper over the
 * shared {@link toGraphError} (kept for API compatibility + the chatId-first
 * signature callers expect).
 */
export function toProviderError(chatId: ChatId, err: GraphError, retryAfterMs?: number): ProviderError {
  return toGraphError(err, { chatId, retryAfterMs })
}

/**
 * `fetch` that rejects with a typed {@link ProviderError} (original error as
 * `cause`) when the request never gets a response (DNS, TLS, reset, timeout).
 */
async function graphFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    const wrapped = new ProviderError(`Graph API request failed: ${err instanceof Error ? err.message : String(err)}`)
    ;(wrapped as { cause?: unknown }).cause = err
    throw wrapped
  }
}

/**
 * `secureFetch` for the media CDN step: policy refusals (SSRF, redirects),
 * timeouts and transport failures reject with a typed {@link ProviderError}
 * (original as `cause`); an oversized body becomes a {@link PayloadTooLargeError}.
 * The message never includes the URL's query (signed media URLs carry tokens).
 */
async function secureFetchTyped(url: string, init: SecureFetchOptions): Promise<SecureFetchResponse> {
  try {
    return await secureFetch(url, init)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const wrapped = err instanceof SecureHttpError && err.code === 'RESPONSE_TOO_LARGE'
      ? new PayloadTooLargeError(`Media download too large: ${detail}`)
      : new ProviderError(`Media download failed: ${detail}`)
    ;(wrapped as { cause?: unknown }).cause = err
    throw wrapped
  }
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

  /**
   * Send a message payload (already shaped by toOutbound). A business-scoped
   * user id (BSUID, e.g. `US.1349...`, or a parent `US.ENT.1181...`) is
   * addressed with `recipient`; a phone number (wa_id) with `to`. Never both:
   * Meta gives `to` precedence when both are present.
   */
  async sendMessage(to: ChatId, message: Record<string, unknown>): Promise<{ id?: string }> {
    const target = isBsuid(to) ? { recipient: to } : { to }
    const res = await graphFetch(this.base(`${this.cfg.phoneNumberId}/messages`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...target, ...message }),
    })
    const body = (await this.check(res, to)) as { messages?: Array<{ id: string }> }
    return { id: body.messages?.[0]?.id }
  }

  /**
   * POST a JSON body to a Graph path (relative to the API version), e.g.
   * `{WABA-ID}/flows`. Graph errors map to typed provider errors.
   */
  async postJson<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await graphFetch(this.base(path), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })
    return (await this.check(res, '')) as T
  }

  /** Mark an inbound message as read. */
  async markRead(messageId: string): Promise<void> {
    const res = await graphFetch(this.base(`${this.cfg.phoneNumberId}/messages`), {
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
    const res = await graphFetch(this.base(`${this.cfg.phoneNumberId}/media`), {
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
    const meta = await graphFetch(this.base(mediaId), { headers: this.headers() })
    const info = (await this.check(meta, '')) as { url?: string; mime_type?: string }
    if (!info.url) throw new ProviderError('Media metadata returned no url')
    const { response: file, body } = await secureFetchTyped(info.url, { ...this.cfg.mediaDownload, headers: this.headers() })
    if (!file.ok) throw new ProviderError(`Media download failed: HTTP ${file.status}`)
    return { buffer: body, mimetype: info.mime_type ?? 'application/octet-stream' }
  }
}
