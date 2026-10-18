/**
 * TwilioProvider — WhatsApp + SMS/MMS through Twilio Programmable Messaging.
 * Webhook-based (pushIngress): the host serves the webhook, and forwards each
 * POST to `ingest()` (or `ingestRequest()` when the URL varies per request).
 * Every webhook is authenticated with `X-Twilio-Signature` computed over the
 * EXACT URL + the POST params (HMAC-SHA1 with the auth token).
 *
 * @example
 * ```ts
 * const provider = new TwilioProvider({
 *   accountSid: process.env.TWILIO_SID!,
 *   authToken: process.env.TWILIO_TOKEN!,
 *   whatsappFrom: 'whatsapp:+14155238886',
 *   smsFrom: '+15017122661',
 *   webhookUrl: 'https://bot.example.com/twilio/webhook',
 * })
 * app.post('/twilio/webhook', express.raw({ type: '*\/*' }), (req, res) => {
 *   res.status(provider.ingest(req.body, req.headers)).type('text/xml').send('<Response/>')
 * })
 * ```
 */

import pino, { type Logger } from 'pino'
import type {
  ChatId,
  IProvider,
  InboundEvent,
  MediaRef,
  OutboundContent,
  ProviderCapabilities,
  SendOptions,
  SendResult,
  UserId,
} from '@bot-wa/core'
import { PayloadTooLargeError, ProviderError } from '@bot-wa/core'
import { secureFetch } from '@bot-wa/http'
import { BoundedMap, header, rawText, request, retryAfterMs, type HeaderBag } from './http.js'
import { channelOf, parseInbound } from './parseInbound.js'
import { bodySha256, paramsFromObject, parseFormParams, verifyTwilioSignature, type TwilioParams } from './signature.js'
import { toOutbound } from './toOutbound.js'
import { toTwilioError } from './errors.js'
import type { TwilioErrorBody, TwilioMessageResource, TwilioProviderConfig, TwilioWebhookParams } from './types.js'

/** Twilio's body limit for one message (SMS concatenation and WhatsApp alike). */
export const TWILIO_MAX_BODY = 1600

export interface TwilioIngestRequest {
  /** The full URL Twilio requested (scheme, host, path and query) — what it signed. */
  url: string
  /** Raw body (string/Buffer), or the parsed form object. */
  body: unknown
  headers?: HeaderBag
}

export class TwilioProvider implements IProvider<TwilioWebhookParams> {
  readonly id = 'twilio'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'buttons', 'list', 'template', 'native'],
    maxTextLength: TWILIO_MAX_BODY,
    buttons: false, lists: false, polls: false, reactions: false, edit: false,
    typing: true, presence: false, readReceipts: false, groups: false, templates: true,
    interactionsRequireAck: false, pushIngress: true, streaming: 'none', forms: 'degraded',
  }

  private readonly config: TwilioProviderConfig & { apiBaseUrl: string; messagingBaseUrl: string }
  private readonly logger: Logger
  private readonly listeners = new Set<(e: InboundEvent<TwilioWebhookParams>) => void | Promise<void>>()
  /** chatId → the business address that received the chat's last message (reply sender). */
  private readonly replyFrom = new BoundedMap<ChatId, string>()
  /** chatId → SID of the chat's last inbound message (WhatsApp typing indicator). */
  private readonly lastInbound = new BoundedMap<ChatId, string>()

  constructor(config: TwilioProviderConfig) {
    if (!config.accountSid) throw new Error('TwilioProvider requires `accountSid`.')
    if (!config.authToken && !config.allowUnsignedWebhooks) {
      throw new Error('TwilioProvider requires `authToken` (it signs every webhook).')
    }
    if (!config.authToken && !(config.apiKeySid && config.apiKeySecret)) {
      throw new Error('TwilioProvider requires `authToken` or `apiKeySid` + `apiKeySecret` for REST calls.')
    }
    // `??` per field: an explicit `undefined` (e.g. an unset env var) keeps the default.
    this.config = {
      ...config,
      apiBaseUrl: config.apiBaseUrl ?? 'https://api.twilio.com',
      messagingBaseUrl: config.messagingBaseUrl ?? 'https://messaging.twilio.com',
    }
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    if (config.allowUnsignedWebhooks) {
      this.logger.warn('TwilioProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.')
    }
  }

  get connection(): unknown { return null }
  get selfId(): UserId | null { return this.config.selfId ?? null }

  /* Events ---------------------------------------------------------------- */

  onEvent(listener: (e: InboundEvent<TwilioWebhookParams>) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private fan(e: InboundEvent<TwilioWebhookParams>): void {
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
   * Feed a webhook POST whose URL is the configured `webhookUrl` (or rebuilt
   * from `webhookPath` + Host headers). Pass the RAW body. Returns the HTTP
   * status to answer: 200 accepted, 400 unreadable, 403 bad/missing signature.
   */
  ingest(rawEvent: unknown, headers?: HeaderBag): number {
    const url = this.config.webhookUrl ?? this.urlFromHeaders(headers)
    return this.handleWebhook({ url: url ?? '', body: rawEvent, ...(headers ? { headers } : {}) }, true)
  }

  /**
   * Feed a webhook POST with the exact URL Twilio called (multi-tenant /
   * dynamic paths). For JSON webhooks that URL must include the
   * `bodySHA256` query parameter Twilio added; without it the request is 403.
   */
  ingestRequest(req: TwilioIngestRequest): number {
    return this.handleWebhook(req, false)
  }

  /**
   * `deriveBodyHash`: the URL is the configured base URL, which never has the
   * per-request `bodySHA256`. For a JSON body, append the hash of the received
   * body the way Twilio does; the signature then covers that hash, so a
   * different body cannot reuse it.
   */
  private handleWebhook(req: TwilioIngestRequest, deriveBodyHash: boolean): number {
    const raw = rawText(req.body)
    let params: TwilioParams
    let jsonBody = false
    if (raw !== undefined) {
      const type = header(req.headers, 'content-type') ?? ''
      if (type.includes('application/json') || raw.trimStart().startsWith('{')) {
        jsonBody = true
        try {
          const parsed: unknown = JSON.parse(raw)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 400
          params = paramsFromObject(parsed as Record<string, unknown>)
        } catch {
          return 400
        }
      } else {
        params = parseFormParams(raw)
      }
    } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      params = paramsFromObject(req.body as Record<string, unknown>)
    } else {
      return 400
    }

    if (!this.config.allowUnsignedWebhooks) {
      if (!req.url) {
        this.logger.error('Twilio webhook rejected: no webhook URL to verify against (set `webhookUrl` or use ingestRequest)')
        return 403
      }
      let url = req.url
      if (jsonBody && deriveBodyHash && !hasBodyHash(url)) {
        url = `${url}${url.includes('?') ? '&' : '?'}bodySHA256=${bodySha256(raw as string)}`
      }
      const ok = verifyTwilioSignature({
        authToken: this.config.authToken,
        signature: header(req.headers, 'x-twilio-signature'),
        url,
        ...(jsonBody ? { rawBody: raw as string } : { params }),
      })
      if (!ok) {
        this.logger.warn('Twilio webhook rejected: invalid X-Twilio-Signature')
        return 403
      }
    }

    const parsed = parseInbound(params)
    if (parsed.inbound) {
      if (parsed.inbound.to) this.replyFrom.set(parsed.inbound.chatId, parsed.inbound.to)
      this.lastInbound.set(parsed.inbound.chatId, parsed.inbound.messageSid)
    }
    for (const event of parsed.events) this.fan(event)
    return 200
  }

  private urlFromHeaders(headers: HeaderBag | undefined): string | undefined {
    const path = this.config.webhookPath
    if (!path) return undefined
    const host = header(headers, 'x-forwarded-host') ?? header(headers, 'host')
    if (!host) return undefined
    const proto = (header(headers, 'x-forwarded-proto') ?? 'https').split(',')[0]!.trim()
    return `${proto}://${host.split(',')[0]!.trim()}${path.startsWith('/') ? path : `/${path}`}`
  }

  /* Outbound -------------------------------------------------------------- */

  private authHeader(): string {
    const user = this.config.apiKeySid && this.config.apiKeySecret ? this.config.apiKeySid : this.config.accountSid
    const pass = this.config.apiKeySid && this.config.apiKeySecret ? this.config.apiKeySecret : this.config.authToken
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  }

  /** The sender for a chat: the number it wrote to, else the per-channel default, else the service. */
  private senderFor(chatId: ChatId): { From: string } | { MessagingServiceSid: string } {
    const remembered = this.replyFrom.get(chatId)
    if (remembered) return { From: remembered }
    const channel = channelOf(chatId)
    const configured = channel === 'whatsapp' ? this.config.whatsappFrom : channel === 'sms' ? this.config.smsFrom : undefined
    if (configured) return { From: configured }
    if (this.config.messagingServiceSid) return { MessagingServiceSid: this.config.messagingServiceSid }
    throw new ProviderError(
      `TwilioProvider has no sender for '${channel}' chats — set ${channel === 'whatsapp' ? 'whatsappFrom' : 'smsFrom'} or messagingServiceSid.`,
    )
  }

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<TwilioWebhookParams>> {
    if (options?.quoted) this.logger.debug('Twilio Messages API has no reply context; ignoring options.quoted')
    const params = toOutbound(content)
    const body = params['Body']
    if (typeof body === 'string' && body.length > TWILIO_MAX_BODY) {
      throw new PayloadTooLargeError(`Twilio message body is ${body.length} chars; the limit is ${TWILIO_MAX_BODY}.`)
    }
    const native = options?.platformData ?? {}
    const sender = typeof native['From'] === 'string' ? { From: native['From'] } : this.senderFor(chatId)
    const form = new URLSearchParams()
    form.append('To', chatId)
    for (const [key, value] of Object.entries(sender)) form.append(key, value)
    if (this.config.statusCallback) form.append('StatusCallback', this.config.statusCallback)
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) for (const item of value) form.append(key, item)
      else form.append(key, value)
    }

    const url = `${this.config.apiBaseUrl.replace(/\/$/, '')}/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`
    const res = await request(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    }, this.config.http)
    if (!res.ok) throw toTwilioError(res.status, res.json as TwilioErrorBody, chatId, retryAfterMs(res.headers))
    const resource = res.json as TwilioMessageResource
    const sid = resource.sid ?? ''
    return {
      ref: { id: sid, chatId, native: { sid, channel: channelOf(chatId) } },
      raw: res.json as TwilioWebhookParams,
    }
  }

  /* Capability-gated actions ---------------------------------------------- */

  /**
   * Download inbound media (`MediaUrl{N}`). Basic auth is sent only to the
   * Twilio API origin; the redirect to the CDN drops it (secureFetch strips
   * credentials on cross-origin hops).
   */
  async downloadMedia(ref: MediaRef): Promise<Buffer> {
    const token = ref.token as { url?: unknown } | string | undefined
    const url = typeof token === 'string' ? token : typeof token?.url === 'string' ? token.url : undefined
    if (!url) throw new ProviderError('downloadMedia requires the Twilio media URL (MediaRef.token.url)')
    const sameOrigin = (() => {
      try { return new URL(url).origin === new URL(this.config.apiBaseUrl).origin } catch { return false }
    })()
    const { response, body } = await secureFetch(url, {
      ...this.config.http,
      method: 'GET',
      ...(sameOrigin ? { headers: { Authorization: this.authHeader() } } : {}),
    })
    if (!response.ok) throw new ProviderError(`Twilio media download failed: HTTP ${response.status}`)
    return body
  }

  /**
   * WhatsApp typing indicator (Messaging v3 `Indicators/Typing`). Twilio needs
   * the SID of the message being answered, so it applies to WhatsApp chats
   * with a recent inbound message; otherwise (SMS, `paused`) it is a no-op.
   * Side effect documented by Twilio: the referenced message is marked read.
   */
  async typing(chatId: ChatId, state?: 'typing' | 'recording' | 'paused'): Promise<void> {
    if (state === 'paused' || channelOf(chatId) !== 'whatsapp') return
    const messageId = this.lastInbound.get(chatId)
    if (!messageId) return
    const url = `${this.config.messagingBaseUrl.replace(/\/$/, '')}/v3/Indicators/Typing.json`
    const res = await request(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ messageId, channel: 'whatsapp' }),
    }, this.config.http)
    if (!res.ok) throw toTwilioError(res.status, res.json as TwilioErrorBody, chatId, retryAfterMs(res.headers))
  }

  /** Twilio quick replies need no acknowledgement — no-op. */
  async acknowledgeInteraction(_interactionId: string, _opts?: { text?: string; defer?: boolean }): Promise<void> {}
}

function hasBodyHash(url: string): boolean {
  try {
    return new URL(url).searchParams.has('bodySHA256')
  } catch {
    return false
  }
}
