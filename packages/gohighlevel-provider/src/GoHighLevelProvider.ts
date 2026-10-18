/**
 * GoHighLevelProvider — HighLevel (LeadConnector) Conversations API transport.
 * Webhook-based (pushIngress): subscribe the app/location to the
 * `InboundMessage` webhook, forward each POST (RAW body + headers) to
 * `ingest()`. Replies go out with `POST /conversations/messages` on the same
 * channel (SMS, WhatsApp, Email, FB, IG, Live chat…) the contact last used.
 *
 * @example
 * ```ts
 * const provider = new GoHighLevelProvider({
 *   accessToken: process.env.GHL_TOKEN!,      // Private Integration Token
 *   locationId: process.env.GHL_LOCATION_ID!,
 * })
 * app.post('/ghl/webhook', express.raw({ type: 'application/json' }), (req, res) => {
 *   res.sendStatus(provider.ingest(req.body, req.headers))
 * })
 * ```
 */

import { createPublicKey, type KeyObject } from 'node:crypto'
import pino, { type Logger } from 'pino'
import type {
  ChatId,
  IProvider,
  InboundEvent,
  MediaRef,
  MessageRef,
  OutboundContent,
  ProviderCapabilities,
  SendOptions,
  SendResult,
  UserId,
} from '@bot-wa/core'
import { ProviderError } from '@bot-wa/core'
import { secureFetch } from '@bot-wa/http'
import { BoundedMap, header, request, retryAfterMs, type HeaderBag } from './http.js'
import { parseInbound } from './parseInbound.js'
import { GHL_WEBHOOK_PUBLIC_KEY, verifyGhlSignature } from './signature.js'
import { toOutbound } from './toOutbound.js'
import { toGhlError } from './errors.js'
import type { GhlChannel, GhlErrorBody, GhlSendResponse, GhlWebhookBody, GoHighLevelProviderConfig } from './types.js'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

export class GoHighLevelProvider implements IProvider<GhlWebhookBody> {
  readonly id = 'gohighlevel'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'buttons', 'list', 'template', 'native'],
    buttons: false, lists: false, polls: false, reactions: false, edit: false,
    typing: false, presence: false, readReceipts: true, groups: false, templates: true,
    interactionsRequireAck: false, pushIngress: true,
  }

  private readonly config: GoHighLevelProviderConfig & { apiVersion: string; baseUrl: string; defaultChannel: GhlChannel }
  private readonly logger: Logger
  private readonly listeners = new Set<(e: InboundEvent<GhlWebhookBody>) => void | Promise<void>>()
  /** contactId → channel of the contact's last inbound message. */
  private readonly channels = new BoundedMap<ChatId, GhlChannel>()
  private readonly publicKey: KeyObject
  private readonly legacyPublicKey: KeyObject | undefined

  constructor(config: GoHighLevelProviderConfig) {
    if (!config.accessToken) throw new Error('GoHighLevelProvider requires `accessToken`.')
    if (!config.locationId) throw new Error('GoHighLevelProvider requires `locationId`.')
    // `??` per field: an explicit `undefined` (e.g. an unset env var) keeps the default.
    this.config = {
      ...config,
      apiVersion: config.apiVersion ?? '2021-04-15',
      baseUrl: config.baseUrl ?? 'https://services.leadconnectorhq.com',
      defaultChannel: config.defaultChannel ?? 'SMS',
    }
    // Parsed once (and validated at construction, not on the first webhook).
    this.publicKey = createPublicKey(config.publicKey ?? GHL_WEBHOOK_PUBLIC_KEY)
    this.legacyPublicKey = config.legacyPublicKey ? createPublicKey(config.legacyPublicKey) : undefined
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    if (config.allowUnsignedWebhooks) {
      this.logger.warn('GoHighLevelProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.')
    }
  }

  get connection(): unknown { return null }
  get selfId(): UserId | null { return this.config.selfId ?? null }

  /* Events ---------------------------------------------------------------- */

  onEvent(listener: (e: InboundEvent<GhlWebhookBody>) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private fan(e: InboundEvent<GhlWebhookBody>): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(e))
          .catch((error) => this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed'))
      } catch (error) {
        this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed')
      }
    }
  }

  async start(): Promise<void> {
    this.fan({ kind: 'connection', update: { state: 'ready' } })
  }

  async stop(): Promise<void> {
    this.fan({ kind: 'connection', update: { state: 'closed' } })
  }

  /* Webhook --------------------------------------------------------------- */

  /**
   * Feed a webhook POST. Pass the RAW body (Buffer/string): the Ed25519
   * `X-GHL-Signature` is verified over those exact bytes. Returns the HTTP
   * status to answer: 200 accepted (also for ignored event types / other
   * locations), 400 unreadable, 401 missing/invalid signature.
   */
  ingest(rawEvent: unknown, headers?: HeaderBag): number {
    let raw: Buffer | undefined
    if (Buffer.isBuffer(rawEvent)) raw = rawEvent
    else if (rawEvent instanceof Uint8Array) raw = Buffer.from(rawEvent)
    else if (typeof rawEvent === 'string') raw = Buffer.from(rawEvent, 'utf8')

    if (!this.config.allowUnsignedWebhooks) {
      if (!raw) {
        this.logger.error('HighLevel webhook rejected: signature checks need the RAW body (got a parsed object)')
        return 400
      }
      const result = verifyGhlSignature({
        rawBody: raw,
        ...(header(headers, 'x-ghl-signature') !== undefined ? { ghlSignature: header(headers, 'x-ghl-signature') as string } : {}),
        ...(header(headers, 'x-wh-signature') !== undefined ? { legacySignature: header(headers, 'x-wh-signature') as string } : {}),
        publicKey: this.publicKey,
        ...(this.legacyPublicKey ? { legacyPublicKey: this.legacyPublicKey } : {}),
      })
      if (!result.ok) {
        this.logger.warn({ reason: result.reason }, 'HighLevel webhook rejected')
        return 401
      }
    }

    let body: unknown = rawEvent
    if (raw) {
      try { body = JSON.parse(raw.toString('utf8')) } catch { return 400 }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 400
    const event = body as GhlWebhookBody
    if (event.locationId !== undefined && event.locationId !== this.config.locationId) {
      this.logger.debug({ locationId: event.locationId }, 'HighLevel webhook for another location ignored')
      return 200
    }
    const parsed = parseInbound(event)
    if (parsed.channel) this.channels.set(parsed.channel.contactId, parsed.channel.channel)
    for (const e of parsed.events) this.fan(e)
    return 200
  }

  /* Outbound -------------------------------------------------------------- */

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      Version: this.config.apiVersion,
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}${path}`
  }

  /**
   * Send to a contact (`chatId` = contactId). The channel is, in order:
   * `options.platformData.type`, the contact's last inbound channel, then
   * `defaultChannel`. Other `platformData` fields (subject, fromNumber,
   * conversationProviderId, …) are passed through to the API body.
   */
  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<GhlWebhookBody>> {
    const fields = toOutbound(content)
    const extra = { ...(options?.platformData ?? {}) }
    const type = (typeof extra['type'] === 'string' ? extra['type'] : undefined) ?? this.channels.get(chatId) ?? this.config.defaultChannel
    delete extra['type']
    const payload: Record<string, unknown> = { type, contactId: chatId, ...fields, ...extra }
    if (options?.quoted?.id) payload['replyMessageId'] = options.quoted.id
    if (type === 'Email' && payload['html'] === undefined && typeof payload['message'] === 'string') {
      payload['html'] = escapeHtml(payload['message'])
    }

    const res = await request(this.url('/conversations/messages'), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(payload),
    }, this.config.http)
    if (!res.ok) throw toGhlError(res.status, res.json as GhlErrorBody, chatId, retryAfterMs(res.headers))
    const sent = res.json as GhlSendResponse
    const messageId = sent.messageId ?? sent.messageIds?.[0] ?? ''
    return {
      ref: { id: messageId, chatId, native: { messageId, conversationId: sent.conversationId, channel: type } },
      raw: res.json as GhlWebhookBody,
    }
  }

  /* Capability-gated actions ---------------------------------------------- */

  /** Download an inbound attachment (public HighLevel/CDN URL) through secureFetch. */
  async downloadMedia(ref: MediaRef): Promise<Buffer> {
    const token = ref.token as { url?: unknown } | string | undefined
    const url = typeof token === 'string' ? token : typeof token?.url === 'string' ? token.url : undefined
    if (!url) throw new ProviderError('downloadMedia requires the attachment URL (MediaRef.token.url)')
    const { response, body } = await secureFetch(url, { ...this.config.http, method: 'GET' })
    if (!response.ok) throw new ProviderError(`HighLevel media download failed: HTTP ${response.status}`)
    return body
  }

  /**
   * Mark the conversations of these messages as read in HighLevel
   * (`PUT /conversations/{id}` with `unreadCount: 0`). Refs without a known
   * conversation id (`ref.native.conversationId`) are skipped.
   */
  async markRead(refs: MessageRef[]): Promise<void> {
    const seen = new Set<string>()
    for (const ref of refs) {
      const native = ref.native as { conversationId?: unknown } | undefined
      const conversationId = typeof native?.conversationId === 'string' ? native.conversationId : undefined
      if (!conversationId || seen.has(conversationId)) continue
      seen.add(conversationId)
      const res = await request(this.url(`/conversations/${encodeURIComponent(conversationId)}`), {
        method: 'PUT',
        headers: this.headers(true),
        body: JSON.stringify({ locationId: this.config.locationId, unreadCount: 0 }),
      }, this.config.http)
      if (!res.ok) throw toGhlError(res.status, res.json as GhlErrorBody, ref.chatId, retryAfterMs(res.headers))
    }
  }

  /** HighLevel has no interaction acknowledgement — no-op. */
  async acknowledgeInteraction(_interactionId: string, _opts?: { text?: string; defer?: boolean }): Promise<void> {}
}
