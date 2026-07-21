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
import { ProviderError, RateLimitedError, UnsupportedContentError } from '@bot-wa/core'
import type { GraphErrorBody, MessengerProviderConfig, MessengerSendResponse } from './types.js'
import { toOutbound } from './toOutbound.js'
import { parseInbound, type PageWebhookBody } from './parseInbound.js'
import { verifyChallenge, verifySignature, type ChallengeQuery } from './webhook.js'

interface GraphError { code?: number; message?: string; error_subcode?: number; type?: string }

/** Translate a Graph error into a typed provider error. */
export function toProviderError(err: GraphError, retryAfterMs?: number): ProviderError {
  const code = err.code
  const msg = err.message ?? 'Graph API error'
  switch (code) {
    case 4:   // application request limit
    case 613: // page-level rate limit
      return new RateLimitedError(retryAfterMs ?? 60_000, `${msg} (${code})`)
    default:
      return new ProviderError(`${msg}${code != null ? ` (code ${code})` : ''}`)
  }
}

export class MessengerProvider implements IProvider<unknown> {
  readonly id = 'messenger'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'buttons', 'list', 'card', 'native'],
    buttons: true, lists: true, polls: false, reactions: true, edit: false,
    typing: true, presence: false, readReceipts: true, groups: false, templates: false,
    interactionsRequireAck: false, pushIngress: true,
  }

  private readonly config: Required<Pick<MessengerProviderConfig, 'apiVersion' | 'graphUrl' | 'pageId'>> & MessengerProviderConfig
  private readonly logger: Logger
  private listeners = new Set<(e: InboundEvent) => void | Promise<void>>()

  constructor(config: MessengerProviderConfig) {
    this.config = { apiVersion: 'v21.0', graphUrl: 'https://graph.facebook.com', pageId: 'me', ...config }
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
  }

  get connection(): unknown { return null }
  get selfId(): UserId | null { return this.config.selfId ?? null }

  /* Events ---------------------------------------------------------------- */

  onEvent(listener: (e: InboundEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private fan(e: InboundEvent): void {
    for (const l of this.listeners) void l(e)
  }

  /** No socket to open — the transport is webhook-driven. */
  async start(): Promise<void> {
    this.logger.debug('MessengerProvider ready — wire your webhook to ingest()')
  }
  async stop(): Promise<void> {}

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
    const raw = typeof body === 'string' ? body : JSON.stringify(body)
    if (this.config.appSecret) {
      const sig = headers?.['x-hub-signature-256']
      const sigStr = Array.isArray(sig) ? sig[0] : sig
      if (!verifySignature(raw, sigStr, this.config.appSecret)) {
        this.logger.warn('webhook rejected: invalid X-Hub-Signature-256')
        return 403
      }
    }
    const parsed: PageWebhookBody = typeof body === 'string' ? JSON.parse(body) : (body as PageWebhookBody)
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
    const res = await fetch(url)
    if (!res.ok) throw new ProviderError(`Media download failed: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
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
  async acknowledgeInteraction(): Promise<void> {}
}
