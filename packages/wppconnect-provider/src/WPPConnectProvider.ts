/**
 * WPPConnectProvider — wppconnect-server (WA-JS REST gateway) transport for
 * @bot-wa/core.
 *
 *  - Outbound: `POST {baseUrl}/api/{session}/<endpoint>` with
 *    `Authorization: Bearer <token>`, through `secureFetch` (@bot-wa/http). With
 *    `secretKey`, the token is generated on `start()` and refreshed once on 401.
 *  - Inbound: the server POSTs webhooks (`onmessage`, `onack`, …); the host
 *    hands each body, headers and request URL to {@link WPPConnectProvider.ingest},
 *    which checks the shared token and the session before normalizing.
 *  - Identity: unknown LIDs are resolved via `contact/pn-lid` and linked to
 *    their phone number in-provider, so `senderId` stays stable.
 *
 * @example
 * ```ts
 * const provider = new WPPConnectProvider({
 *   session: 'my-bot',
 *   secretKey: process.env.WPP_SECRET_KEY!,
 *   webhookToken: process.env.WPP_WEBHOOK_TOKEN!,
 * })
 * // wppconnect-server config: webhook.url = 'https://bot.example.com/wpp?token=<WPP_WEBHOOK_TOKEN>'
 * app.post('/wpp', express.json(), async (req, res) => {
 *   res.sendStatus(await provider.ingest(req.body, req.headers, req.originalUrl))
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
import {
  WaIdentityStore,
  describeErrorBody,
  isGroupJid,
  isLidJid,
  isRecord,
  normalizeJid,
  resolveHttpPolicy,
  restCall,
  type RestHttpOptions,
} from '@bot-wa/wa-gateway-kit'
import { jidOf, lidsIn, parseWebhook, serializedId } from './parseInbound.js'
import { target, toOutbound } from './toOutbound.js'
import type { WPPConnectProviderConfig, WppMediaToken } from './types.js'
import { bearerToken, headerValue, safeEqual, type HeaderBag } from './webhookAuth.js'

const UNREACHABLE = /not exist|não existe|no existe|not registered|invalid wid|wid error|number.{0,20}invalid|not on whatsapp/i

/** Translate a wppconnect-server error response into a typed provider error. */
export function toWppError(status: number, body: unknown, chatId: ChatId, retryAfterMs?: number): ProviderError {
  const detail = describeErrorBody(body)
  const desc = `WPPConnect HTTP ${status}${detail ? `: ${detail}` : ''}`
  if (status === 429) return new RateLimitedError(retryAfterMs ?? 1000, desc)
  if (status === 413) return new PayloadTooLargeError(desc)
  if (status === 401 || status === 403) return new ProviderError(`Unauthorized — check the WPPConnect token/secretKey (${desc})`)
  if (status >= 400 && chatId && UNREACHABLE.test(typeof body === 'string' ? body : JSON.stringify(body ?? ''))) {
    return new RecipientUnreachableError(chatId, desc)
  }
  return new ProviderError(desc)
}

/** First message object of a `{ status: 'success', response }` envelope. */
function firstResult(body: unknown): unknown {
  const response = isRecord(body) && 'response' in body ? body.response : body
  return Array.isArray(response) ? response[0] : response
}

export class WPPConnectProvider implements IProvider<unknown> {
  readonly id = 'wppconnect'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll', 'reaction', 'buttons', 'list', 'card', 'native'],
    maxTextLength: 65_536,
    buttons: false,       // degrades to numbered text
    lists: false,         // degrades to numbered text
    polls: true,          // send-poll-message
    reactions: true,      // react-message
    edit: true,           // edit-message (text)
    typing: true,         // typing / recording
    presence: false,
    readReceipts: true,   // send-seen (per chat)
    groups: true,
    templates: false,
    interactionsRequireAck: false,
    pushIngress: true,    // webhook-only
    streaming: 'none', // WhatsApp: no live preview, ctx.stream() sends chunks
    forms: 'degraded', // flow().form() asks field by field
    textFormat: 'whatsapp', // WhatsApp markup: *bold* _italic_ ~strike~
  }

  private readonly baseUrl: string
  private readonly sessionPath: string
  private readonly http: RestHttpOptions
  private readonly logger: Logger
  private readonly identity: WaIdentityStore
  private readonly listeners = new Set<(e: InboundEvent) => void | Promise<void>>()
  /** LIDs whose pn-lid lookup failed or found no PN → time they may be retried (bounded). */
  private readonly lidRetryAt = new Map<string, number>()
  /** pn-lid lookups in flight, shared by concurrent webhooks. */
  private readonly lidInFlight = new Map<string, Promise<void>>()
  /** Settles when the previous webhook has emitted its events (per-provider FIFO). */
  private emitTail: Promise<void> = Promise.resolve()
  private token: string | undefined
  /** The generate-token request in flight, shared by concurrent callers. */
  private tokenInFlight: Promise<string> | undefined
  private _selfId: string | null

  constructor(private readonly config: WPPConnectProviderConfig) {
    if (!config.session) throw new Error('WPPConnectProvider requires `session`')
    if (!config.token && !config.secretKey) throw new Error('WPPConnectProvider requires `token` or `secretKey`')
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    if (!config.webhookToken && !config.allowUnsignedWebhooks) {
      throw new Error(
        'WPPConnectProvider requires `webhookToken` to authenticate webhooks (wppconnect-server does not sign them). ' +
          'For isolated local development only, set `allowUnsignedWebhooks: true` explicitly.',
      )
    }
    if (!config.webhookToken) {
      this.logger.warn('WPPConnectProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.')
    }
    this.baseUrl = (config.baseUrl ?? 'http://localhost:21465').replace(/\/+$/, '')
    this.sessionPath = encodeURIComponent(config.session)
    this.http = resolveHttpPolicy(this.baseUrl, config.http)
    this.identity = new WaIdentityStore(config.identityCacheSize, config.identityPersistence)
    this.token = config.token
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

  /**
   * A fresh bearer token, single-flight: concurrent callers (a burst of sends
   * at start-up, or several requests rejected with 401 on the same stale token)
   * share ONE generate-token request. `stale` is the token the caller saw
   * rejected; when another caller already replaced it, that token is reused
   * instead of generating again. A failed generation is not cached.
   */
  private async freshToken(stale?: string): Promise<string> {
    if (this.token && this.token !== stale) return this.token
    this.tokenInFlight ??= this.generateToken().finally(() => { this.tokenInFlight = undefined })
    return this.tokenInFlight
  }

  /** POST /api/{session}/{secretKey}/generate-token → bearer token. */
  private async generateToken(): Promise<string> {
    if (!this.config.secretKey) throw new ProviderError('WPPConnect token rejected and no secretKey configured to regenerate it')
    const res = await restCall(
      `${this.baseUrl}/api/${this.sessionPath}/${encodeURIComponent(this.config.secretKey)}/generate-token`,
      { method: 'POST', label: '/api/{session}/{secretKey}/generate-token' },
      this.http,
    )
    const token = isRecord(res.body) && typeof res.body.token === 'string' ? res.body.token : undefined
    if (!res.ok || !token) throw toWppError(res.ok ? 401 : res.status, res.ok ? 'generate-token returned no token' : res.body, '')
    this.token = token
    return token
  }

  private async api<T = unknown>(method: string, endpoint: string, body?: unknown, chatId: ChatId = '', http: RestHttpOptions = this.http): Promise<T> {
    const call = (token: string) => restCall(
      `${this.baseUrl}/api/${this.sessionPath}/${endpoint}`,
      { method, headers: { authorization: `Bearer ${token}` }, body, label: `/api/{session}/${endpoint.split('/')[0]}` },
      http,
    )
    const token = this.token ?? await this.freshToken()
    let res = await call(token)
    if (res.status === 401 && this.config.secretKey) {
      this.logger.debug('WPPConnect token rejected; regenerating once')
      res = await call(await this.freshToken(token))
    }
    if (!res.ok) throw toWppError(res.status, res.body, chatId, res.retryAfterMs)
    return res.body as T
  }

  /* Lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    this.emitConnection('connecting')
    let status: Record<string, unknown> | undefined
    try {
      if (this.config.startSession !== false) {
        await this.api('POST', 'start-session', { waitQrCode: false, ...(this.config.webhookUrl ? { webhook: this.config.webhookUrl } : {}) })
      }
      const res = await this.api<unknown>('GET', 'status-session')
      status = isRecord(res) ? res : undefined
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.emitConnection('closed', { reason: /unauthorized/i.test(detail) ? 'sessionInvalid' : 'transient', detail })
      throw err
    }
    const state = typeof status?.status === 'string' ? status.status : undefined
    if (state === 'CONNECTED' || state === 'inChat' || state === 'isLogged') {
      this.emitConnection('ready')
    } else if (state === 'QRCODE') {
      const qr = typeof status?.urlcode === 'string' && status.urlcode ? status.urlcode : status?.qrcode
      this.emitConnection('authenticating', qr ? { authPayload: qr } : {})
    }
    // Other states (INITIALIZING, CLOSED…) settle through `status-find` / `qrcode` webhooks.
  }

  async stop(): Promise<void> {
    this.emitConnection('closed')
  }

  /* Webhook --------------------------------------------------------------- */

  private authorized(headers?: HeaderBag, requestUrl?: string): boolean {
    const expected = this.config.webhookToken
    if (!expected) return this.config.allowUnsignedWebhooks === true
    const header = headerValue(headers, this.config.webhookTokenHeader ?? 'x-webhook-token')
    if (safeEqual(header, expected) || safeEqual(bearerToken(headers), expected)) return true
    if (requestUrl) {
      try {
        const param = new URL(requestUrl, 'http://ingest.local').searchParams.get(this.config.webhookTokenParam ?? 'token')
        if (param !== null && safeEqual(param, expected)) return true
      } catch {
        return false
      }
    }
    return false
  }

  /**
   * Link unknown LIDs to their phone number via `contact/pn-lid` (best effort).
   * Lookups run in parallel, capped per payload, with a short timeout; a LID
   * whose lookup is already in flight is awaited instead of re-requested, and a
   * failed one cools down for `lidRetryMs` before it is tried again.
   */
  private resolveLids(lids: string[]): Promise<void> {
    const now = Date.now()
    const todo = lids
      .filter((lid) => {
        const canonical = this.identity.lookup(lid)
        if (canonical && !isLidJid(canonical)) return false // already linked to a PN
        if (this.lidInFlight.has(lid)) return true
        const retryAt = this.lidRetryAt.get(lid)
        return retryAt === undefined || retryAt <= now
      })
      .slice(0, this.config.maxLidLookups ?? 5)
    return Promise.all(todo.map((lid) => this.lookupLid(lid))).then(() => undefined)
  }

  private lookupLid(lid: string): Promise<void> {
    const pending = this.lidInFlight.get(lid)
    if (pending) return pending
    const run = (async () => {
      try {
        const res = await this.api<unknown>('GET', `contact/pn-lid/${encodeURIComponent(lid)}`, undefined, '', {
          ...this.http,
          timeoutMs: this.config.lidLookupTimeoutMs ?? 5_000,
        })
        const entry = isRecord(res) && isRecord(res.response) ? res.response : res
        const pn = isRecord(entry) ? jidOf(entry.phoneNumber) : undefined
        if (pn && !isLidJid(pn)) {
          this.identity.resolve(pn, lid)
          this.lidRetryAt.delete(lid)
        } else {
          this.coolDown(lid)
        }
      } catch (err) {
        this.coolDown(lid)
        this.logger.debug({ err }, 'WPPConnect pn-lid lookup failed')
      } finally {
        this.lidInFlight.delete(lid)
      }
    })()
    this.lidInFlight.set(lid, run)
    return run
  }

  private coolDown(lid: string): void {
    this.lidRetryAt.delete(lid)
    this.lidRetryAt.set(lid, Date.now() + (this.config.lidRetryMs ?? 300_000))
    const max = this.config.identityCacheSize ?? 10_000
    while (this.lidRetryAt.size > max) {
      const oldest = this.lidRetryAt.keys().next().value
      if (oldest === undefined) break
      this.lidRetryAt.delete(oldest)
    }
  }

  /**
   * Feed one webhook POST: the body (raw string/Buffer or parsed object), the
   * request headers and, when the token travels in the query string, the
   * request URL (path + query is enough). Resolves to the HTTP status to answer
   * with: 200 accepted (also for other sessions or unknown events), 401 bad or
   * missing token, 400 not a wppconnect webhook.
   */
  async ingest(rawEvent: unknown, headers?: HeaderBag, requestUrl?: string): Promise<number> {
    if (!this.authorized(headers, requestUrl)) {
      this.logger.warn('ingest: rejected WPPConnect webhook with missing/invalid token')
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
    if (typeof body.session === 'string' && body.session !== this.config.session) {
      this.logger.debug('ingest: ignoring webhook for another session')
      return 200
    }
    if (body.event === 'onmessage' && this._selfId == null && body.fromMe !== true && body.isGroupMsg !== true) {
      const to = jidOf(body.to)
      if (to && !isGroupJid(to) && !isLidJid(to)) this._selfId = to
    }
    // Lookups start now (in parallel with other webhooks), but events are parsed
    // and emitted strictly in arrival order: the dispatcher's per-chat FIFO
    // (e.g. `.ask()` answers) depends on it.
    const lookups = this.config.resolveLid !== false ? this.resolveLids(lidsIn(body)) : Promise.resolve()
    const payload = body
    const emitted = this.emitTail.then(() => lookups).then(() => {
      for (const e of parseWebhook(payload, { identity: this.identity, selfId: this._selfId })) this.fan(e)
    })
    this.emitTail = emitted.catch(() => undefined)
    await emitted
    return 200
  }

  /* Outbound -------------------------------------------------------------- */

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    const out = await toOutbound(chatId, content, options)
    if (options?.platformData) Object.assign(out.body, options.platformData)
    const result = await this.api<unknown>('POST', out.endpoint, out.body, chatId)
    const msg = firstResult(result)
    const id = isRecord(msg) ? serializedId(msg.id) ?? '' : ''
    return { ref: { id, chatId, native: isRecord(msg) ? { id, to: msg.to } : undefined }, raw: result }
  }

  /** POST download-media { messageId } → { base64, mimetype }. */
  async downloadMedia(ref: MediaRef): Promise<Buffer> {
    const token = ref.token as WppMediaToken | undefined
    if (!isRecord(token) || typeof token.messageId !== 'string') throw new ProviderError('downloadMedia requires a WPPConnect media token (MediaRef.token)')
    const res = await this.api<{ base64?: string }>('POST', 'download-media', { messageId: token.messageId })
    const b64 = isRecord(res) && typeof res.base64 === 'string' ? res.base64.replace(/^data:[^,]*,/, '') : undefined
    if (!b64) throw new ProviderError('WPPConnect download-media returned no base64')
    return Buffer.from(b64, 'base64')
  }

  /** send-seen marks whole chats as read (WhatsApp Web has no per-message receipt). */
  async markRead(refs: MessageRef[]): Promise<void> {
    for (const chatId of new Set(refs.map((r) => r.chatId))) {
      await this.api('POST', 'send-seen', target(chatId), chatId)
    }
  }

  async typing(chatId: ChatId, state: 'typing' | 'recording' | 'paused' = 'typing'): Promise<void> {
    if (state === 'recording') await this.api('POST', 'recording', { ...target(chatId), value: true, duration: 5 }, chatId)
    else await this.api('POST', 'typing', { ...target(chatId), value: state === 'typing' }, chatId)
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    await this.api('POST', 'delete-message', { ...target(ref.chatId), messageId: ref.id }, ref.chatId)
  }

  /** edit-message — text only. */
  async editMessage(ref: MessageRef, content: OutboundContent): Promise<SendResult<unknown>> {
    if (content.kind !== 'text') throw new UnsupportedContentError(content.kind, 'WPPConnectProvider.editMessage supports text only')
    const result = await this.api('POST', 'edit-message', { id: ref.id, newText: content.text }, ref.chatId)
    return { ref, raw: result }
  }
}
