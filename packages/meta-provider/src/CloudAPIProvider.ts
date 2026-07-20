/**
 * CloudAPIProvider — WhatsApp Cloud API (official Meta) transport for
 * @bot-wa/core. Webhook-based (pushIngress): there is no socket. The host
 * receives the webhook, verifies it with `verifyChallenge` (GET) and forwards
 * the POST body to `ingest()`. Outbound goes to the Graph `/messages` endpoint.
 *
 * @example
 * ```ts
 * const provider = new CloudAPIProvider({
 *   accessToken: process.env.META_TOKEN!,
 *   phoneNumberId: process.env.META_PHONE_ID!,
 *   verifyToken: 'my-verify-secret',
 *   appSecret: process.env.META_APP_SECRET,   // verifies X-Hub-Signature-256
 * })
 * const bot = new Bot({ provider })
 * // Host wires the webhook:
 * //   app.get('/webhook',  (q) => res.send(provider.verifyChallenge(q)))
 * //   app.post('/webhook', (body, headers) => provider.ingest(body, headers))
 * ```
 */

import { readFile } from 'node:fs/promises'
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
import type { CloudAPIProviderConfig } from './types.js'
import { GraphClient } from './graphClient.js'
import { toOutbound, type ResolvedMedia } from './toOutbound.js'
import { parseInbound, type GraphWebhookBody } from './parseInbound.js'
import { verifyChallenge, verifySignature, type ChallengeQuery } from './webhook.js'

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', aac: 'audio/aac',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export class CloudAPIProvider implements IProvider<unknown> {
  readonly id = 'meta'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'reaction', 'buttons', 'list', 'template', 'card', 'native'],
    buttons: true, lists: true, polls: false, reactions: true, edit: false,
    typing: false, presence: false, readReceipts: true, groups: false, templates: true,
    interactionsRequireAck: false, pushIngress: true,
  }

  private readonly config: Required<Pick<CloudAPIProviderConfig, 'apiVersion' | 'graphUrl'>> & CloudAPIProviderConfig
  private readonly logger: Logger
  private readonly graph: GraphClient
  private listeners = new Set<(e: InboundEvent) => void | Promise<void>>()

  constructor(config: CloudAPIProviderConfig) {
    this.config = { apiVersion: 'v21.0', graphUrl: 'https://graph.facebook.com', ...config }
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    this.graph = new GraphClient({
      accessToken: this.config.accessToken,
      phoneNumberId: this.config.phoneNumberId,
      apiVersion: this.config.apiVersion,
      graphUrl: this.config.graphUrl,
    })
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
    this.logger.debug('CloudAPIProvider ready — wire your webhook to ingest()')
  }
  async stop(): Promise<void> {}

  /* Webhook --------------------------------------------------------------- */

  /** Validate the webhook GET handshake; returns the challenge to echo (or null → 403). */
  verifyChallenge(query: ChallengeQuery): string | null {
    return verifyChallenge(query, this.config.verifyToken)
  }

  /**
   * Feed an inbound webhook POST. When `appSecret` is configured and `headers`
   * are passed, the body is verified against `X-Hub-Signature-256` first
   * (forged bodies are dropped). Normalized events are emitted via onEvent.
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
    const parsed: GraphWebhookBody = typeof body === 'string' ? JSON.parse(body) : (body as GraphWebhookBody)
    for (const event of parseInbound(parsed)) this.fan(event)
    return 200
  }

  /* Outbound -------------------------------------------------------------- */

  private async resolveMedia(source: MediaSource, fallbackMime = 'application/octet-stream'): Promise<ResolvedMedia> {
    if (typeof source === 'string') return source.startsWith('http') ? { link: source } : { id: await this.graph.uploadMedia(await readFile(source), fallbackMime) }
    if (Buffer.isBuffer(source)) return { id: await this.graph.uploadMedia(source, fallbackMime) }
    if ('url' in source) return { link: source.url }
    if ('buffer' in source) return { id: await this.graph.uploadMedia(source.buffer, fallbackMime) }
    if ('path' in source) {
      const ext = source.path.split('.').pop()?.toLowerCase() ?? ''
      return { id: await this.graph.uploadMedia(await readFile(source.path), EXT_MIME[ext] ?? fallbackMime) }
    }
    if ('stream' in source) {
      const chunks: Buffer[] = []
      for await (const c of source.stream as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      return { id: await this.graph.uploadMedia(Buffer.concat(chunks), fallbackMime) }
    }
    if ('native' in source) return typeof source.native === 'string' ? { id: source.native } : (source.native as ResolvedMedia)
    throw new UnsupportedContentError('image', 'Unsupported MediaSource for Cloud API')
  }

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    const needsMedia = ['image', 'video', 'audio', 'voice', 'document', 'sticker'].includes(content.kind)
    const media = needsMedia ? await this.resolveMedia((content as { media: MediaSource }).media) : undefined
    const message = toOutbound(content, media)
    if (options?.quoted) {
      // Cloud API replies reference the quoted message via context.
      ;(message as Record<string, unknown>).context = { message_id: options.quoted.id }
    }
    const res = await this.graph.sendMessage(chatId, message)
    return { ref: { id: res.id ?? '', chatId }, raw: res }
  }

  /* Capabilities ---------------------------------------------------------- */

  async downloadMedia(ref: MediaRef): Promise<Buffer | NodeJS.ReadableStream> {
    const id = ref.token as string | undefined
    if (!id) throw new ProviderError('downloadMedia requires a media id (MediaRef.token)')
    const { buffer } = await this.graph.downloadMedia(id)
    return buffer
  }

  async markRead(refs: MessageRef[]): Promise<void> {
    for (const r of refs) if (r.id) await this.graph.markRead(r.id)
  }

  /** Cloud API has no typing/presence primitive. */
  async typing(): Promise<void> {}
  /** Cloud API cannot delete a sent message for everyone. */
  async deleteMessage(): Promise<void> {}
}
