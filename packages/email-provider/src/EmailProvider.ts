/**
 * EmailProvider — email transport for @bot-wa/core.
 *
 * Inbound: IMAP IDLE (imapflow, optional peer, loaded lazily) or `ingest(raw)`
 * for RFC 822 bytes pushed by an inbound-mail webhook. Outbound: SMTP
 * (nodemailer, optional peer, loaded lazily).
 *
 * Identity: `senderId` is the normalized From address. Chats: one per email
 * thread (`thread:<root Message-ID>`) or one per correspondent
 * (`threading: 'sender'`). Bounces become `status: 'failed'` events, automated
 * mail (auto-replies, lists, bulk) is dropped before it reaches handlers, and
 * outbound mail is stamped `Auto-Submitted: auto-replied` so the other side's
 * robots stay quiet too.
 *
 * Trust: `From` is NOT authenticated by email itself. Set
 * `requireAuthentication` to accept only mail your MTA verified (DMARC/DKIM).
 * Independently, bounces only act on messages the bot sent, a thread chat
 * belongs to the correspondent who opened it, and a cross-domain `Reply-To`
 * does not redirect replies unless `replyTo: 'always'`.
 *
 * @example
 * ```ts
 * const provider = new EmailProvider({
 *   address: 'soporte@acme.com',
 *   imap: { host: 'imap.gmail.com', user: 'soporte@acme.com', pass: process.env.IMAP_PASS },
 *   smtp: { host: 'smtp.gmail.com', user: 'soporte@acme.com', pass: process.env.SMTP_PASS },
 * })
 * const bot = new Bot({ provider })
 * ```
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import pino from 'pino'
import { secureFetch, SecureHttpError, type SecureFetchOptions } from '@bot-wa/http'
import {
  PayloadTooLargeError,
  ProviderError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type ChatId,
  type ConnectionState,
  type DisconnectReason,
  type IProvider,
  type InboundEvent,
  type InboundMessage,
  type LoggerLike,
  type MediaRef,
  type MediaSource,
  type MessageType,
  type OutboundContent,
  type ProviderCapabilities,
  type SendOptions,
  type SendResult,
  type UserId,
} from '@bot-wa/core'
import { domainOf, looksLikeAddress, normalizeAddress, type EmailAddress } from './address.js'
import { isAuthenticated } from './auth.js'
import { detectBounce } from './bounce.js'
import { composeContent, type ResolvedMedia } from './compose.js'
import { toEmailProviderError } from './errors.js'
import { htmlToText } from './html.js'
import { ImapIngress, isAuthError, type ImapMessageMeta } from './imap.js'
import { loadModule } from './loadModule.js'
import { detectAutomated, SenderFloodGuard, type AutomatedReason } from './loop.js'
import { parseEmail, type ParsedAttachment, type ParsedEmail } from './mime.js'
import { stripQuotedReply } from './reply.js'
import { baseSubject, MemoryThreadStore, ThreadTracker, threadOwner, type EmailMailboxCursor } from './threading.js'
import type {
  EmailMediaToken,
  EmailProviderConfig,
  EmailRaw,
  ImapClientLike,
  SmtpMailOptions,
  SmtpSendInfo,
  SmtpTransportLike,
} from './types.js'

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024
const DEFAULT_FLOOD = { max: 30, windowMs: 3_600_000 }
const DEFAULT_MAX_INBOUND_BYTES = 40 * 1024 * 1024
const MAX_SUPPRESSED = 10_000

/** Why `ingest()` / IMAP processing did not emit a message. */
export type EmailSkipReason = AutomatedReason | 'self' | 'bounce' | 'flood' | 'invalid' | 'too-large' | 'unauthenticated'

/** Result of `EmailProvider.ingest()` — `status` is suitable as an HTTP status. */
export interface EmailIngestResult {
  status: 200 | 400 | 413
  accepted: boolean
  reason?: EmailSkipReason
}

const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex').slice(0, 32)

/** The message's Message-ID, or a stable synthetic one derived from its bytes. */
const messageIdOf = (email: ParsedEmail, source: Buffer): string => email.messageId ?? `synthetic-${digestOf(source)}`

/** Attachment cache key: content-addressed, so a reused or forged Message-ID never overwrites another message's bytes. */
const cacheKey = (token: Pick<EmailMediaToken, 'messageId' | 'index' | 'digest'>): string =>
  `${token.messageId}#${token.index}#${token.digest}`

function mediaKind(mimetype: string): MediaRef['kind'] {
  if (mimetype.startsWith('image/')) return 'image'
  if (mimetype.startsWith('video/')) return 'video'
  if (mimetype.startsWith('audio/')) return 'audio'
  return 'document'
}

export class EmailProvider implements IProvider<EmailRaw> {
  readonly id = 'email'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'buttons', 'list', 'card', 'native'],
    maxMediaBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
    buttons: false,        // degraded to numbered text
    lists: false,          // degraded to numbered text
    polls: false,
    reactions: false,
    edit: false,
    typing: false,
    presence: false,
    readReceipts: false,
    groups: false,
    templates: false,
    interactionsRequireAck: false,
    pushIngress: false,    // owns its IMAP connection; ingest() is an extra seam
    streaming: 'none',   // no live preview: ctx.stream() sends sentence chunks
    forms: 'degraded', // flow().form() asks field by field
  }

  private readonly config: EmailProviderConfig
  private readonly logger: LoggerLike
  private readonly address: string
  private readonly self: string
  private readonly tracker: ThreadTracker
  private readonly flood?: SenderFloodGuard
  private readonly ignore: ReadonlySet<AutomatedReason>
  private readonly loopProtection: boolean
  private readonly maxAttachmentBytes: number
  private readonly cacheLimit: number
  private readonly maxInboundBytes: number
  private readonly http: SecureFetchOptions
  private readonly listeners = new Set<(e: InboundEvent<EmailRaw>) => void | Promise<void>>()
  private readonly suppressed = new Set<string>()
  private readonly cache = new Map<string, Buffer>()
  private cacheBytes = 0
  private ingress?: ImapIngress
  private transport?: SmtpTransportLike
  private transportPromise?: Promise<SmtpTransportLike>
  private running = false
  /** Last IMAP UID cursor of this instance, reused by the next start(). */
  private imapCursor?: EmailMailboxCursor

  constructor(config: EmailProviderConfig) {
    this.config = config
    const candidate = config.address
      ?? [config.smtp?.user, config.imap?.user].find((u): u is string => !!u && looksLikeAddress(u))
    if (!candidate || !looksLikeAddress(candidate)) {
      throw new ProviderError('EmailProvider requires `address` (the bot mailbox, e.g. "soporte@acme.com")')
    }
    this.address = candidate.trim()
    this.self = normalizeAddress(candidate)
    this.logger = config.logger ?? (pino({ level: config.debug ? 'debug' : 'error' }) as unknown as LoggerLike)
    this.tracker = new ThreadTracker({
      store: config.threadStore ?? new MemoryThreadStore(),
      mode: config.threading ?? 'thread',
      replyTo: config.replyTo ?? 'same-domain',
    })
    const lp = config.loopProtection
    this.loopProtection = lp !== false
    this.ignore = new Set(lp ? lp.ignore ?? [] : [])
    const floodOpts = lp === false ? false : (lp?.maxPerSender ?? DEFAULT_FLOOD)
    if (floodOpts) this.flood = new SenderFloodGuard(floodOpts)
    this.maxAttachmentBytes = config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
    this.capabilities.maxMediaBytes = this.maxAttachmentBytes
    this.cacheLimit = Math.max(0, config.attachmentCacheBytes ?? DEFAULT_CACHE_BYTES)
    this.maxInboundBytes = Math.max(1, config.maxInboundBytes ?? DEFAULT_MAX_INBOUND_BYTES)
    this.http = config.http ?? {}
    this.transport = config.smtpTransport
  }

  get selfId(): UserId | null { return this.self }
  get connection(): unknown { return null }

  /* Events ---------------------------------------------------------------- */

  onEvent(listener: (e: InboundEvent<EmailRaw>) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private fan(e: InboundEvent<EmailRaw>): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(e))
          .catch((error: unknown) => this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed'))
      } catch (error) {
        this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed')
      }
    }
  }

  private emitConnection(state: ConnectionState, reason?: DisconnectReason, detail?: string): void {
    const update: { state: ConnectionState; reason?: DisconnectReason; detail?: { message: string } } = { state }
    if (reason) update.reason = reason
    if (detail) update.detail = { message: detail }
    this.fan({ kind: 'connection', update })
  }

  /* Lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.emitConnection('connecting')
    try {
      if (this.config.smtp?.verify) {
        const transport = await this.getTransport()
        await transport.verify?.()
      }
      if (this.config.imap || this.config.createImapClient) {
        const mailbox = this.config.imap?.mailbox ?? 'INBOX'
        // The UID cursor survives stop()/start(), and a restart when the thread store keeps it.
        const store = this.tracker.store
        const cursorKey = `${this.self}/${mailbox}`
        let resumeFrom = this.imapCursor
        if (!resumeFrom && store.getMailboxCursor) {
          try {
            resumeFrom = await store.getMailboxCursor(cursorKey)
          } catch (err) {
            this.logger.warn({ err }, 'imap cursor could not be loaded; using processExisting')
          }
        }
        this.ingress = new ImapIngress({
          createClient: () => this.createImapClient(),
          mailbox,
          resumeFrom,
          onCursor: async (cursor) => {
            this.imapCursor = cursor
            await store.setMailboxCursor?.(cursorKey, cursor)
          },
          markSeen: this.config.markSeen ?? true,
          processExisting: this.config.processExisting ?? 'unseen',
          maxMessageBytes: this.maxInboundBytes,
          onMessage: async (source, meta) => { await this.handleRaw(source, meta) },
          onState: (state, reason, detail) => this.emitConnection(state, reason, detail),
          logger: this.logger,
          reconnectBaseMs: this.config.reconnect?.baseMs ?? 1000,
          reconnectMaxMs: this.config.reconnect?.maxMs ?? 60_000,
        })
        await this.ingress.start() // emits `ready` once the mailbox is selected
      } else {
        this.emitConnection('ready')
      }
    } catch (err) {
      this.running = false
      this.ingress = undefined
      const detail = err instanceof Error ? err.message : String(err)
      this.emitConnection('closed', isAuthError(err) ? 'sessionInvalid' : 'transient', detail)
      if (err instanceof ProviderError) throw err
      throw new ProviderError(isAuthError(err) ? `IMAP authentication failed: ${detail}` : `Email provider failed to start: ${detail}`)
    }
  }

  async stop(): Promise<void> {
    const wasRunning = this.running
    this.running = false
    await this.ingress?.stop()
    this.ingress = undefined
    try { this.transport?.close?.() } catch { /* ignore */ }
    if (wasRunning) this.emitConnection('closed')
  }

  private async createImapClient(): Promise<ImapClientLike> {
    if (this.config.createImapClient) return this.config.createImapClient()
    const imap = this.config.imap!
    const mod = await loadModule<{ ImapFlow: new (opts: Record<string, unknown>) => ImapClientLike }>('imapflow', 'IMAP inbound')
    const port = imap.port ?? 993
    return new mod.ImapFlow({
      host: imap.host,
      port,
      secure: imap.secure ?? port !== 143,
      auth: imap.accessToken ? { user: imap.user, accessToken: imap.accessToken } : { user: imap.user, pass: imap.pass },
      logger: false,
      // imapflow re-enters IDLE only after this much inactivity (default 15 s): new mail would wait that long.
      autoIdleDelay: 1000,
      ...imap.options,
    })
  }

  private getTransport(): Promise<SmtpTransportLike> {
    if (this.transport) return Promise.resolve(this.transport)
    if (!this.config.smtp) {
      return Promise.reject(new ProviderError('EmailProvider cannot send: configure `smtp` (or pass `smtpTransport`)'))
    }
    this.transportPromise ??= (async () => {
      const smtp = this.config.smtp!
      const mod = await loadModule<{ default?: { createTransport(o: Record<string, unknown>): SmtpTransportLike }; createTransport?(o: Record<string, unknown>): SmtpTransportLike }>('nodemailer', 'SMTP outbound')
      const create = mod.default?.createTransport ?? mod.createTransport
      if (!create) throw new ProviderError('nodemailer.createTransport not found')
      const port = smtp.port ?? 465
      const auth = smtp.accessToken
        ? { type: 'OAuth2', user: smtp.user, accessToken: smtp.accessToken }
        : smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined
      this.transport = create({ host: smtp.host, port, secure: smtp.secure ?? port === 465, auth, ...smtp.options })
      return this.transport
    })()
    this.transportPromise.catch(() => { this.transportPromise = undefined })
    return this.transportPromise
  }

  /* Inbound ---------------------------------------------------------------- */

  /**
   * Push a raw RFC 822 message (Buffer / string / Uint8Array) — for inbound-mail
   * webhooks (SES, Mailgun "raw MIME", Postfix pipe) or tests. Resolves once the
   * message was classified; handlers run asynchronously.
   */
  async ingest(rawEvent: unknown): Promise<EmailIngestResult> {
    let source: Buffer
    if (typeof rawEvent === 'string') source = Buffer.from(rawEvent, 'utf8')
    else if (rawEvent instanceof Uint8Array) source = Buffer.from(rawEvent)
    else return { status: 400, accepted: false, reason: 'invalid' }
    if (source.length > this.maxInboundBytes) return { status: 413, accepted: false, reason: 'too-large' }
    const reason = await this.handleRaw(source)
    return reason ? { status: 200, accepted: false, reason } : { status: 200, accepted: true }
  }

  /** Classify and emit one raw email. Returns the skip reason, or undefined when a message was emitted. */
  private async handleRaw(source: Buffer, meta?: ImapMessageMeta): Promise<EmailSkipReason | undefined> {
    let email: ParsedEmail
    try {
      email = parseEmail(source)
    } catch (err) {
      this.logger.warn({ err, uid: meta?.uid }, 'unparseable email skipped')
      return 'invalid'
    }
    const sender = email.from ? normalizeAddress(email.from.address) : undefined
    if (sender && sender === this.self) {
      this.logger.debug({ uid: meta?.uid }, 'own email skipped')
      return 'self'
    }

    const bounce = detectBounce(email)
    if (bounce) {
      await this.handleBounce(bounce)
      return 'bounce'
    }

    const auth = this.config.requireAuthentication
    if (auth && !isAuthenticated(email, auth.authservId)) {
      this.logger.debug({ uid: meta?.uid }, 'unauthenticated email skipped')
      return 'unauthenticated'
    }

    if (this.loopProtection) {
      const automated = detectAutomated(email)
      if (automated && !this.ignore.has(automated)) {
        this.logger.debug({ uid: meta?.uid, reason: automated }, 'automated email skipped')
        return automated
      }
    }
    if (!sender) return 'invalid'
    if (this.flood && !this.flood.allow(sender)) {
      this.logger.warn({ uid: meta?.uid }, 'sender exceeded the inbound rate cap; email skipped (loop protection)')
      return 'flood'
    }

    const messageId = messageIdOf(email, source)
    const chatId = await this.tracker.resolveInbound(email, sender, messageId)
    this.fan({ kind: 'message', message: this.toInbound(email, messageId, chatId, sender, meta) })
    return undefined
  }

  private toInbound(email: ParsedEmail, messageId: string, chatId: ChatId, sender: string, meta?: ImapMessageMeta): InboundMessage<EmailRaw> {
    const attachments: MediaRef[] = email.attachments.map((a, index) => {
      const token: EmailMediaToken = { messageId, index, digest: digestOf(a.content) }
      if (meta?.uid !== undefined) token.uid = meta.uid
      if (meta?.uidValidity !== undefined) token.uidValidity = meta.uidValidity
      this.cachePut(cacheKey(token), a.content)
      return { kind: mediaKind(a.mimetype), mimetype: a.mimetype, filename: a.filename, size: a.size, token }
    })
    const primaryIndex = email.attachments.findIndex((a: ParsedAttachment) => !a.inline)
    const media = primaryIndex === -1 ? undefined : attachments[primaryIndex]

    const fullText = email.text ?? (email.html ? htmlToText(email.html) : '')
    const stripped = this.config.stripQuotes === false ? fullText.trim() : stripQuotedReply(fullText)
    const body = stripped || (media ? '' : email.subject)
    const type: MessageType = media ? media.kind : 'text'
    const timestamp = email.date?.getTime() ?? meta?.internalDate?.getTime() ?? Date.now()
    const subject = baseSubject(email.subject)

    const headers: Record<string, string[]> = {}
    for (const [k, v] of email.headers) headers[k] = [...v]
    const raw: EmailRaw = {
      messageId: email.messageId,
      inReplyTo: email.inReplyTo,
      references: email.references,
      subject: email.subject,
      from: email.from,
      to: email.to,
      cc: email.cc,
      replyTo: email.replyTo,
      date: email.date?.toISOString(),
      text: email.text ?? (email.html ? fullText : undefined),
      html: email.html,
      attachments,
      headers,
      uid: meta?.uid,
      mailbox: meta?.mailbox,
    }
    const message: InboundMessage<EmailRaw> = {
      ref: { id: messageId, chatId },
      chat: {
        id: chatId,
        kind: 'dm',
        name: subject || undefined,
        isGroup: false,
        isBroadcast: false,
        platformData: { subject },
      },
      senderInfo: {
        id: sender,
        displayName: email.from?.name,
        username: email.from?.address,
      },
      from: chatId,
      sender,
      chatId,
      senderId: sender,
      isGroup: false,
      isBroadcast: false,
      fromMe: false,
      type,
      body,
      timestamp,
      mentions: [],
      raw,
    }
    if (media) message.media = media
    if (email.inReplyTo) message.quoted = { ref: { id: email.inReplyTo, chatId } }
    return message
  }

  /**
   * Act on a bounce only when it reports a message the bot sent, for that
   * message's recipient (and legacy bounces only from MAILER-DAEMON /
   * postmaster). Anything else is a forgery or noise and is dropped silently.
   */
  private async handleBounce(bounce: NonNullable<ReturnType<typeof detectBounce>>): Promise<void> {
    const original = bounce.originalMessageId
    const chatId = original ? await this.tracker.outboundChat(original) : undefined
    const thread = chatId ? await this.tracker.store.getThread(chatId) : undefined
    if (!original || !chatId || !thread || (bounce.format === 'legacy' && !bounce.systemSender)) {
      this.logger.debug({ format: bounce.format }, 'bounce for a message the bot did not send ignored')
      return
    }
    const recipients = new Set([normalizeAddress(thread.counterpart.address), threadOwner(thread)])
    for (const r of bounce.recipients) {
      if (!recipients.has(r.address)) continue
      if (r.permanent && (this.config.suppressBounced ?? true)) this.suppress(r.address)
      if (r.action !== 'failed' && !r.permanent) continue // delayed / relayed: informational only
      const error: { code?: string; message?: string } = {}
      if (r.status) error.code = r.status
      if (r.diagnostic) error.message = r.diagnostic
      this.fan({
        kind: 'status',
        status: {
          ref: { id: original, chatId },
          status: 'failed',
          recipient: r.address,
          error,
          timestamp: Date.now(),
        },
      })
    }
    this.logger.debug({ recipients: bounce.recipients.length }, 'bounce processed')
  }

  private suppress(address: string): void {
    this.suppressed.delete(address)
    this.suppressed.add(address)
    while (this.suppressed.size > MAX_SUPPRESSED) {
      const oldest = this.suppressed.values().next().value
      if (oldest === undefined) break
      this.suppressed.delete(oldest)
    }
  }

  /* Suppression ------------------------------------------------------------ */

  /** True when `address` hard-bounced and sends to it are refused. */
  isSuppressed(address: string): boolean {
    return this.suppressed.has(normalizeAddress(address))
  }

  /** Allow sending to a previously bounced address again. */
  unsuppress(address: string): void {
    this.suppressed.delete(normalizeAddress(address))
  }

  /** Addresses currently suppressed after a hard bounce (normalized). */
  suppressedAddresses(): string[] {
    return [...this.suppressed]
  }

  /* Media ------------------------------------------------------------------ */

  private cachePut(key: string, content: Buffer): void {
    const previous = this.cache.get(key)
    if (previous) {
      this.cache.delete(key)
      this.cacheBytes -= previous.length
    }
    if (content.length > this.cacheLimit) return
    this.cache.set(key, content)
    this.cacheBytes += content.length
    while (this.cacheBytes > this.cacheLimit) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cacheBytes -= this.cache.get(oldest)?.length ?? 0
      this.cache.delete(oldest)
    }
  }

  async downloadMedia(ref: MediaRef): Promise<Buffer> {
    const token = ref.token as Partial<EmailMediaToken> | undefined
    if (!token || typeof token.messageId !== 'string' || typeof token.index !== 'number') {
      throw new ProviderError('Not an EmailProvider media reference')
    }
    if (typeof token.digest !== 'string') throw new ProviderError('Not an EmailProvider media reference')
    const cached = this.cache.get(cacheKey({ messageId: token.messageId, index: token.index, digest: token.digest }))
    if (cached) return cached
    if (typeof token.uid === 'number' && this.ingress) {
      // The UID must still hold the same message: same UIDVALIDITY, same Message-ID, same bytes.
      const validity = typeof token.uidValidity === 'string' ? token.uidValidity : undefined
      const source = await this.ingress.fetchSource(token.uid, validity)
      if (source) {
        const parsed = parseEmail(source)
        const attachment = parsed.attachments[token.index]
        if (attachment && messageIdOf(parsed, source) === token.messageId && digestOf(attachment.content) === token.digest) {
          return attachment.content
        }
      }
    }
    throw new ProviderError('Email attachment is no longer available (evicted from cache and not refetchable)')
  }

  private async resolveMedia(source: MediaSource, kind: OutboundContent['kind']): Promise<ResolvedMedia> {
    if (typeof source === 'string') {
      if (/^https?:\/\//i.test(source)) return this.fetchUrl(source, kind)
      return { content: await readFile(source), filename: basename(source) }
    }
    if (Buffer.isBuffer(source)) return { content: source }
    if ('url' in source) return this.fetchUrl(source.url, kind)
    if ('buffer' in source) return { content: source.buffer }
    if ('path' in source) return { content: await readFile(source.path), filename: basename(source.path) }
    if ('stream' in source) {
      const chunks: Buffer[] = []
      let total = 0
      for await (const c of source.stream as AsyncIterable<Buffer | string>) {
        const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c)
        total += chunk.length
        if (total > this.maxAttachmentBytes) throw new PayloadTooLargeError(`Attachment exceeds ${this.maxAttachmentBytes} bytes`)
        chunks.push(chunk)
      }
      return { content: Buffer.concat(chunks) }
    }
    throw new UnsupportedContentError(kind, 'EmailProvider does not support native media sources')
  }

  private async fetchUrl(url: string, kind: OutboundContent['kind']): Promise<ResolvedMedia> {
    try {
      const { response, body, url: finalUrl } = await secureFetch(url, { maxBytes: this.maxAttachmentBytes, ...this.http })
      if (!response.ok) throw new ProviderError(`Fetching ${kind} attachment failed: HTTP ${response.status}`)
      const last = finalUrl.pathname.split('/').filter(Boolean).pop()
      let filename: string | undefined
      try { filename = last ? decodeURIComponent(last) : undefined } catch { filename = last }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || undefined
      return { content: body, filename, contentType }
    } catch (err) {
      if (err instanceof SecureHttpError && err.code === 'RESPONSE_TOO_LARGE') throw new PayloadTooLargeError(err.message)
      if (err instanceof ProviderError) throw err
      throw new ProviderError(`Fetching ${kind} attachment failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /* Outbound --------------------------------------------------------------- */

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<EmailRaw>> {
    const thread = await this.tracker.store.getThread(chatId)
    let to: EmailAddress
    if (thread) to = thread.counterpart
    else if (looksLikeAddress(chatId)) to = { address: chatId.trim() }
    else throw new RecipientUnreachableError(chatId, `Unknown email thread "${chatId}" (thread state lost or never seen)`)
    if (this.suppressed.has(normalizeAddress(to.address))) {
      throw new RecipientUnreachableError(chatId, 'Recipient address hard-bounced; call unsuppress() to retry')
    }

    const composed = await composeContent(content, (src, kind) => this.resolveMedia(src, kind))
    const attachments = composed.attachments
    const total = attachments.reduce((n, a) => n + a.content.length, 0)
    if (total > this.maxAttachmentBytes) {
      throw new PayloadTooLargeError(`Attachments total ${total} bytes; limit is ${this.maxAttachmentBytes}`)
    }

    const pd = options?.platformData ?? {}
    const subject = (typeof pd.subject === 'string' && pd.subject)
      || composed.overrides.subject
      || (thread?.subject ? `Re: ${thread.subject}` : this.config.defaultSubject ?? '(no subject)')
    const id = `${randomUUID()}@${domainOf(this.address) ?? 'bot-wa.local'}`
    const inReplyTo = options?.quoted?.id ?? thread?.lastMessageId
    const refs = [...(thread?.references ?? [])]
    if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo)

    // Native headers never override the provider's own (protected names are dropped in composeContent).
    const headers: Record<string, string> = { ...composed.overrides.headers }
    if (this.config.autoSubmitted !== false) {
      headers['Auto-Submitted'] = this.config.autoSubmitted ?? 'auto-replied'
      headers['X-Auto-Response-Suppress'] = 'All'
    }

    const mail: SmtpMailOptions = {
      from: this.config.fromName ? { name: this.config.fromName, address: this.address } : { address: this.address },
      to: to.name ? { name: to.name, address: to.address } : { address: to.address },
      subject,
      text: composed.overrides.text ?? composed.text,
      messageId: `<${id}>`,
      headers,
    }
    const html = (typeof pd.html === 'string' ? pd.html : undefined) ?? composed.overrides.html ?? composed.html
    if (html) mail.html = html
    if (attachments.length) mail.attachments = attachments
    if (inReplyTo) mail.inReplyTo = `<${inReplyTo}>`
    if (refs.length) mail.references = refs.map((r) => `<${r}>`)
    if (composed.overrides.cc) mail.cc = composed.overrides.cc
    if (composed.overrides.bcc) mail.bcc = composed.overrides.bcc

    const transport = await this.getTransport()
    let info: SmtpSendInfo
    try {
      info = await transport.sendMail(mail)
    } catch (err) {
      throw toEmailProviderError(err, chatId)
    }
    if (info.rejected?.length && !info.accepted?.length) {
      throw new RecipientUnreachableError(chatId, `SMTP server rejected the recipient${info.response ? `: ${info.response}` : ''}`)
    }
    await this.tracker.recordOutbound(chatId, id, thread ? undefined : { counterpart: to, subject: baseSubject(subject) })
    return { ref: { id, chatId } }
  }
}
