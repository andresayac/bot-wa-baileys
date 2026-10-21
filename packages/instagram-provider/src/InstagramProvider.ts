/**
 * InstagramProvider — Instagram DM (Messenger API for Instagram) transport for
 * @botmesh/core. Webhook-based (pushIngress): there is no socket. The host
 * receives the 'page' webhook, verifies it with `verifyChallenge` (GET) and
 * forwards the POST body to `ingest()`. Outbound goes to the Graph
 * `me/messages` Send API endpoint.
 *
 * The IG account must be a professional account connected to a Facebook Page;
 * events arrive on that Page's webhook and sends use the Page access token.
 *
 * @example
 * ```ts
 * const provider = new InstagramProvider({
 *   accessToken: process.env.META_PAGE_TOKEN!,
 *   verifyToken: 'my-verify-secret',
 *   appSecret: process.env.META_APP_SECRET,   // verifies X-Hub-Signature-256
 * })
 * const bot = new Bot({ provider })
 * // Host wires the webhook:
 * //   app.get('/webhook',  (q) => res.send(provider.verifyChallenge(q)))
 * //   app.post('/webhook', (body, headers) => provider.ingest(body, headers))
 * ```
 */

import pino from 'pino'
import type { LoggerLike } from '@botmesh/core'
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
  SerializedMediaRef,
  UserId,
} from '@botmesh/core'
import { ProviderError } from '@botmesh/core'
import type { InstagramProviderConfig } from './types.js'
import { GraphClient } from './graphClient.js'
import { toOutbound } from './toOutbound.js'
import { parseInbound, type IgWebhookBody } from './parseInbound.js'
import {
  verifyChallenge, checkGraphSignature, tryParseGraphBody, META_MEDIA_HOSTS, serializeUrlMediaRef, rehydrateUrlMediaRef,
  type ChallengeQuery,
} from '@botmesh/graph-core'
import { isAllowedHostUrl } from '@botmesh/http'

export class InstagramProvider implements IProvider<unknown> {
  readonly id = 'instagram'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'buttons', 'list', 'card', 'native'],
    buttons: true,                 // as quick replies
    lists: false,                  // degraded to numbered text
    polls: false,
    reactions: false,              // SEND capability: IG has no reaction Send API (inbound DM reactions still arrive)
    edit: false,
    typing: true,                  // sender_action typing_on/typing_off
    presence: false,
    readReceipts: true,            // sender_action mark_seen
    groups: false,                 // IG DMs only
    templates: false,
    interactionsRequireAck: false,
    pushIngress: true,
    streaming: 'none', // no live preview: ctx.stream() sends sentence chunks with typing
    forms: 'degraded', // flow().form() asks field by field
    textFormat: 'plain', // no text markup: Markdown would show literally
  }

  private readonly config: Required<Pick<InstagramProviderConfig, 'apiVersion' | 'graphUrl'>> & InstagramProviderConfig
  private readonly logger: LoggerLike
  private readonly graph: GraphClient
  private listeners = new Set<(e: InboundEvent) => void | Promise<void>>()

  constructor(config: InstagramProviderConfig) {
    this.config = { apiVersion: 'v21.0', graphUrl: 'https://graph.facebook.com', ...config }
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    if (config.mediaRefHosts !== undefined &&
      (!Array.isArray(config.mediaRefHosts) || config.mediaRefHosts.some((h) => typeof h !== 'string' || h.trim() === ''))) {
      throw new TypeError('InstagramProvider: mediaRefHosts must be an array of host names')
    }
    this.graph = new GraphClient({
      accessToken: this.config.accessToken,
      apiVersion: this.config.apiVersion,
      graphUrl: this.config.graphUrl,
      mediaDownload: this.config.mediaDownload,
    })
    if (!this.config.appSecret && !this.config.allowUnsignedWebhooks) {
      throw new Error(
        'InstagramProvider requires `appSecret` to authenticate webhook POSTs. ' +
          'For isolated local development only, set `allowUnsignedWebhooks: true` explicitly.',
      )
    }
    if (!this.config.appSecret) {
      this.logger.warn(
        'InstagramProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.',
      )
    }
  }

  get connection(): unknown { return null }
  get selfId(): UserId | null { return this.config.selfId ?? null }

  /* Events ---------------------------------------------------------------- */

  onEvent(listener: (e: InboundEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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

  /** No socket to open — the transport is webhook-driven. */
  async start(): Promise<void> {
    this.fan({ kind: 'connection', update: { state: 'ready' } })
    this.logger.debug('InstagramProvider ready — wire your webhook to ingest()')
  }
  async stop(): Promise<void> {
    this.fan({ kind: 'connection', update: { state: 'closed' } })
  }

  /* Webhook --------------------------------------------------------------- */

  /** Validate the webhook GET handshake; returns the challenge to echo (or null → 403). */
  verifyChallenge(query: ChallengeQuery): string | null {
    return verifyChallenge(query, this.config.verifyToken)
  }

  /**
   * Feed an inbound webhook POST. When `appSecret` is configured and `headers`
   * are passed, the body is verified against `X-Hub-Signature-256` first
   * (forged bodies are dropped → 403). Normalized events are emitted via
   * onEvent. Returns the HTTP status the host should send; a body that is not
   * a JSON object answers 400 instead of throwing.
   */
  ingest(body: unknown, headers?: Record<string, string | string[] | undefined>): number {
    const sig = checkGraphSignature(body, headers, this.config.appSecret, this.logger)
    if (!sig.ok) return sig.status
    const parsed = tryParseGraphBody<IgWebhookBody>(body)
    if (!parsed.ok) {
      this.logger.warn('webhook rejected: body is not a JSON object')
      return parsed.status
    }
    for (const event of parseInbound(parsed.body)) this.fan(event)
    return 200
  }

  /* Outbound -------------------------------------------------------------- */

  /**
   * Send normalized content via the IG Send API. `options.quoted` is ignored —
   * the Messenger API for Instagram has no client-visible reply-threading on send.
   */
  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    void options // quoted/mentions/interactionId have no Send API equivalent
    const message = toOutbound(content)
    const res = await this.graph.sendMessage(chatId, message, content.kind)
    return { ref: { id: res.message_id ?? '', chatId }, raw: res }
  }

  /* Capability-gated actions ---------------------------------------------- */

  /** Download media bytes from the attachment URL stored in MediaRef.token. */
  async downloadMedia(ref: MediaRef): Promise<Buffer | NodeJS.ReadableStream> {
    const url = ref.token
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new ProviderError('downloadMedia requires a media URL (MediaRef.token)')
    }
    return this.graph.downloadUrl(url)
  }

  /**
   * Durable inbox: the attachment URL (`{ url }`), only on a Meta CDN host (or `mediaRefHosts`).
   * No credentials are stored. Meta attachment URLs are signed and expire: a replay long after
   * the message arrived fails with the usual download error.
   */
  serializeMediaRef(ref: MediaRef): SerializedMediaRef | undefined {
    return serializeUrlMediaRef(ref, this.mediaUrlAllowed)
  }

  /** Rebuild a journaled attachment URL. @throws {ProviderError} on an invalid, foreign or unknown-version value. */
  rehydrateMediaRef(stored: SerializedMediaRef, ref: Omit<MediaRef, 'token'>): MediaRef {
    return rehydrateUrlMediaRef(stored, ref, this.mediaUrlAllowed, 'Instagram')
  }

  private readonly mediaUrlAllowed = (url: string): boolean => isAllowedHostUrl(url, {
    hosts: this.config.mediaRefHosts ?? META_MEDIA_HOSTS,
    allowHttp: this.config.mediaDownload?.allowHttp === true,
  })

  /** Mark conversations as seen (sender_action 'mark_seen', one per chat). */
  async markRead(refs: MessageRef[]): Promise<void> {
    const chats = new Set(refs.map((r) => r.chatId).filter(Boolean))
    for (const chatId of chats) await this.graph.sendSenderAction(chatId, 'mark_seen')
  }

  /** Typing indicator (sender_action 'typing_on'/'typing_off'). */
  async typing(chatId: ChatId, state?: 'typing' | 'recording' | 'paused'): Promise<void> {
    await this.graph.sendSenderAction(chatId, state === 'paused' ? 'typing_off' : 'typing_on')
  }

  /** IG quick replies carry no ack deadline — nothing to do. */
  async acknowledgeInteraction(_interactionId: string, _opts?: { text?: string; defer?: boolean }): Promise<void> {}
}
