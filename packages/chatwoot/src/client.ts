/**
 * Minimal Chatwoot Application API client (`/api/v1/accounts/{accountId}/…`).
 *
 * Every request goes through `secureFetch` from `@botmesh/http` (HTTPS only, SSRF guard on
 * the resolved address, timeout, size limit) and never follows redirects, so the
 * `api_access_token` header can never be forwarded to another origin. Self-hosted
 * Chatwoot on a private network needs `http.allowPrivateHosts` (and `http.allowHttp`
 * for plain HTTP) explicitly.
 */

import { secureFetch, type HostResolver } from '@botmesh/http'

/** Transport knobs for the Chatwoot client (all optional). */
export interface ChatwootHttpOptions {
  /** Inject a fetch implementation (tests, custom dispatchers). */
  fetch?: typeof globalThis.fetch
  /** Override DNS resolution (tests, controlled egress). */
  resolver?: HostResolver
  /** Allow `http://` base URLs. Default `false`. */
  allowHttp?: boolean
  /** Allow loopback/private destinations (self-hosted Chatwoot on a LAN). Default `false`. */
  allowPrivateHosts?: boolean
  /** Per-request timeout in ms. Default `15000`. */
  timeoutMs?: number
}

export interface ChatwootClientOptions {
  baseUrl: string
  apiKey: string
  accountId: number | string
  http?: ChatwootHttpOptions
}

/** A non-2xx answer from the Chatwoot API. */
export class ChatwootApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly responseBody: string,
  ) {
    super(`Chatwoot API ${method} ${path} failed: HTTP ${status}`)
    this.name = 'ChatwootApiError'
  }
}

/** `message_type` values accepted by the messages endpoint. */
export type ChatwootMessageType = 'incoming' | 'outgoing'

/** Conversation status values. */
export type ChatwootConversationStatus = 'open' | 'resolved' | 'pending' | 'snoozed'

export interface ChatwootContactInput {
  inboxId: number
  name?: string
  identifier?: string
  phoneNumber?: string
  email?: string
  customAttributes?: Record<string, unknown>
}

export interface ChatwootContactRef {
  id: number
  /** Contact-inbox source id, when Chatwoot returned one. */
  sourceId?: string
}

type Json = Record<string, unknown>

function asObject(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}
function asNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

export function normalizeBaseUrl(baseUrl: string): string {
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new Error(`Invalid chatwoot config.baseUrl: ${JSON.stringify(baseUrl)}`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Invalid chatwoot config.baseUrl: unsupported protocol ${url.protocol}`)
  return url.href.replace(/\/+$/, '')
}

export class ChatwootClient {
  private readonly base: string

  constructor(private readonly opts: ChatwootClientOptions) {
    this.base = `${normalizeBaseUrl(opts.baseUrl)}/api/v1/accounts/${encodeURIComponent(String(opts.accountId))}`
  }

  /** Low-level request. Resolves the parsed JSON body (or `undefined` for an empty one). */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const http = this.opts.http ?? {}
    const { response, body: raw } = await secureFetch(`${this.base}${path}`, {
      method,
      headers: {
        api_access_token: this.opts.apiKey,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      maxRedirects: 0,
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: http.timeoutMs ?? 15_000,
      allowHttp: http.allowHttp ?? false,
      allowPrivateHosts: http.allowPrivateHosts ?? false,
      ...(http.fetch ? { fetch: http.fetch } : {}),
      ...(http.resolver ? { resolver: http.resolver } : {}),
    })
    const text = raw.toString('utf8')
    if (!response.ok) throw new ChatwootApiError(response.status, method, path, text.slice(0, 500))
    if (text.trim() === '') return undefined
    try { return JSON.parse(text) } catch { return text }
  }

  /** Find a contact whose `identifier` equals `identifier` exactly. */
  async findContactByIdentifier(identifier: string): Promise<ChatwootContactRef | undefined> {
    const res = asObject(await this.request('GET', `/contacts/search?q=${encodeURIComponent(identifier)}`))
    const list = Array.isArray(res.payload) ? res.payload : []
    for (const item of list) {
      const c = asObject(item)
      const id = asNumber(c.id)
      if (id !== undefined && c.identifier === identifier) return { id }
    }
    return undefined
  }

  async createContact(input: ChatwootContactInput): Promise<ChatwootContactRef> {
    const res = asObject(await this.request('POST', '/contacts', {
      inbox_id: input.inboxId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.identifier !== undefined ? { identifier: input.identifier } : {}),
      ...(input.phoneNumber !== undefined ? { phone_number: input.phoneNumber } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.customAttributes !== undefined ? { custom_attributes: input.customAttributes } : {}),
    }))
    // Chatwoot versions differ: { payload: { contact, contact_inbox } } | { payload: contact } | contact
    const payload = asObject(res.payload ?? res)
    const contact = asObject(payload.contact ?? payload)
    const id = asNumber(contact.id)
    if (id === undefined) throw new Error('Chatwoot createContact: response has no contact id')
    const inbox = asObject(payload.contact_inbox)
    const sourceId = typeof inbox.source_id === 'string' ? inbox.source_id : undefined
    return sourceId !== undefined ? { id, sourceId } : { id }
  }

  /** Link a contact to an inbox; resolves the contact-inbox `source_id`. */
  async createContactInbox(contactId: number, inboxId: number): Promise<string | undefined> {
    const res = asObject(await this.request('POST', `/contacts/${contactId}/contact_inboxes`, { inbox_id: inboxId }))
    const src = res.source_id ?? asObject(res.payload).source_id
    return typeof src === 'string' ? src : undefined
  }

  async createConversation(input: { inboxId: number; contactId: number; sourceId?: string; status?: ChatwootConversationStatus }): Promise<number> {
    const res = asObject(await this.request('POST', '/conversations', {
      inbox_id: input.inboxId,
      contact_id: input.contactId,
      ...(input.sourceId !== undefined ? { source_id: input.sourceId } : {}),
      status: input.status ?? 'open',
    }))
    const id = asNumber(res.id) ?? asNumber(asObject(res.payload).id)
    if (id === undefined) throw new Error('Chatwoot createConversation: response has no conversation id')
    return id
  }

  /** Post a message; resolves the Chatwoot message id (when returned). */
  async createMessage(conversationId: number, input: { content: string; messageType: ChatwootMessageType; private?: boolean }): Promise<number | undefined> {
    const res = asObject(await this.request('POST', `/conversations/${conversationId}/messages`, {
      content: input.content,
      message_type: input.messageType,
      private: input.private ?? false,
    }))
    return asNumber(res.id)
  }

  async toggleStatus(conversationId: number, status: ChatwootConversationStatus): Promise<void> {
    await this.request('POST', `/conversations/${conversationId}/toggle_status`, { status })
  }

  async getLabels(conversationId: number): Promise<string[]> {
    const res = asObject(await this.request('GET', `/conversations/${conversationId}/labels`))
    return Array.isArray(res.payload) ? res.payload.filter((l): l is string => typeof l === 'string') : []
  }

  /** Replace the conversation's labels (Chatwoot semantics). */
  async setLabels(conversationId: number, labels: string[]): Promise<void> {
    await this.request('POST', `/conversations/${conversationId}/labels`, { labels })
  }
}
