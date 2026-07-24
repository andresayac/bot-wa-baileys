/**
 * restClient — thin fetch wrapper over the Discord REST API (v10). Node 20
 * global fetch; maps Discord errors to the core's typed provider errors.
 */

import {
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  type ChatId,
} from '@bot-wa/core'
import type { DiscordApiErrorBody, DiscordMessageResponse } from './types.js'
import type { DiscordFile } from './toOutbound.js'
import { secureFetch, type SecureFetchOptions } from '@bot-wa/http'

export interface DiscordRestClientConfig {
  token: string
  /** Base URL without the version, e.g. 'https://discord.com/api'. */
  apiUrl: string
  /** E.g. 'v10'. */
  apiVersion: string
  mediaDownload?: Omit<SecureFetchOptions, 'fetch'>
}

/** Translate a Discord REST error into a typed provider error. */
export function toProviderError(chatId: ChatId, status: number, body: DiscordApiErrorBody): ProviderError {
  const msg = body.message ?? 'Discord API error'
  const detail = `${msg}${body.code ? ` (code ${body.code})` : ''} (HTTP ${status})`
  if (status === 429) {
    const ms = body.retry_after ? Math.ceil(body.retry_after * 1000) : 1_000
    return new RateLimitedError(ms, detail)
  }
  if (status === 403) return new RecipientUnreachableError(chatId, detail)
  if (status === 413 || body.code === 40_003) return new PayloadTooLargeError(detail)
  return new ProviderError(detail)
}

export class DiscordRestClient {
  constructor(private readonly cfg: DiscordRestClientConfig) {}

  base(path: string): string {
    return `${this.cfg.apiUrl.replace(/\/+$/, '')}/${this.cfg.apiVersion}/${path}`
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bot ${this.cfg.token}` }
  }

  /** Build multipart form-data: `payload_json` + `files[n]`. */
  static toForm(payload: Record<string, unknown>, files: DiscordFile[]): FormData {
    const form = new FormData()
    form.append('payload_json', JSON.stringify(payload))
    files.forEach((f, i) => {
      form.append(
        `files[${i}]`,
        new Blob([new Uint8Array(f.buffer)], { type: f.contentType ?? 'application/octet-stream' }),
        f.name,
      )
    })
    return form
  }

  async request(
    method: string,
    path: string,
    opts: { chatId?: ChatId; json?: unknown; form?: FormData } = {},
  ): Promise<Record<string, unknown>> {
    const headers = this.headers()
    let body: string | FormData | undefined
    if (opts.form) {
      body = opts.form
    } else if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.json)
    }
    const res = await fetch(this.base(path), { method, headers, body })
    const parsed = (await res.json().catch(() => ({}))) as DiscordApiErrorBody & Record<string, unknown>
    if (!res.ok) throw toProviderError(opts.chatId ?? '', res.status, parsed)
    return parsed
  }

  /** POST /channels/{channelId}/messages (JSON or multipart when files). */
  async sendMessage(channelId: ChatId, payload: Record<string, unknown>, files?: DiscordFile[]): Promise<DiscordMessageResponse> {
    return this.request('POST', `channels/${channelId}/messages`, {
      chatId: channelId,
      ...(files?.length ? { form: DiscordRestClient.toForm(payload, files) } : { json: payload }),
    }) as Promise<DiscordMessageResponse>
  }

  /** POST /webhooks/{appId}/{interactionToken} — followup inside an interaction. */
  async sendFollowup(appId: string, interactionToken: string, payload: Record<string, unknown>, files?: DiscordFile[]): Promise<DiscordMessageResponse> {
    return this.request('POST', `webhooks/${appId}/${interactionToken}`, {
      ...(files?.length ? { form: DiscordRestClient.toForm(payload, files) } : { json: payload }),
    }) as Promise<DiscordMessageResponse>
  }

  /** PATCH /channels/{channelId}/messages/{messageId}. */
  async editMessage(channelId: ChatId, messageId: string, payload: Record<string, unknown>, files?: DiscordFile[]): Promise<DiscordMessageResponse> {
    return this.request('PATCH', `channels/${channelId}/messages/${messageId}`, {
      chatId: channelId,
      ...(files?.length ? { form: DiscordRestClient.toForm(payload, files) } : { json: payload }),
    }) as Promise<DiscordMessageResponse>
  }

  /** DELETE /channels/{channelId}/messages/{messageId}. */
  async deleteMessage(channelId: ChatId, messageId: string): Promise<void> {
    await this.request('DELETE', `channels/${channelId}/messages/${messageId}`, { chatId: channelId })
  }

  /** PUT /channels/{channelId}/messages/{messageId}/reactions/{emoji}/@me. */
  async putReaction(channelId: ChatId, messageId: string, emoji: string): Promise<void> {
    await this.request('PUT', `channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, { chatId: channelId })
  }

  /** POST /channels/{channelId}/typing. */
  async triggerTyping(channelId: ChatId): Promise<void> {
    await this.request('POST', `channels/${channelId}/typing`, { chatId: channelId })
  }

  /** POST /interactions/{interactionId}/{token}/callback (type 4 or 6). */
  async ackInteraction(interactionId: string, token: string, callback: Record<string, unknown>): Promise<void> {
    await this.request('POST', `interactions/${interactionId}/${token}/callback`, { json: callback })
  }

  /** Plain HTTPS GET (Discord CDN media urls need no auth). */
  async download(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    const { response: res, body } = await secureFetch(url, this.cfg.mediaDownload)
    if (!res.ok) throw new ProviderError(`Media download failed: HTTP ${res.status}`)
    return {
      buffer: body,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    }
  }
}
