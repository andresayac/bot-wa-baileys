/**
 * CloudAPIProvider — WhatsApp Cloud API (official Meta) transport for
 * @botmesh/core. Webhook-based (pushIngress): there is no socket. The host
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
import pino from 'pino'
import type { LoggerLike } from '@botmesh/core'
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
  SerializedMediaRef,
  UserId,
} from '@botmesh/core'
import { ProviderError, UnsupportedContentError, assertFormDefinition, type FormDefinition } from '@botmesh/core'
import { flowRefOf, toFlowJson, toFlowMessage, type FlowJsonOptions, type FlowRef } from './flows.js'
import type { CloudAPIProviderConfig } from './types.js'
import { GraphClient } from './graphClient.js'
import { toOutbound, type ResolvedMedia } from './toOutbound.js'
import { extractDrafts, resolveDrafts, type GraphWebhookBody, type InboundDraft } from './parseInbound.js'
import { IdentityResolver, MemoryIdentityMap, isPromiseLike, type MaybePromise } from './identity.js'
import { SessionWindowManager } from './sessionWindow.js'
import { UsageTracker, pricingOf } from './pricing.js'
import { verifyChallenge, checkGraphSignature, tryParseGraphBody, type ChallengeQuery } from '@botmesh/graph-core'

/** Content kinds that carry a `media` source. */
/** A Cloud API media id (numeric in practice); anything else read back from a journal is rejected. */
const META_MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/
const MEDIA_KINDS: ReadonlySet<OutboundContent['kind']> = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker'])

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', '3gp': 'video/3gpp', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', m4a: 'audio/mp4', amr: 'audio/amr',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/**
 * MIME type sent for an upload of a kind when nothing better is known. The
 * Cloud API rejects `application/octet-stream` for every kind but documents.
 */
const KIND_MIME: Partial<Record<OutboundContent['kind'], string>> = {
  image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mpeg', voice: 'audio/ogg', sticker: 'image/webp', document: 'application/octet-stream',
}

/** MIME type from a file name's extension, if known. */
function mimeOfName(name: string | undefined): string | undefined {
  const ext = name?.split('.').pop()?.toLowerCase()
  return ext ? EXT_MIME[ext] : undefined
}

/** MIME type from well-known magic bytes, if recognised. */
function sniffMime(buf: Buffer): string | undefined {
  const at = (offset: number, ...bytes: number[]) => bytes.every((b, i) => buf[offset + i] === b)
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
  if (at(0, 0x4f, 0x67, 0x67, 0x53)) return 'audio/ogg'
  if (at(0, 0x49, 0x44, 0x33) || at(0, 0xff, 0xfb)) return 'audio/mpeg'
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return 'video/mp4'
  return undefined
}

/** What the uploader knows about a media item besides its bytes. */
interface MediaHints {
  kind: OutboundContent['kind']
  mimetype?: string
  filename?: string
}

/** Upload hints a content item carries (documents name their file and type). */
function mediaHints(content: OutboundContent): MediaHints {
  if (content.kind === 'document') {
    return { kind: 'document', ...(content.mimetype ? { mimetype: content.mimetype } : {}), ...(content.filename ? { filename: content.filename } : {}) }
  }
  return { kind: content.kind }
}

export class CloudAPIProvider implements IProvider<unknown> {
  readonly id = 'meta'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'reaction', 'buttons', 'list', 'template', 'card', 'native', 'form'],
    buttons: true, lists: true, polls: false, reactions: true, edit: false,
    typing: false, presence: false, readReceipts: true, groups: false, templates: true,
    interactionsRequireAck: false, pushIngress: true, forms: 'native',
    textFormat: 'whatsapp', // WhatsApp markup: *bold* _italic_ ~strike~
    streaming: 'none', // no live preview: ctx.stream() sends sentence chunks with typing
  }

  private readonly config: Required<Pick<CloudAPIProviderConfig, 'apiVersion' | 'graphUrl'>> & CloudAPIProviderConfig
  private readonly logger: LoggerLike
  private readonly graph: GraphClient
  private listeners = new Set<(e: InboundEvent) => void | Promise<void>>()
  private readonly identity: IdentityResolver
  /** 24 h window manager (undefined unless `sessionWindow` is configured). */
  readonly sessionWindow: SessionWindowManager | undefined
  /** Pricing/usage counters fed by status webhooks (undefined when `usage: false`). */
  readonly usage: UsageTracker | undefined
  private readonly rawSend = (chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> =>
    this.sendNow(chatId, content, options)
  /** Form id → published WhatsApp Flow (config `flows` + `publishForm()`). */
  private readonly flowRefs = new Map<string, FlowRef>()
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
    for (const [formId, ref] of Object.entries(config.flows ?? {})) {
      this.flowRefs.set(formId, typeof ref === 'string' ? flowRefOf(ref) : ref)
    }
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
   * Returns the HTTP status to answer: 200 accepted, 400 not a JSON object (or a
   * parsed body while `appSecret` is set), 403 bad/missing signature.
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
    const parsed = tryParseGraphBody<GraphWebhookBody>(body)
    if (!parsed.ok) {
      this.logger.warn('Cloud API webhook rejected: body is not a JSON object')
      return parsed.status
    }
    this.dispatch(extractDrafts(parsed.body, this.logger))
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

  /**
   * Upload bytes (or pass a URL through as `link`). The upload's MIME type is the
   * explicit one (documents), else the file name's extension, else the bytes'
   * signature, else the kind's default: never a blanket octet-stream, which the
   * Cloud API rejects for images, audio, video and stickers.
   */
  private async resolveMedia(source: MediaSource, hints: MediaHints): Promise<ResolvedMedia> {
    const upload = async (buffer: Buffer, name?: string): Promise<ResolvedMedia> => {
      const filename = hints.filename ?? name
      const mime = hints.mimetype ?? mimeOfName(filename) ?? sniffMime(buffer) ?? KIND_MIME[hints.kind] ?? 'application/octet-stream'
      return { id: await this.graph.uploadMedia(buffer, mime, filename) }
    }
    const baseName = (path: string): string | undefined => path.split(/[\\/]/).pop()
    if (typeof source === 'string') return /^https?:\/\//i.test(source) ? { link: source } : upload(await readFile(source), baseName(source))
    if (Buffer.isBuffer(source)) return upload(source)
    if ('url' in source) return { link: source.url }
    if ('buffer' in source) return upload(source.buffer)
    if ('path' in source) return upload(await readFile(source.path), baseName(source.path))
    if ('stream' in source) {
      const chunks: Buffer[] = []
      for await (const c of source.stream as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      return upload(Buffer.concat(chunks))
    }
    if ('native' in source) return typeof source.native === 'string' ? { id: source.native } : (source.native as ResolvedMedia)
    throw new UnsupportedContentError(hints.kind, 'Unsupported MediaSource for Cloud API')
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
    return { ...content, media: { native: await this.resolveMedia(media, mediaHints(content)) } } as OutboundContent
  }

  private async sendNow(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    const needsMedia = MEDIA_KINDS.has(content.kind)
    const media = needsMedia ? await this.resolveMedia((content as { media: MediaSource }).media, mediaHints(content)) : undefined
    const message = content.kind === 'form'
      ? toFlowMessage(content, content.nativeId !== undefined ? flowRefOf(content.nativeId) : this.flowRefs.get(content.form.id))
      : toOutbound(content, media)
    if (options?.quoted) {
      // Cloud API replies reference the quoted message via context.
      ;(message as Record<string, unknown>).context = { message_id: options.quoted.id }
    }
    // A BSUID target is pinned so its receipts/replies keep this chat id.
    this.identity.noteOutbound(chatId)
    const res = await this.graph.sendMessage(chatId, message, content.kind)
    return { ref: { id: res.id ?? '', chatId }, raw: res }
  }

  /* WhatsApp Flows ------------------------------------------------------- */

  /**
   * Whether `form` can go out as a WhatsApp Flow: a `nativeId` is given, or a
   * Flow is mapped to `form.id` (`config.flows` or `publishForm()`). When it is
   * `false`, an auto-mode `flow().form()` asks field by field without first
   * sending a form message that would fail.
   */
  canRenderForm(form: FormDefinition, opts?: { nativeId?: string }): boolean {
    return opts?.nativeId !== undefined || this.flowRefs.has(form.id)
  }

  /**
   * Create (and by default publish) a static WhatsApp Flow from a form definition
   * through the Flows API (`POST /{WABA-ID}/flows` with `flow_json`), then map
   * `definition.id` to it so `flow().form(definition)` sends it natively.
   * Idempotency is up to the caller: each call creates a new Flow — persist the
   * returned `flowId` and pass it via `config.flows` on the next start.
   * Requires `wabaId` (config or option) and a token with `whatsapp_business_management`.
   */
  async publishForm(
    definition: FormDefinition,
    opts: { wabaId?: string; name?: string; categories?: string[]; publish?: boolean; flowJson?: FlowJsonOptions } = {},
  ): Promise<{ flowId: string; validationErrors: unknown[] }> {
    assertFormDefinition(definition)
    const wabaId = opts.wabaId ?? this.config.wabaId
    if (!wabaId) throw new ProviderError('publishForm() needs a wabaId (CloudAPIProviderConfig.wabaId or the wabaId option)')
    const res = await this.graph.postJson<{ id?: string; validation_errors?: unknown[] }>(`${wabaId}/flows`, {
      name: opts.name ?? definition.title ?? definition.id,
      categories: opts.categories ?? ['OTHER'],
      flow_json: JSON.stringify(toFlowJson(definition, opts.flowJson)),
      publish: opts.publish ?? true,
    })
    if (!res.id) throw new ProviderError('Flows API returned no flow id')
    const validationErrors = res.validation_errors ?? []
    if (validationErrors.length) this.logger.warn({ form: definition.id, errors: validationErrors.length }, 'WhatsApp Flow has validation errors')
    this.flowRefs.set(definition.id, { flowId: res.id, ...(opts.publish === false ? { mode: 'draft' as const } : {}) })
    return { flowId: res.id, validationErrors }
  }

  /* Capabilities ---------------------------------------------------------- */

  async downloadMedia(ref: MediaRef): Promise<Buffer | NodeJS.ReadableStream> {
    const id = ref.token as string | undefined
    if (!id) throw new ProviderError('downloadMedia requires a media id (MediaRef.token)')
    const { buffer } = await this.graph.downloadMedia(id)
    return buffer
  }

  /**
   * Durable inbox: the Cloud API media id. Meta keeps inbound media for about 30 days; a replay
   * after that fails with the usual download error. No credentials are stored.
   */
  serializeMediaRef(ref: MediaRef): SerializedMediaRef | undefined {
    return typeof ref.token === 'string' && META_MEDIA_ID.test(ref.token) ? { v: 1, data: ref.token } : undefined
  }

  /** Rebuild a journaled media id. @throws {ProviderError} on an invalid or unknown-version value. */
  rehydrateMediaRef(stored: SerializedMediaRef, ref: Omit<MediaRef, 'token'>): MediaRef {
    if (stored?.v !== 1 || typeof stored.data !== 'string' || !META_MEDIA_ID.test(stored.data)) {
      throw new ProviderError('Invalid Cloud API media reference')
    }
    return { ...ref, token: stored.data }
  }

  async markRead(refs: MessageRef[]): Promise<void> {
    for (const r of refs) if (r.id) await this.graph.markRead(r.id)
  }

  /** Cloud API has no typing/presence primitive. */
  async typing(): Promise<void> {}
  /** Cloud API cannot delete a sent message for everyone. */
  async deleteMessage(): Promise<void> {}
}
