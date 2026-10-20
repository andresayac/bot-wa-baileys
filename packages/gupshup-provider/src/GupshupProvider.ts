/**
 * GupshupProvider — WhatsApp through Gupshup's WhatsApp API (v1 send
 * endpoints, v2 callback format). Webhook-based (pushIngress): register the
 * callback URL in the Gupshup console (v2 payloads) and forward each POST to
 * `ingestRequest()` / `ingest()`.
 *
 * Gupshup does not sign callbacks, so the provider authenticates them with a
 * shared token embedded in the callback URL (or a header), compared in
 * constant time. Gupshup also documents IP allow-listing — do both in prod.
 *
 * @example
 * ```ts
 * const provider = new GupshupProvider({
 *   apiKey: process.env.GUPSHUP_API_KEY!,
 *   appName: 'MyBotApp',
 *   source: '917834811114',
 *   webhookToken: process.env.GUPSHUP_WEBHOOK_TOKEN!,   // callback: https://bot.example.com/gupshup?token=…
 * })
 * app.post('/gupshup', express.raw({ type: '*\/*' }), (req, res) => {
 *   res.sendStatus(provider.ingestRequest({ url: req.originalUrl, body: req.body, headers: req.headers }))
 * })
 * ```
 */

import pino from 'pino'
import type { LoggerLike } from '@bot-wa/core'
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
import { ProviderError } from '@bot-wa/core'
import { fetchTyped, header, rawText, request, retryAfterMs, safeEqual, type HeaderBag } from './http.js'
import { parseInbound } from './parseInbound.js'
import { toOutbound } from './toOutbound.js'
import { toGupshupError } from './errors.js'
import type { GupshupCallback, GupshupProviderConfig, GupshupSendResponse } from './types.js'

export interface GupshupIngestRequest {
  /** The request URL (absolute, or path + query like express `req.originalUrl`). */
  url: string
  /** Raw body (string/Buffer) or the parsed JSON object. */
  body: unknown
  headers?: HeaderBag
}

export class GupshupProvider implements IProvider<GupshupCallback> {
  readonly id = 'gupshup'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'buttons', 'list', 'template', 'native'],
    maxTextLength: 4096,
    buttons: true, lists: true, polls: false, reactions: false, edit: false,
    typing: false, presence: false, readReceipts: false, groups: false, templates: true,
    interactionsRequireAck: false, pushIngress: true, streaming: 'none', forms: 'degraded',
    textFormat: 'whatsapp', // WhatsApp markup: *bold* _italic_ ~strike~
  }

  private readonly config: GupshupProviderConfig & { baseUrl: string; webhookTokenHeader: string; webhookTokenParam: string }
  private readonly logger: LoggerLike
  private readonly listeners = new Set<(e: InboundEvent<GupshupCallback>) => void | Promise<void>>()

  constructor(config: GupshupProviderConfig) {
    if (!config.apiKey) throw new Error('GupshupProvider requires `apiKey`.')
    if (!config.appName) throw new Error('GupshupProvider requires `appName` (src.name).')
    if (!config.source) throw new Error('GupshupProvider requires `source` (the business WhatsApp number).')
    if (!config.webhookToken && !config.allowUnsignedWebhooks) {
      throw new Error(
        'GupshupProvider requires `webhookToken` to authenticate callbacks (Gupshup does not sign them). ' +
          'For isolated local development only, set `allowUnsignedWebhooks: true` explicitly.',
      )
    }
    // `??` per field: an explicit `undefined` (e.g. an unset env var) keeps the default.
    this.config = {
      ...config,
      baseUrl: config.baseUrl ?? 'https://api.gupshup.io',
      webhookTokenHeader: config.webhookTokenHeader ?? 'x-webhook-token',
      webhookTokenParam: config.webhookTokenParam ?? 'token',
    }
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    if (!config.webhookToken) {
      this.logger.warn('GupshupProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.')
    }
  }

  get connection(): unknown { return null }
  get selfId(): UserId | null { return this.config.selfId ?? this.config.source }

  /* Events ---------------------------------------------------------------- */

  onEvent(listener: (e: InboundEvent<GupshupCallback>) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private fan(e: InboundEvent<GupshupCallback>): void {
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
   * Feed a callback POST authenticated by the token HEADER
   * (`webhookTokenHeader`). Returns 200 accepted, 400 unreadable, 401 bad token.
   */
  ingest(rawEvent: unknown, headers?: HeaderBag): number {
    return this.handle(rawEvent, header(headers, this.config.webhookTokenHeader))
  }

  /**
   * Feed a callback POST authenticated by the token in the URL query
   * (`webhookTokenParam`) or, failing that, the token header.
   */
  ingestRequest(req: GupshupIngestRequest): number {
    let token: string | undefined
    try {
      token = new URL(req.url, 'http://callback.local').searchParams.get(this.config.webhookTokenParam) ?? undefined
    } catch {
      token = undefined
    }
    return this.handle(req.body, token ?? header(req.headers, this.config.webhookTokenHeader))
  }

  private handle(rawEvent: unknown, token: string | undefined): number {
    if (this.config.webhookToken && !(token !== undefined && safeEqual(token, this.config.webhookToken))) {
      this.logger.warn('Gupshup callback rejected: missing or invalid webhook token')
      return 401
    }
    let body: unknown = rawEvent
    const raw = rawText(rawEvent)
    if (raw !== undefined) {
      if (raw.trim() === '') return 200 // Gupshup's URL-validation ping
      try { body = JSON.parse(raw) } catch { return 400 }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 400
    for (const event of parseInbound(body as GupshupCallback)) this.fan(event)
    return 200
  }

  /* Outbound -------------------------------------------------------------- */

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<GupshupCallback>> {
    if (options?.quoted) this.logger.debug('Gupshup v1 send API has no reply context; ignoring options.quoted')
    const out = toOutbound(content)
    const form = new URLSearchParams()
    form.append('channel', 'whatsapp')
    form.append('source', this.config.source)
    form.append('destination', chatId)
    form.append('src.name', this.config.appName)
    let path: string
    if (out.endpoint === 'template') {
      path = '/wa/api/v1/template/msg'
      form.append('template', JSON.stringify(out.template))
    } else {
      path = '/wa/api/v1/msg'
      form.append('message', JSON.stringify(out.message))
    }
    for (const [key, value] of Object.entries(options?.platformData ?? {})) {
      if (value !== undefined && value !== null) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }

    const res = await request(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { apikey: this.config.apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    }, this.config.http)
    const sent = res.json as GupshupSendResponse
    if (!res.ok || sent.status === 'error' || !sent.messageId) {
      const detail = typeof sent.message === 'string' ? sent.message : res.body.toString('utf8').slice(0, 200) || undefined
      throw toGupshupError(res.status, detail, chatId, retryAfterMs(res.headers))
    }
    return { ref: { id: sent.messageId, chatId, native: { gsId: sent.messageId } }, raw: res.json as GupshupCallback }
  }

  /* Capability-gated actions ---------------------------------------------- */

  /** Download inbound media from its (expiring) Gupshup file-manager URL through secureFetch. */
  async downloadMedia(ref: MediaRef): Promise<Buffer> {
    const token = ref.token as { url?: unknown } | string | undefined
    const url = typeof token === 'string' ? token : typeof token?.url === 'string' ? token.url : undefined
    if (!url) throw new ProviderError('downloadMedia requires the Gupshup media URL (MediaRef.token.url)')
    const { response, body } = await fetchTyped(url, { ...this.config.http, method: 'GET' })
    if (!response.ok) throw new ProviderError(`Gupshup media download failed: HTTP ${response.status}`)
    return body
  }

  /** Quick replies / list replies need no acknowledgement — no-op. */
  async acknowledgeInteraction(_interactionId: string, _opts?: { text?: string; defer?: boolean }): Promise<void> {}
}
