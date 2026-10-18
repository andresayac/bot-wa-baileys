/**
 * EvolutionProvider — Evolution API v2 (self-hosted WhatsApp REST gateway on
 * Baileys) transport for @bot-wa/core.
 *
 *  - Outbound: `POST {baseUrl}/message/<endpoint>/{instance}` with the `apikey`
 *    header, through `secureFetch` (@bot-wa/http).
 *  - Inbound: Evolution POSTs webhooks; the host hands each body (and headers)
 *    to {@link EvolutionProvider.ingest}, which authenticates it (static shared
 *    secret header or Evolution's `jwt_key` HS256 JWT) before normalizing.
 *  - Identity: LID/PN twins are reconciled in-provider (see `identity.ts`).
 *
 * @example
 * ```ts
 * const provider = new EvolutionProvider({
 *   baseUrl: 'http://localhost:8080',
 *   apiKey: process.env.EVOLUTION_API_KEY!,
 *   instance: 'my-instance',
 *   webhookSecret: process.env.EVOLUTION_WEBHOOK_SECRET!,
 * })
 * const bot = new Bot({ provider })
 * app.post('/webhook/evolution', express.text({ type: '*\/*' }), (req, res) => {
 *   res.sendStatus(provider.ingest(req.body, req.headers))
 * })
 * ```
 */

import pino, { type Logger } from 'pino'
import type {
  ChatId,
  ConnectionState,
  DisconnectReason,
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
import {
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
} from '@bot-wa/core'
import { WaIdentityStore, normalizeJid } from './identity.js'
import { normalizeEventName, parseWebhook } from './parseInbound.js'
import { describeErrorBody, isRecord, resolveHttpPolicy, restCall, type RestHttpOptions } from './rest.js'
import { keyFromRef, toOutbound } from './toOutbound.js'
import type { EvolutionMediaToken, EvolutionProviderConfig, EvolutionWebhook } from './types.js'
import { bearerToken, headerValue, safeEqual, verifyHs256Jwt, type HeaderBag } from './webhookAuth.js'

/** True when an Evolution 400 body says the number is not on WhatsApp (`exists: false`). */
function saysNotOnWhatsApp(body: unknown): boolean {
  const response = isRecord(body) && isRecord(body.response) ? body.response : undefined
  const message = response?.message
  if (Array.isArray(message)) return message.some((m) => isRecord(m) && m.exists === false)
  return typeof message === 'string' && /not (exist|found)|exists.?:.?false/i.test(message)
}

/** Translate an Evolution API error response into a typed provider error. */
export function toEvolutionError(status: number, body: unknown, chatId: ChatId, retryAfterMs?: number): ProviderError {
  const detail = describeErrorBody(body)
  const desc = `Evolution API HTTP ${status}${detail ? `: ${detail}` : ''}`
  if (status === 429) return new RateLimitedError(retryAfterMs ?? 1000, desc)
  if (status === 413) return new PayloadTooLargeError(desc)
  if ((status === 400 || status === 404) && saysNotOnWhatsApp(body)) return new RecipientUnreachableError(chatId, desc)
  if (status === 401 || status === 403) return new ProviderError(`Unauthorized — check the Evolution apiKey (${desc})`)
  if (status === 404) return new ProviderError(`Instance or resource not found (${desc})`)
  return new ProviderError(desc)
}

export class EvolutionProvider implements IProvider<unknown> {
  readonly id = 'evolution'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll', 'reaction', 'buttons', 'list', 'card', 'native'],
    maxTextLength: 65_536,
    buttons: false,       // degrades to numbered text
    lists: false,         // degrades to numbered text
    polls: true,          // sendPoll
    reactions: true,      // sendReaction
    edit: true,           // chat/updateMessage (text)
    typing: true,         // chat/sendPresence
    presence: false,
    readReceipts: true,   // chat/markMessageAsRead
    groups: true,
    templates: false,
    interactionsRequireAck: false,
    pushIngress: true,    // webhook-only
    streaming: 'none', // WhatsApp: no live preview, ctx.stream() sends chunks
    forms: 'degraded', // flow().form() asks field by field
    textFormat: 'whatsapp', // WhatsApp markup: *bold* _italic_ ~strike~
  }

  private readonly baseUrl: string
  private readonly instancePath: string
  private readonly http: RestHttpOptions
  private readonly logger: Logger
  private readonly identity: WaIdentityStore
  private readonly listeners = new Set<(e: InboundEvent) => void | Promise<void>>()
  private _selfId: string | null

  constructor(private readonly config: EvolutionProviderConfig) {
    if (!config.baseUrl) throw new Error('EvolutionProvider requires `baseUrl`')
    if (!config.apiKey) throw new Error('EvolutionProvider requires `apiKey`')
    if (!config.instance) throw new Error('EvolutionProvider requires `instance`')
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    if (!config.webhookSecret && !config.webhookJwtKey && !config.allowUnsignedWebhooks) {
      throw new Error(
        'EvolutionProvider requires `webhookSecret` (custom webhook header) or `webhookJwtKey` (Evolution jwt_key) ' +
          'to authenticate webhooks. For isolated local development only, set `allowUnsignedWebhooks: true` explicitly.',
      )
    }
    if (!config.webhookSecret && !config.webhookJwtKey) {
      this.logger.warn('EvolutionProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.')
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.instancePath = encodeURIComponent(config.instance)
    this.http = resolveHttpPolicy(this.baseUrl, config.http)
    this.identity = new WaIdentityStore(config.identityCacheSize, config.identityPersistence)
    this._selfId = normalizeJid(config.selfId) ?? null
  }

  get connection(): unknown { return null }
  get selfId(): UserId | null { return this._selfId }

  /* Events ---------------------------------------------------------------- */

  onEvent(listener: (e: InboundEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private fan(e: InboundEvent): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(e))
          .catch((error) => this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed'))
      } catch (error) {
        this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed')
      }
    }
  }

  private emitConnection(state: ConnectionState, extra: { reason?: DisconnectReason; detail?: string; authPayload?: unknown } = {}): void {
    this.fan({
      kind: 'connection',
      update: {
        state,
        ...(extra.reason ? { reason: extra.reason } : {}),
        ...(extra.detail ? { detail: { message: extra.detail } } : {}),
        ...(extra.authPayload !== undefined ? { authPayload: extra.authPayload } : {}),
      },
    })
  }

  /* REST ------------------------------------------------------------------ */

  private async api<T = unknown>(method: string, path: string, body?: unknown, chatId: ChatId = ''): Promise<T> {
    const res = await restCall(`${this.baseUrl}${path}`, { method, headers: { apikey: this.config.apiKey }, body }, this.http)
    if (!res.ok) throw toEvolutionError(res.status, res.body, chatId, res.retryAfterMs)
    return res.body as T
  }

  /* Lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    this.emitConnection('connecting')
    let state: string | undefined
    try {
      const res = await this.api<{ instance?: { state?: string }; state?: string }>('GET', `/instance/connectionState/${this.instancePath}`)
      state = res?.instance?.state ?? res?.state
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.emitConnection('closed', { reason: /unauthorized|not found/i.test(detail) ? 'sessionInvalid' : 'transient', detail })
      throw err
    }
    if (this._selfId == null) await this.resolveSelfId()
    if (state === 'open') {
      this.emitConnection('ready')
      return
    }
    // Not paired yet (or reconnecting): ask Evolution to connect and surface the QR / pairing code.
    try {
      const qr = await this.api<{ code?: string; pairingCode?: string }>('GET', `/instance/connect/${this.instancePath}`)
      const authPayload = qr?.code ?? qr?.pairingCode
      if (authPayload) this.emitConnection('authenticating', { authPayload })
    } catch (err) {
      this.logger.warn({ err }, 'Evolution instance/connect failed; waiting for connection.update webhooks')
    }
  }

  async stop(): Promise<void> {
    this.emitConnection('closed')
  }

  private async resolveSelfId(): Promise<void> {
    try {
      const list = await this.api<unknown>('GET', `/instance/fetchInstances?instanceName=${this.instancePath}`)
      const first: unknown = Array.isArray(list) ? list[0] : list
      if (!isRecord(first)) return
      const inner = isRecord(first.instance) ? first.instance : first
      const owner = normalizeJid(inner.ownerJid ?? inner.owner)
      if (owner) this._selfId = this.identity.resolve(owner) ?? owner
    } catch (err) {
      this.logger.debug({ err }, 'Evolution fetchInstances failed; selfId stays unknown')
    }
  }

  /* Webhook --------------------------------------------------------------- */

  private authorized(headers?: HeaderBag): boolean {
    const { webhookSecret, webhookJwtKey } = this.config
    if (!webhookSecret && !webhookJwtKey) return this.config.allowUnsignedWebhooks === true
    const bearer = bearerToken(headers)
    if (webhookSecret) {
      const presented = headerValue(headers, this.config.webhookSecretHeader ?? 'x-webhook-secret') ?? bearer
      if (safeEqual(presented, webhookSecret)) return true
    }
    if (webhookJwtKey && bearer && verifyHs256Jwt(bearer, webhookJwtKey, { claims: { app: 'evolution', action: 'webhook' } })) return true
    return false
  }

  /**
   * Feed one webhook POST (raw body string/Buffer — or the parsed object) plus
   * its headers. Returns the HTTP status to answer with: 200 accepted (also for
   * other instances' or unknown events, so Evolution does not retry), 401 when
   * authentication fails, 400 when the body is not an Evolution webhook.
   */
  ingest(rawEvent: unknown, headers?: HeaderBag): number {
    if (!this.authorized(headers)) {
      this.logger.warn('ingest: rejected Evolution webhook with missing/invalid credentials')
      return 401
    }
    let body: unknown = rawEvent
    if (typeof rawEvent === 'string' || Buffer.isBuffer(rawEvent)) {
      try {
        body = JSON.parse(rawEvent.toString())
      } catch {
        return 400
      }
    }
    if (!isRecord(body) || typeof body.event !== 'string') return 400
    const hook = body as unknown as EvolutionWebhook
    if (hook.instance && hook.instance !== this.config.instance) {
      this.logger.debug('ingest: ignoring webhook for another instance')
      return 200
    }
    const event = normalizeEventName(hook.event)
    if (event === 'connection.update' && isRecord(hook.data) && hook.data.state === 'open') {
      const wuid = normalizeJid(hook.data.wuid)
      if (wuid) this._selfId = this.identity.resolve(wuid) ?? wuid
    }
    for (const e of parseWebhook(hook, { identity: this.identity, selfId: this._selfId })) this.fan(e)
    return 200
  }

  /* Outbound -------------------------------------------------------------- */

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    const out = await toOutbound(chatId, content)
    const body = out.body
    if (options?.quoted && content.kind !== 'reaction') body.quoted = { key: keyFromRef(options.quoted) }
    if (options?.mentions?.length) body.mentioned = options.mentions
    if (options?.platformData) Object.assign(body, options.platformData)
    const result = await this.api<unknown>('POST', `/message/${out.endpoint}/${this.instancePath}`, body, chatId)
    const key = isRecord(result) && isRecord(result.key) ? result.key : undefined
    const id = typeof key?.id === 'string' ? key.id : ''
    return { ref: { id, chatId, native: key ?? result }, raw: result }
  }

  /** Inline base64 (instance `webhookBase64: true`) or `chat/getBase64FromMediaMessage`. */
  async downloadMedia(ref: MediaRef): Promise<Buffer> {
    const token = ref.token as EvolutionMediaToken | undefined
    if (!token || !isRecord(token.key)) throw new ProviderError('downloadMedia requires an Evolution media token (MediaRef.token)')
    if (token.base64) return Buffer.from(token.base64, 'base64')
    const res = await this.api<{ base64?: string }>('POST', `/chat/getBase64FromMediaMessage/${this.instancePath}`, {
      message: { key: token.key },
      convertToMp4: this.config.convertAudioToMp4 ?? false,
    })
    if (!res || typeof res.base64 !== 'string') throw new ProviderError('Evolution getBase64FromMediaMessage returned no base64')
    return Buffer.from(res.base64, 'base64')
  }

  async markRead(refs: MessageRef[]): Promise<void> {
    if (refs.length === 0) return
    await this.api('POST', `/chat/markMessageAsRead/${this.instancePath}`, { readMessages: refs.map(keyFromRef) })
  }

  /** chat/sendPresence: `composing` / `recording` / `paused`. Evolution holds the presence for `delay` ms. */
  async typing(chatId: ChatId, state: 'typing' | 'recording' | 'paused' = 'typing'): Promise<void> {
    const presence = state === 'typing' ? 'composing' : state
    await this.api('POST', `/chat/sendPresence/${this.instancePath}`, { number: chatId, presence, delay: state === 'paused' ? 0 : 1200 }, chatId)
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    const key = keyFromRef(ref)
    await this.api('DELETE', `/chat/deleteMessageForEveryone/${this.instancePath}`, {
      id: key.id,
      remoteJid: key.remoteJid,
      fromMe: key.fromMe ?? true,
      ...(key.participant ? { participant: key.participant } : {}),
    }, ref.chatId)
  }

  /** chat/updateMessage — text only. */
  async editMessage(ref: MessageRef, content: OutboundContent): Promise<SendResult<unknown>> {
    if (content.kind !== 'text') throw new UnsupportedContentError(content.kind, 'EvolutionProvider.editMessage supports text only')
    const key = { ...keyFromRef(ref), fromMe: true }
    const result = await this.api('POST', `/chat/updateMessage/${this.instancePath}`, { number: ref.chatId, key, text: content.text }, ref.chatId)
    return { ref, raw: result }
  }
}
