/**
 * MessengerProvider — Facebook Messenger (Meta Graph Send API) transport for
 * @bot-wa/core. Webhook-based (pushIngress): there is no socket. The host
 * receives the webhook, verifies it with `verifyChallenge` (GET) and forwards
 * the POST body to `ingest()`. Outbound goes to `POST /{page-id}/messages`.
 *
 * @example
 * ```ts
 * const provider = new MessengerProvider({
 *   accessToken: process.env.MESSENGER_TOKEN!,
 *   verifyToken: 'my-verify-secret',
 *   appSecret: process.env.META_APP_SECRET,   // verifies X-Hub-Signature-256
 * })
 * const bot = new Bot({ provider })
 * // Host wires the webhook:
 * //   app.get('/webhook',  (q) => res.send(provider.verifyChallenge(q)))
 * //   app.post('/webhook', (body, headers) => provider.ingest(body, headers))
 * ```
 */

import pino, { type Logger } from 'pino'
import type {
  ChatId,
  IProvider,
  InboundEvent,
  MediaRef,
  MediaSource,
  MessageRef,
  OutboundContent,
  ProviderCapabilities,
  SendOptions,
  SendResult,
  UserId,
} from '@bot-wa/core'
import { ProviderError, UnsupportedContentError } from '@bot-wa/core'
import { toGraphError, verifyChallenge, checkGraphSignature, parseGraphBody, type GraphError, type ChallengeQuery } from '@bot-wa/graph-core'
import { secureFetch } from '@bot-wa/http'
import type { GraphErrorBody, MessengerProviderConfig, MessengerSendResponse } from './types.js'
import { toOutbound } from './toOutbound.js'
import { parseInbound, type PageWebhookBody } from './parseInbound.js'

/**
 * Translate a Graph error into a typed provider error. Thin wrapper over the
 * shared {@link toGraphError} — now maps the full Graph code set, not just 4/613.
 */
export function toProviderError(err: GraphError, retryAfterMs?: number): ProviderError {
  return toGraphError(err, { retryAfterMs })
}

export class MessengerProvider implements IProvider<unknown> {
  readonly id = 'messenger'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'buttons', 'list', 'card', 'native'],
    // reactions: false — Messenger has no Send API for reactions (inbound only).
    buttons: true, lists: true, polls: false, reactions: false, edit: false,
    typing: true, presence: false, readReceipts: true, groups: false, templates: false,
    interactionsRequireAck: false, pushIngress: true,
  }

  private readonly config: Required<Pick<MessengerProviderConfig, 'apiVersion' | 'graphUrl' | 'pageId'>> & MessengerProviderConfig
  private readonly logger: Logger
  private listeners = new Set<(e: InboundEvent) => void | Promise<void>>()

  constructor(config: MessengerProviderConfig) {
    this.config = { apiVersion: 'v21.0', graphUrl: 'https://graph.facebook.com', pageId: 'me', ...config }
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    if (!this.config.appSecret && !this.config.allowUnsignedWebhooks) {
      throw new Error(
        'MessengerProvider requires `appSecret` to authenticate webhook POSTs. ' +
          'For isolated local development only, set `allowUnsignedWebhooks: true` explicitly.',
      )
    }
    if (!this.config.appSecret) {
      this.logger.warn(
        'MessengerProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.',
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
    this.logger.debug('MessengerProvider ready — wire your webhook to ingest()')
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
   * Feed an inbound webhook POST. When `appSecret` is configured, the body is
   * verified against `X-Hub-Signature-256` first (forged bodies → 403).
   * Normalized events are emitted via onEvent. Pass the RAW body so the
   * signature computes over exactly what Meta signed.
   */
  ingest(body: unknown, headers?: Record<string, string | string[] | undefined>): number {
    const sig = checkGraphSignature(body, headers, this.config.appSecret, this.logger)
    if (!sig.ok) return sig.status
    const parsed = parseGraphBody<PageWebhookBody>(body)
    for (const event of parseInbound(parsed, this.config.selfId)) this.fan(event)
    return 200
  }

  /* Outbound -------------------------------------------------------------- */

  private url(path: string): string {
    return `${this.config.graphUrl.replace(/\/$/, '')}/${this.config.apiVersion}/${this.config.pageId}/${path}`
  }

  /** POST to /{page-id}/messages — the single Send API endpoint for everything. */
  private async postMessages(payload: Record<string, unknown>, chatId: ChatId = ''): Promise<MessengerSendResponse> {
    const res = await fetch(this.url('messages'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = (await res.json().catch(() => ({}))) as MessengerSendResponse & GraphErrorBody
    if (!res.ok || body.error) {
      const retryAfter = Number(res.headers.get('Retry-After')) || undefined
      throw toProviderError(body.error ?? { message: `HTTP ${res.status}` }, retryAfter ? retryAfter * 1000 : undefined)
    }
    return body
  }

  /**
   * Messenger's Send API only references media by public URL — buffer/path/
   * stream sources would need a chunked upload, which this provider doesn't
   * implement. Host the file and pass a URL (string or `{ url }`).
   */
  private resolveMediaUrl(source: MediaSource, kind: OutboundContent['kind']): string {
    if (typeof source === 'string') {
      if (source.startsWith('http')) return source
    } else if ('url' in source) {
      return source.url
    } else if ('native' in source) {
      if (typeof source.native === 'string' && source.native.startsWith('http')) return source.native
      if (source.native && typeof source.native === 'object' && 'url' in source.native) {
        return (source.native as { url: string }).url
      }
    }
    throw new UnsupportedContentError(
      kind,
      `Messenger needs a public URL (or upload the media first) — got a non-URL MediaSource for '${kind}'. Host the file and pass its URL.`,
    )
  }

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    if (options?.quoted) {
      // Messenger has no first-class reply/quote on the Send API — documented no-op.
      this.logger.debug('Messenger Send API has no reply/quote context; ignoring options.quoted')
    }
    const needsMedia = (['image', 'video', 'audio', 'voice', 'document', 'sticker'] as const).includes(content.kind as never)
    const mediaUrl = needsMedia ? this.resolveMediaUrl((content as { media: MediaSource }).media, content.kind) : undefined
    const message = toOutbound(content, mediaUrl)
    const body = await this.postMessages({ recipient: { id: chatId }, messaging_type: 'RESPONSE', message }, chatId)
    return { ref: { id: body.message_id ?? '', chatId }, raw: body }
  }

  /* Capability-gated actions ---------------------------------------------- */

  /** Download inbound media — `ref.token` is the attachment URL itself. */
  async downloadMedia(ref: MediaRef): Promise<Buffer> {
    const url = ref.token
    if (typeof url !== 'string' || !url) throw new ProviderError('downloadMedia requires the attachment URL (MediaRef.token)')
    const { response: res, body } = await secureFetch(url, this.config.mediaDownload)
    if (!res.ok) throw new ProviderError(`Media download failed: HTTP ${res.status}`)
    return body
  }

  /** Mark conversations as seen (sender_action 'mark_seen' per chat). */
  async markRead(refs: MessageRef[]): Promise<void> {
    const seen = new Set<ChatId>()
    for (const r of refs) {
      if (!r.chatId || seen.has(r.chatId)) continue
      seen.add(r.chatId)
      await this.postMessages({ recipient: { id: r.chatId }, sender_action: 'mark_seen' }, r.chatId)
    }
  }

  /** Typing indicator (sender_action 'typing_on' / 'typing_off'). */
  async typing(chatId: ChatId, state?: 'typing' | 'recording' | 'paused'): Promise<void> {
    const action = state === 'paused' ? 'typing_off' : 'typing_on'
    await this.postMessages({ recipient: { id: chatId }, sender_action: action }, chatId)
  }

  /** Messenger postbacks/quick replies need no acknowledgement — no-op. */
  async acknowledgeInteraction(_interactionId: string, _opts?: { text?: string; defer?: boolean }): Promise<void> {}
}
