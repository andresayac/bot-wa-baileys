/**
 * TikTokProvider — TikTok transport for @bot-wa/core over the official
 * TikTok API for Business (v1.3). Webhook-driven (pushIngress): no socket.
 *
 * Two surfaces, one provider:
 *  - **Comments** on the account's own videos/photo posts: `comment.update`
 *    webhooks (subscribe with `event_type: COMMENT`), answered with
 *    `/business/comment/reply/create/`.
 *  - **Direct messages** (Business Messaging API, approval required, not
 *    available for EEA/CH/UK users): `im_receive_msg` webhooks (subscribe with
 *    `event_type: DIRECT_MESSAGE`), answered with `/business/message/send/`.
 *
 * Every webhook POST is authenticated with `TikTok-Signature`
 * (HMAC-SHA256 over `${t}.${rawBody}` with the app secret, replay window);
 * every outbound request goes through `secureFetch` from `@bot-wa/http`.
 *
 * @example
 * ```ts
 * const provider = new TikTokProvider({
 *   accessToken: process.env.TIKTOK_TOKEN!,
 *   businessId: process.env.TIKTOK_BUSINESS_ID!,   // open_id of the account
 *   appSecret: process.env.TIKTOK_APP_SECRET!,     // verifies TikTok-Signature
 *   selfUniqueIdentifier: process.env.TIKTOK_SELF_UID!, // needed for comments (loop guard)
 * })
 * const bot = new Bot({ provider })
 * app.post('/tiktok', express.raw({ type: '*\/*' }), (req, res) => {
 *   res.sendStatus(provider.ingest(req.body, req.headers))
 * })
 * ```
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import pino, { type Logger } from 'pino'
import { SecureHttpError, secureFetch } from '@bot-wa/http'
import {
  ProviderError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type ChatId,
  type IProvider,
  type InboundEvent,
  type MediaRef,
  type MediaSource,
  type MessageRef,
  type OutboundContent,
  type ProviderCapabilities,
  type SendOptions,
  type SendResult,
  type UserId,
} from '@bot-wa/core'
import { highIntentChatId, parseTikTokChatId, type TikTokChatTarget } from './chatId.js'
import { TikTokApiError, toProviderError } from './errors.js'
import { parseJsonLossless } from './json.js'
import { parseWebhook, type ConversationChatInfo } from './parseInbound.js'
import { verifyTikTokSignature } from './signature.js'
import { toCommentReply, toDirectReply, toDmMessage, type TikTokRequestBody } from './toOutbound.js'
import type { TikTokApiResponse, TikTokMediaToken, TikTokProviderConfig, TikTokWebhookBody } from './types.js'

type WebhookHeaders = Record<string, string | string[] | undefined>

/** How many own comment-reply ids to remember for echo suppression. */
const OWN_COMMENT_MEMORY = 1000
/** How many high-intent comments (and their DM hand-offs) to remember. */
const HIGH_INTENT_MEMORY = 1000
/** Inbound DMs stay in the `hic:` chat while it has activity in this window (TikTok's 48 h messaging window). */
const HIGH_INTENT_ROUTING_MS = 48 * 60 * 60 * 1000

/**
 * A high-intent comment answered with a direct reply. TikTok allows ONE
 * direct reply per comment; the customer's answer then arrives as a DM in a
 * conversation whose id the reply does not necessarily return. The binding
 * keeps that DM conversation in the comment's `hic:` chat so a flow started
 * from the comment (`.ask()`, `choose()`) receives the answer, and routes
 * later sends to the conversation instead of a second direct reply.
 */
interface HighIntentBinding {
  commentId: string
  /** The commenter (`senderId` of the high-intent comment), when seen. */
  peerId?: string
  /** `message_id` of the direct reply, to match its `im_send_msg` echo. */
  replyMessageId?: string
  conversationId?: string
  /** Inbound routing into the `hic:` chat stops after this (sliding). */
  routeUntil: number
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

function header(headers: WebhookHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

function isMediaToken(token: unknown): token is TikTokMediaToken {
  if (typeof token !== 'object' || token === null) return false
  const t = token as Record<string, unknown>
  return typeof t.mediaId === 'string' && typeof t.messageId === 'string' && typeof t.conversationId === 'string'
}

export class TikTokProvider implements IProvider<unknown> {
  readonly id = 'tiktok'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'buttons', 'list', 'native'],
    maxTextLength: 6000,
    // Q&A cards: 1–3 reply buttons — choose() menus with more options must stay numbered text.
    buttons: true,
    lists: true,
    polls: false,
    reactions: false,      // inbound reactions only; the API cannot send one
    edit: false,
    typing: true,          // SENDER_ACTION TYPING (DMs)
    presence: false,
    readReceipts: true,    // SENDER_ACTION MARK_READ (DMs)
    groups: false,
    templates: false,
    interactionsRequireAck: false,
    pushIngress: true,
    streaming: 'none',
    forms: 'degraded', // flow().form() asks field by field
  }

  private readonly config: TikTokProviderConfig
  private readonly logger: Logger
  private readonly listeners = new Set<(e: InboundEvent) => void | Promise<void>>()
  private readonly ownComments = new Set<string>()
  /** commentId -> commenter, from `im_receive_high_intent_comment`. */
  private readonly highIntentPeers = new Map<string, string>()
  /** commentId -> DM hand-off after a direct reply. */
  private readonly highIntentReplies = new Map<string, HighIntentBinding>()
  private warnedNoSelfIdentity = false

  constructor(config: TikTokProviderConfig) {
    if (!config.businessId) throw new Error('TikTokProvider requires `businessId` (the open_id of the TikTok account).')
    this.config = config
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    if (!config.appSecret && !config.allowUnsignedWebhooks) {
      throw new Error(
        'TikTokProvider requires `appSecret` to verify the TikTok-Signature of webhook POSTs. ' +
          'For isolated local development only, set `allowUnsignedWebhooks: true` explicitly.',
      )
    }
    if (!config.appSecret) {
      this.logger.warn('TikTokProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.')
    }
    if (!config.selfUniqueIdentifier) {
      this.logger.warn('TikTokProvider has no `selfUniqueIdentifier`: comment webhooks will be ignored (the bot could not tell its own replies apart). DMs are unaffected.')
    }
  }

  get connection(): unknown { return null }
  /** The account's `business_id` — the id TikTok uses for it as a message participant. */
  get selfId(): UserId | null { return this.config.businessId }

  /* Events ---------------------------------------------------------------- */

  onEvent(listener: (event: InboundEvent<unknown>) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private fan(e: InboundEvent): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(e)).catch((err: unknown) => this.logger.error({ err, eventKind: e.kind }, 'provider event listener failed'))
      } catch (err) {
        this.logger.error({ err, eventKind: e.kind }, 'provider event listener failed')
      }
    }
  }

  async start(): Promise<void> {
    this.fan({ kind: 'connection', update: { state: 'ready' } })
    this.logger.debug('TikTokProvider ready — wire your webhook callback URL to ingest()')
  }

  async stop(): Promise<void> {
    this.fan({ kind: 'connection', update: { state: 'closed' } })
  }

  /* Webhook --------------------------------------------------------------- */

  /**
   * Feed a webhook POST. Pass the RAW body (string or Buffer) and the request
   * headers: the signature is computed over the exact bytes TikTok sent.
   * Returns the HTTP status to answer with: 200 accepted (also for events this
   * provider ignores — TikTok retries non-200 for 72 h), 400 unusable body,
   * 403 bad/missing/stale signature. Answer quickly; handlers run async.
   */
  ingest(body: unknown, headers?: WebhookHeaders): number {
    const secret = this.config.appSecret
    if (secret) {
      if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
        this.logger.warn('TikTok ingest received a non-raw body while appSecret is set — pass the raw request bytes (express.raw()).')
        return 400
      }
      const check = verifyTikTokSignature(body, header(headers, 'tiktok-signature'), secret, { toleranceSec: this.config.signatureToleranceSec })
      if (!check.ok) {
        this.logger.warn({ reason: check.reason, logId: header(headers, 'x-tt-logid') }, 'TikTok webhook rejected: invalid TikTok-Signature')
        return 403
      }
    }

    let envelope: TikTokWebhookBody
    try {
      envelope = (typeof body === 'string' || Buffer.isBuffer(body)
        ? parseJsonLossless(typeof body === 'string' ? body : body.toString('utf8'))
        : body) as TikTokWebhookBody
    } catch {
      return 400
    }
    if (typeof envelope !== 'object' || envelope === null) return 400

    if (envelope.user_openid && envelope.user_openid !== this.config.businessId) {
      this.logger.debug({ event: envelope.event }, 'TikTok webhook for another account authorized on this app — ignored')
      return 200
    }

    const self = this.config.selfUniqueIdentifier
    const conversationChatId = (info: ConversationChatInfo) => this.highIntentChatFor(info)
    for (const event of parseWebhook(envelope, { selfUniqueIdentifier: self, conversationChatId })) {
      if (event.kind === 'message' && event.message.chat.platformData?.surface === 'high-intent-comment') {
        remember(this.highIntentPeers, event.message.ref.id, event.message.senderId, HIGH_INTENT_MEMORY)
      }
      if (event.kind === 'message' && event.message.chat.platformData?.surface === 'comment') {
        // Primary loop guard is the sender (fromMe via selfUniqueIdentifier): it
        // holds across restarts and instances. Without it, fail closed.
        if (!self) {
          if (!this.warnedNoSelfIdentity) {
            this.warnedNoSelfIdentity = true
            this.logger.warn('TikTok comment webhook ignored: set `selfUniqueIdentifier` to receive comments.')
          }
          continue
        }
        if (this.ownComments.has(event.message.ref.id)) continue // echo of a reply this process just posted
      }
      this.fan(event as InboundEvent)
    }
    return 200
  }

  /**
   * The `hic:` chat a DM belongs to, when it is the hand-off of a high-intent
   * comment answered by this process: matched by conversation once known, or
   * else by the direct reply's echo id or by the commenter's first DM.
   */
  private highIntentChatFor(info: ConversationChatInfo): string | undefined {
    const now = Date.now()
    let match: HighIntentBinding | undefined
    for (const binding of this.highIntentReplies.values()) {
      if (binding.routeUntil < now) continue
      if (binding.conversationId) {
        if (binding.conversationId === info.conversationId) match = binding
      } else if (
        (info.direction === 'out' && !!binding.replyMessageId && binding.replyMessageId === info.messageId) ||
        (info.direction === 'in' && !!binding.peerId && binding.peerId === info.peerId)
      ) {
        match = binding // latest wins
      }
    }
    if (!match) return undefined
    match.conversationId = info.conversationId
    match.routeUntil = now + HIGH_INTENT_ROUTING_MS
    return highIntentChatId(match.commentId)
  }

  /** Resolve a chat id to its TikTok target, following a `hic:` chat to its DM conversation once bound. */
  private route(chatId: ChatId): TikTokChatTarget | undefined {
    const target = parseTikTokChatId(chatId)
    if (target?.surface !== 'high-intent-comment') return target
    const conversationId = this.highIntentReplies.get(target.commentId)?.conversationId
    return conversationId ? { surface: 'dm', conversationId } : target
  }

  /* HTTP ------------------------------------------------------------------ */

  private apiUrl(path: string): string {
    const base = (this.config.apiBaseUrl ?? 'https://business-api.tiktok.com/open_api').replace(/\/$/, '')
    return `${base}/${this.config.apiVersion ?? 'v1.3'}/${path}`
  }

  private async token(): Promise<string> {
    const t = this.config.accessToken
    return typeof t === 'function' ? await t() : t
  }

  /** Call a TikTok API endpoint; resolves `data` on `code === 0`, else throws a typed error. */
  private async api<T>(path: string, body: TikTokRequestBody | FormData, chatId: ChatId = ''): Promise<T> {
    const isForm = body instanceof FormData
    const headers: Record<string, string> = { 'Access-Token': await this.token() }
    if (!isForm) headers['Content-Type'] = 'application/json'
    let result: Awaited<ReturnType<typeof secureFetch>>
    try {
      result = await secureFetch(this.apiUrl(path), {
        ...this.config.http,
        // Never follow redirects: `Access-Token` is a custom header that a
        // cross-origin hop would carry along with the request body.
        maxRedirects: 0,
        method: 'POST',
        headers,
        body: isForm ? body : JSON.stringify(body),
      })
    } catch (err) {
      if (err instanceof SecureHttpError && err.code === 'TOO_MANY_REDIRECTS') {
        throw new TikTokApiError('TikTok API answered with a redirect; not followed (it would forward the access token)')
      }
      throw err
    }
    const { response, body: bytes } = result
    let parsed: TikTokApiResponse<T> | undefined
    try {
      parsed = parseJsonLossless(bytes.toString('utf8')) as TikTokApiResponse<T>
    } catch {
      parsed = undefined
    }
    if (!response.ok || !parsed || (parsed.code !== undefined && parsed.code !== 0)) {
      const retryAfter = Number(response.headers.get('retry-after'))
      throw toProviderError({
        chatId,
        httpStatus: response.status,
        code: parsed?.code,
        message: parsed?.message,
        requestId: parsed?.request_id,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      })
    }
    return (parsed.data ?? {}) as T
  }

  /** GET an external URL safely (media). Never sends the access token. */
  private async download(url: string): Promise<{ bytes: Buffer; mimetype?: string }> {
    const { response, body } = await secureFetch(url, { ...this.config.http })
    if (!response.ok) throw new ProviderError(`TikTok media download failed: HTTP ${response.status}`)
    return { bytes: body, mimetype: response.headers.get('content-type') ?? undefined }
  }

  /* Outbound -------------------------------------------------------------- */

  private target(chatId: ChatId): TikTokChatTarget {
    const target = this.route(chatId)
    if (!target) throw new RecipientUnreachableError(chatId, `Not a TikTok chat id: '${chatId}'`)
    return target
  }

  /** Resolve an image source to a Business Messaging `media_id` (uploading when needed). */
  private async mediaId(source: MediaSource): Promise<string> {
    if (typeof source === 'object' && source !== null && 'native' in source) {
      const native = source.native
      if (typeof native === 'string' && native) return native
      if (typeof native === 'object' && native !== null && typeof (native as { mediaId?: unknown }).mediaId === 'string') {
        return (native as { mediaId: string }).mediaId
      }
      throw new UnsupportedContentError('image', 'TikTok native image source must be a media_id string or { mediaId }')
    }
    let bytes: Buffer
    let filename = 'image'
    let mimetype: string | undefined
    if (Buffer.isBuffer(source)) bytes = source
    else if (typeof source === 'string') {
      if (!/^https?:\/\//i.test(source)) throw new UnsupportedContentError('image', 'TikTok image strings must be URLs; pass { path } for local files')
      ;({ bytes, mimetype } = await this.download(source))
      filename = basename(new URL(source).pathname) || filename
    } else if ('url' in source) {
      ;({ bytes, mimetype } = await this.download(source.url))
      filename = basename(new URL(source.url).pathname) || filename
    } else if ('buffer' in source) bytes = source.buffer
    else if ('path' in source) {
      bytes = await readFile(source.path)
      filename = basename(source.path)
    } else {
      throw new UnsupportedContentError('image', 'TikTok does not accept stream image sources; pass a Buffer, path or URL')
    }
    const form = new FormData()
    form.append('business_id', this.config.businessId)
    form.append('media_type', 'IMAGE')
    form.append('file', new Blob([new Uint8Array(bytes)], mimetype ? { type: mimetype } : {}), filename)
    const data = await this.api<{ media_id?: string }>('business/message/media/upload/', form)
    if (!data.media_id) throw new ProviderError('TikTok media upload returned no media_id')
    return data.media_id
  }

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    const target = this.target(chatId)

    if (target.surface === 'comment') {
      const body = toCommentReply(content, { businessId: this.config.businessId, ...target })
      const data = await this.api<{ comment_id?: string | number; comment?: { comment_id?: string | number } }>('business/comment/reply/create/', body, chatId)
      const id = String(data.comment_id ?? data.comment?.comment_id ?? '')
      if (id) this.rememberOwnComment(id)
      return { ref: { id, chatId }, raw: data }
    }

    if (target.surface === 'high-intent-comment') {
      if (this.highIntentReplies.has(target.commentId)) {
        // TikTok accepts a single direct reply per comment; the rest of the
        // exchange happens in the DM conversation, unknown until the echo or
        // the customer's answer arrives.
        throw new RecipientUnreachableError(chatId, 'TikTok allows one direct reply per comment; the DM conversation is not known yet (it binds when the customer answers)')
      }
      const body = toDirectReply(content, { businessId: this.config.businessId, commentId: target.commentId })
      const data = await this.api<{ message?: { message_id?: string; conversation_id?: string }; conversation_id?: string }>('business/message/send/', body, chatId)
      const messageId = data.message?.message_id ?? ''
      const conversationId = data.message?.conversation_id ?? data.conversation_id
      const peerId = this.highIntentPeers.get(target.commentId)
      remember(this.highIntentReplies, target.commentId, {
        commentId: target.commentId,
        ...(peerId ? { peerId } : {}),
        ...(messageId ? { replyMessageId: messageId } : {}),
        ...(conversationId ? { conversationId } : {}),
        routeUntil: Date.now() + HIGH_INTENT_ROUTING_MS,
      }, HIGH_INTENT_MEMORY)
      return { ref: { id: messageId, chatId }, raw: data }
    }

    // Validate (and fail fast) before any upload.
    const mediaId = content.kind === 'image' ? await this.mediaId(content.media) : undefined
    if (content.kind === 'image' && content.caption) {
      this.logger.debug('TikTok image messages carry no caption; caption dropped')
    }
    const body = toDmMessage(content, {
      businessId: this.config.businessId,
      conversationId: target.conversationId,
      quotedId: content.kind === 'text' ? options?.quoted?.id : undefined,
      mediaId,
    })
    const data = await this.api<{ message?: { message_id?: string } }>('business/message/send/', body, chatId)
    return { ref: { id: data.message?.message_id ?? '', chatId }, raw: data }
  }

  private rememberOwnComment(id: string): void {
    this.ownComments.add(id)
    if (this.ownComments.size > OWN_COMMENT_MEMORY) {
      const oldest = this.ownComments.values().next().value
      if (oldest !== undefined) this.ownComments.delete(oldest)
    }
  }

  /* Capability-gated actions ---------------------------------------------- */

  private async senderAction(conversationId: string, action: 'TYPING' | 'MARK_READ', chatId: ChatId): Promise<void> {
    await this.api('business/message/send/', {
      business_id: this.config.businessId,
      recipient_type: 'CONVERSATION',
      recipient: conversationId,
      message_type: 'SENDER_ACTION',
      sender_action: action,
    }, chatId)
  }

  /** "Typing" indicator (auto-hides after 5 s). DMs only; no-op elsewhere and for `paused`. */
  async typing(chatId: ChatId, state?: 'typing' | 'recording' | 'paused'): Promise<void> {
    if (state === 'paused') return
    const target = this.target(chatId)
    if (target.surface !== 'dm') return
    await this.senderAction(target.conversationId, 'TYPING', chatId)
  }

  /** Mark DM conversations as read ("Seen"). One request per conversation; comments are skipped. */
  async markRead(refs: MessageRef[]): Promise<void> {
    const done = new Set<string>()
    for (const ref of refs) {
      const target = this.route(ref.chatId)
      if (target?.surface !== 'dm' || done.has(target.conversationId)) continue
      done.add(target.conversationId)
      await this.senderAction(target.conversationId, 'MARK_READ', ref.chatId)
    }
  }

  /**
   * Download inbound media. DM image/video: `/business/message/media/download/`
   * returns a short-lived `download_url`, fetched via `secureFetch`. Stickers
   * carry their URL directly.
   */
  async downloadMedia(ref: MediaRef): Promise<Buffer | NodeJS.ReadableStream> {
    const token = ref.token
    if (isMediaToken(token)) {
      const data = await this.api<{ download_url?: string }>('business/message/media/download/', {
        business_id: this.config.businessId,
        conversation_id: token.conversationId,
        message_id: token.messageId,
        media_id: token.mediaId,
        media_type: token.mediaType,
      })
      if (!data.download_url) throw new ProviderError('TikTok media download returned no download_url')
      return (await this.download(data.download_url)).bytes
    }
    if (typeof token === 'object' && token !== null && typeof (token as { url?: unknown }).url === 'string') {
      return (await this.download((token as { url: string }).url)).bytes
    }
    throw new ProviderError('downloadMedia: not a TikTok media reference')
  }
}
