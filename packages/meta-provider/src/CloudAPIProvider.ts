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
import { extractDrafts, resolveDrafts, type GraphWebhookBody, type InboundDraft } from './parseInbound.js'
import { IdentityResolver, MemoryIdentityMap, isPromiseLike, type MaybePromise } from './identity.js'
import { SessionWindowManager } from './sessionWindow.js'
import { UsageTracker, pricingOf } from './pricing.js'
import { verifyChallenge, checkGraphSignature, parseGraphBody, type ChallengeQuery } from '@bot-wa/graph-core'

/** Content kinds that carry a `media` source. */
const MEDIA_KINDS: ReadonlySet<OutboundContent['kind']> = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker'])

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
    streaming: 'none', // no live preview: ctx.stream() sends sentence chunks with typing
  }

  private readonly config: Required<Pick<CloudAPIProviderConfig, 'apiVersion' | 'graphUrl'>> & CloudAPIProviderConfig
  private readonly logger: Logger
  private readonly graph: GraphClient
  private listeners = new Set<(e: InboundEvent) => void | Promise<void>>()
  private readonly identity: IdentityResolver
  /** 24 h window manager (undefined unless `sessionWindow` is configured). */
  readonly sessionWindow: SessionWindowManager | undefined
  /** Pricing/usage counters fed by status webhooks (undefined when `usage: false`). */
  readonly usage: UsageTracker | undefined
  private readonly rawSend = (chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> =>
    this.sendNow(chatId, content, options)
  /** Tail of webhook batches waiting on an async identity lookup (keeps webhook order). */
  private pending: Promise<void> | undefined

  constructor(config: CloudAPIProviderConfig) {
    this.config = { apiVersion: 'v21.0', graphUrl: 'https://graph.facebook.com', ...config }
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    this.graph = new GraphClient({
      accessToken: this.config.accessToken,
      phoneNumberId: this.config.phoneNumberId,
      apiVersion: this.config.apiVersion,
      graphUrl: this.config.graphUrl,
      mediaDownload: this.config.mediaDownload,
    })
    this.identity = new IdentityResolver(config.identityMap ?? new MemoryIdentityMap(), this.logger)
    // The 24 h window belongs to a business number + user pair: scope it by phone number id.
    const sw = config.sessionWindow
    const scope = this.config.phoneNumberId
    this.sessionWindow = sw === undefined ? undefined
      : sw instanceof SessionWindowManager ? sw.forScope(scope)
      : new SessionWindowManager({ ...sw, scope })
    const usage = config.usage
    this.usage = usage === false ? undefined : usage instanceof UsageTracker ? usage : new UsageTracker(usage ?? {})
    if (!this.config.appSecret && !this.config.allowUnsignedWebhooks) {
      throw new Error(
        'CloudAPIProvider requires `appSecret` to authenticate webhook POSTs. ' +
          'For isolated local development only, set `allowUnsignedWebhooks: true` explicitly.',
      )
    }
    if (!this.config.appSecret) {
      this.logger.warn(
        'CloudAPIProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.',
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
    this.observe(e)
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(e))
          .catch((error) => this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed'))
      } catch (error) {
        this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed')
      }
    }
  }

  /** Feed window/usage bookkeeping from an inbound event before listeners see it. */
  private observe(e: InboundEvent): void {
    try {
      const sw = this.sessionWindow
      if (e.kind === 'status') {
        const st = e.status
        const pricing = this.usage ? pricingOf(st.platformData) : undefined
        if (pricing && st.ref.id) this.usage?.record(st.ref.chatId, st.ref.id, pricing)
        if (sw && st.status === 'failed' && st.ref.id) {
          void sw.noteFailedStatus(st.ref.chatId, st.ref.id, st.error?.code, this.rawSend, st.timestamp > 0 ? st.timestamp * 1000 : undefined)
            .catch((err: unknown) => this.logger.error({ err }, 'session window status handling failed'))
        }
        return
      }
      if (!sw) return
      const inbound = e.kind === 'message' ? { chatId: e.message.chatId, ts: e.message.timestamp }
        : e.kind === 'interaction' ? { chatId: e.interaction.chatId, ts: e.interaction.timestamp }
        : undefined // reactions/statuses do not open the customer-service window
      if (!inbound) return
      void sw.noteInbound(inbound.chatId, this.rawSend, inbound.ts > 0 ? inbound.ts * 1000 : undefined)
        .catch((err: unknown) => this.logger.error({ err }, 'session window inbound handling failed'))
    } catch (err) {
      this.logger.error({ err }, 'session window/usage bookkeeping failed')
    }
  }

  /** No socket to open — the transport is webhook-driven. */
  async start(): Promise<void> {
    this.fan({ kind: 'connection', update: { state: 'ready' } })
    this.logger.debug('CloudAPIProvider ready — wire your webhook to ingest()')
  }
  /** Emits `closed` after any webhook batch still waiting on an async identity lookup. */
  async stop(): Promise<void> {
    while (this.pending) await this.pending
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
   * (forged bodies are dropped). Normalized events are emitted via onEvent.
   *
   * IMPORTANT: Meta signs the EXACT raw bytes it sent. Pass `body` as the raw
   * request string/Buffer (e.g. `express.raw()`), NOT a re-parsed object — a
   * JSON object re-serialized here won't reproduce the original bytes and the
   * signature check will fail on legitimate requests. When `appSecret` is set
   * and a non-string body is received, a warning is logged.
   *
   * Identity: users are keyed by phone number (wa_id) when known, otherwise by
   * their business-scoped user id (BSUID — username users). Phone ↔ BSUID pairs
   * are learned across webhooks (see `identityMap`). Events are emitted
   * synchronously, unless an async `identityMap` lookup is needed; then they are
   * emitted once it settles, preserving webhook order.
   */
  ingest(body: unknown, headers?: Record<string, string | string[] | undefined>): number {
    const sig = checkGraphSignature(body, headers, this.config.appSecret, this.logger)
    if (!sig.ok) return sig.status
    const parsed = parseGraphBody<GraphWebhookBody>(body)
    this.dispatch(extractDrafts(parsed, this.logger))
    return 200
  }

  private dispatch(drafts: InboundDraft[]): void {
    if (drafts.length === 0) return
    if (this.pending) {
      this.enqueue(() => resolveDrafts(drafts, this.identity, this.logger))
      return
    }
    let result: MaybePromise<InboundEvent[]>
    try {
      result = resolveDrafts(drafts, this.identity, this.logger)
    } catch (err) {
      this.logger.error({ err }, 'CloudAPIProvider failed to resolve webhook identities')
      return
    }
    if (isPromiseLike(result)) {
      this.enqueue(result)
      return
    }
    for (const event of result) this.fan(event)
  }

  /**
   * Chain a batch behind any in-flight one so events keep webhook order. A
   * promise is only passed when nothing is in flight; handlers attach at once.
   */
  private enqueue(next: Promise<InboundEvent[]> | (() => MaybePromise<InboundEvent[]>)): void {
    const resolved = typeof next === 'function' ? (this.pending ?? Promise.resolve()).then(next) : next
    const run: Promise<void> = resolved
      .then((events) => { for (const event of events) this.fan(event) })
      .catch((err: unknown) => this.logger.error({ err }, 'CloudAPIProvider failed to resolve webhook identities'))
    this.pending = run
    void run.then(() => { if (this.pending === run) this.pending = undefined })
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

  /**
   * Send `content`. With `sessionWindow` configured, a free-form send to a chat
   * whose 24 h window is closed reopens it with the configured template and
   * queues the content until the user replies (see {@link SessionWindowManager}).
   */
  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    if (this.sessionWindow) return this.sessionWindow.send(chatId, await this.replayable(content), options, this.rawSend)
    return this.sendNow(chatId, content, options)
  }

  /**
   * Resolve media once (upload → media id, URL → link) so the session window
   * manager can resend the content (a `{ stream }` is drained by its first
   * read) and never keeps media bytes in its queue or tracked sends.
   */
  private async replayable(content: OutboundContent): Promise<OutboundContent> {
    if (!MEDIA_KINDS.has(content.kind)) return content
    const media = (content as { media: MediaSource }).media
    if (typeof media === 'object' && media !== null && !Buffer.isBuffer(media) && 'native' in media) return content
    return { ...content, media: { native: await this.resolveMedia(media) } } as OutboundContent
  }

  private async sendNow(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    const needsMedia = MEDIA_KINDS.has(content.kind)
    const media = needsMedia ? await this.resolveMedia((content as { media: MediaSource }).media) : undefined
    const message = toOutbound(content, media)
    if (options?.quoted) {
      // Cloud API replies reference the quoted message via context.
      ;(message as Record<string, unknown>).context = { message_id: options.quoted.id }
    }
    // A BSUID target is pinned so its receipts/replies keep this chat id.
    this.identity.noteOutbound(chatId)
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
