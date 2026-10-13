/**
 * BaileysProvider — WhatsApp transport implementing {@link IProvider} v2.
 *
 * Owns the Baileys socket lifecycle (connect, QR/pairing, reconnect), translates
 * every Baileys event into a normalized {@link InboundEvent}, maps outbound
 * {@link OutboundContent} to Baileys content, and resolves LID/PN identity
 * internally so core never sees a WhatsApp concept.
 */

import { EventEmitter } from 'events'
import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import makeWASocket, {
  Browsers,
  type proto,
  type WACallEvent,
  type WAMessage,
  type WAMessageKey,
  fetchLatestBaileysVersion,
  getAggregateVotesInPollMessage,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
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
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  PayloadTooLargeError,
} from '@bot-wa/core'
import { classifyDisconnect, backoffDelay, MAX_RECONNECT_ATTEMPTS } from './reconnect.js'
import { putBounded } from './boundedMap.js'
import { IdentityStore } from './identity.js'
import { toInbound } from './toInbound.js'
import { toCallEvent } from './toCallEvent.js'
import { normalize } from './jid.js'
import { toOutbound } from './toOutbound.js'
import { RateLimiter, type RateLimitConfig } from './RateLimiter.js'
import {
  assertSessionDirectorySafe,
  removeSessionDirectory,
  resolveSessionDirectory,
} from './sessionPath.js'

const LID_CACHE_MAX = 2000
const MSG_CACHE_MAX = 2000

/** Terminal/file QR rendering options. */
export interface QrConfig {
  terminal?: boolean
  /**
   * Write the QR as a PNG. `true` → `<session>.qr.png` in the CWD; a string sets
   * an explicit output path (recommended — the CWD default is often not writable
   * or not where you expect). Write errors are logged, never thrown.
   */
  file?: boolean | string
  small?: boolean
  handler?: (qr: string) => void | Promise<void>
}

/** Configuration for the WhatsApp (Baileys) transport. */
export interface BaileysProviderConfig {
  session?: string
  sessionsDir?: string
  browser?: 'macOS' | 'ubuntu' | 'windows' | 'appropriate' | [string, string, string]
  markOnlineOnConnect?: boolean
  syncFullHistory?: boolean
  ignoreNewsletters?: boolean
  ignoreBroadcasts?: boolean
  reconnect?: boolean
  qr?: QrConfig
  /** Phone number (international format) for pairing-code login instead of QR. */
  pairingCode?: string
  /** Anti-ban outbound pacing. */
  rateLimit?: RateLimitConfig
  debug?: boolean
  logger?: Logger
}

const cacheKey = (k: WAMessageKey) => `${k.remoteJid}:${k.id}`

/**
 * Map a raw error thrown by `sock.sendMessage` to a typed {@link ProviderError},
 * so callers can `catch (e instanceof RateLimitedError)` portably across
 * transports. Unknown errors are wrapped in a generic ProviderError (with the
 * original attached as `cause`) rather than leaking a Baileys/Boom internal.
 */
export function mapSendError(err: unknown, chatId: ChatId): ProviderError {
  if (err instanceof ProviderError) return err
  const boom = err instanceof Boom ? err : undefined
  const status = boom?.output?.statusCode
  const message = err instanceof Error ? err.message : String(err)

  if (status === 429) {
    const retryAfter = Number(boom?.output?.headers?.['retry-after']) * 1000
    return new RateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1000, message)
  }
  if (status === 413 || /too large|payload.*large|exceeds/i.test(message)) {
    return new PayloadTooLargeError(message)
  }
  if (status === 403 || status === 401 || /forbidden|not-authorized|unauthorized|blocked/i.test(message)) {
    return new RecipientUnreachableError(chatId, message)
  }
  const wrapped = new ProviderError(message || 'Baileys send failed')
  ;(wrapped as { cause?: unknown }).cause = err
  return wrapped
}

export class BaileysProvider implements IProvider<WAMessage> {
  readonly id = 'baileys'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll', 'reaction', 'buttons', 'list', 'card'],
    maxTextLength: 65536,
    buttons: false, lists: false, polls: true, reactions: true, edit: false,
    typing: true, presence: true, readReceipts: true, groups: true, templates: false,
    interactionsRequireAck: false, pushIngress: false,
  }

  private readonly config: BaileysProviderConfig
  private readonly logger: Logger
  private sock: ReturnType<typeof makeWASocket> | null = null
  private msgRetryCounterCache = new NodeCache({ stdTTL: 0, useClones: false })
  private authState: Awaited<ReturnType<typeof useMultiFileAuthState>> | null = null
  private version: [number, number, number] = [0, 0, 0]
  private reconnectPending = false
  private reconnectAttempts = 0
  private isShuttingDown = false
  private pairingCodeRequested = false
  private lidCache = new Map<string, string>()
  private msgCache = new Map<string, WAMessage>()
  private identity = new IdentityStore()
  /** Call id → group JID of group calls in progress (see {@link toCallEvent}). */
  private callGroups = new Map<string, string>()
  private rateLimiter: RateLimiter
  private listeners = new Set<(e: InboundEvent<WAMessage>) => void | Promise<void>>()

  constructor(config: BaileysProviderConfig = {}) {
    this.config = config
    this.logger = config.logger ?? pino({
      level: config.debug ? 'debug' : 'error',
    })
    this.rateLimiter = new RateLimiter(config.rateLimit)
    // Validate eagerly, before any filesystem or network operation.
    resolveSessionDirectory(this.config.sessionsDir, this.config.session)
  }

  get connection(): unknown | null { return this.sock }
  get selfId(): UserId | null {
    return (this.authState?.state?.creds?.me?.id as string | undefined) ?? null
  }
  get socket(): ReturnType<typeof makeWASocket> | null { return this.sock }
  get auth() {
    if (!this.authState) throw new Error('Provider not started')
    return this.authState
  }

  get sessionDir(): string {
    return resolveSessionDirectory(this.config.sessionsDir, this.config.session)
  }

  onEvent(listener: (e: InboundEvent<WAMessage>) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private fan(e: InboundEvent<WAMessage>): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(e))
          .catch((error) => this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed'))
      } catch (error) {
        this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed')
      }
    }
  }

  async start(): Promise<void> {
    this.pairingCodeRequested = false
    this.isShuttingDown = false
    const sessionDir = assertSessionDirectorySafe(this.config.sessionsDir, this.config.session)
    this.authState = await useMultiFileAuthState(sessionDir)
    const versionInfo = await fetchLatestBaileysVersion()
    this.version = versionInfo.version
    this.logger.debug({ version: this.version, latest: versionInfo.isLatest }, 'baileys version')
    await this.buildSocket()
  }

  async stop(): Promise<void> {
    this.reconnectPending = false
    this.isShuttingDown = true
    this.rateLimiter.reset()
    if (this.sock) {
      try { this.sock.end(new Error('shutdown')) } catch { /* socket may already be closed */ }
      this.sock = null
    }
  }

  /**
   * Explicit destructive logout. Unlike {@link stop}, this unlinks the device
   * and removes its local auth state, so a new QR/pairing flow will be required.
   */
  async logoutAndDeleteSession(): Promise<void> {
    this.reconnectPending = false
    this.isShuttingDown = true
    this.rateLimiter.reset()
    if (this.sock) {
      try { await this.sock.logout() }
      finally { this.sock = null }
    }
    removeSessionDirectory(this.config.sessionsDir, this.config.session)
    this.authState = null
  }

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<WAMessage>> {
    if (!this.sock) throw new ProviderError('Provider not connected')
    const waContent = await toOutbound(content)
    const waOptions: Record<string, unknown> = {}
    if (options?.quoted?.native) waOptions.quoted = options.quoted.native
    const resolvedJid = await this.resolveJid(chatId)
    await this.rateLimiter.acquire(chatId)
    try {
      const sent = (await this.sock.sendMessage(resolvedJid, waContent, waOptions)) as WAMessage
      return { ref: { id: sent.key.id ?? '', chatId, native: sent }, raw: sent }
    } catch (err) {
      throw mapSendError(err, chatId)
    }
  }

  async downloadMedia(ref: MediaRef): Promise<Buffer | NodeJS.ReadableStream> {
    const message = ref.token as WAMessage
    return downloadMediaMessage(message, 'buffer', {}, {
      logger: this.logger,
      reuploadRequest: this.sock!.updateMediaMessage,
    })
  }

  async markRead(refs: MessageRef[]): Promise<void> {
    const keys = refs.map((r) => (r.native as WAMessage).key)
    await this.sock?.readMessages(keys)
  }

  async typing(chatId: ChatId, state: 'typing' | 'recording' | 'paused' = 'typing'): Promise<void> {
    const presence = state === 'typing' ? 'composing' : state
    await this.sock?.sendPresenceUpdate(presence, chatId)
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    const key = (ref.native as WAMessage).key
    await this.sock?.sendMessage(ref.chatId, { delete: key })
  }

  /* Identity resolution (internal) --------------------------------------- */

  private async resolveJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid
    return (await this.getPNForLID(jid)) ?? jid
  }

  async getPNForLID(lid: string): Promise<string | undefined> {
    const cached = this.lidCache.get(lid)
    if (cached) return cached
    const pn = await this.sock?.signalRepository.lidMapping.getPNForLID(lid).catch(() => null)
    if (pn) { this.cacheLid(lid, pn); this.identity.observe(lid, pn) }
    return pn ?? undefined
  }

  private cacheLid(a: string, b: string): void { putBounded(this.lidCache, a, b, LID_CACHE_MAX) }

  private cacheLidMapping(update: unknown): void {
    if (!update || typeof update !== 'object') return
    const pairs = Array.isArray(update) ? update : [update]
    for (const entry of pairs) {
      if (entry && typeof entry === 'object' && 'lid' in entry && 'pn' in entry) {
        const { lid, pn } = entry as { lid?: string; pn?: string }
        if (lid && pn) { this.cacheLid(lid, pn); this.identity.observe(lid, pn) }
      }
    }
  }

  private rememberMessage(m: WAMessage): void {
    if (!m.key?.id) return
    this.msgCache.set(cacheKey(m.key), m)
    if (this.msgCache.size > MSG_CACHE_MAX) {
      const oldest = this.msgCache.keys().next()
      if (!oldest.done) this.msgCache.delete(oldest.value)
    }
  }

  // ---------------------------------------------------------------------------

  private async buildSocket(): Promise<void> {
    if (!this.authState) throw new Error('auth state missing — call start() first')
    const browser: [string, string, string] =
      this.config.browser === undefined || this.config.browser === 'macOS' ? Browsers.macOS('Desktop')
        : this.config.browser === 'ubuntu' ? Browsers.ubuntu('Bot')
          : this.config.browser === 'windows' ? Browsers.windows('Bot')
            : this.config.browser === 'appropriate' ? Browsers.appropriate('Bot')
              : (this.config.browser as [string, string, string])

    const make = (makeWASocket as unknown as { default?: typeof makeWASocket }).default ?? makeWASocket
    this.sock = make({
      version: this.version,
      logger: this.logger,
      auth: { creds: this.authState.state.creds, keys: makeCacheableSignalKeyStore(this.authState.state.keys, this.logger) },
      browser,
      msgRetryCounterCache: this.msgRetryCounterCache as unknown as undefined,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: this.config.markOnlineOnConnect ?? false,
      syncFullHistory: this.config.syncFullHistory ?? false,
      getMessage: async (key: WAMessageKey) => this.msgCache.get(cacheKey(key))?.message ?? undefined,
    }) as ReturnType<typeof makeWASocket>

    this.sock.ev.process(async (events) => {
      if (events['connection.update']) await this.onConnectionUpdate(events['connection.update'])
      if (events['creds.update']) await this.authState!.saveCreds()

      if (events['messages.upsert']) {
        const { messages, type } = events['messages.upsert']
        if (type === 'notify') {
          for (const message of messages) {
            this.rememberMessage(message)
            if (message.key?.fromMe) continue
            const jid = (message.key as { remoteJidAlt?: string })?.remoteJidAlt ?? message.key?.remoteJid ?? ''
            if (jid === 'status@broadcast') continue
            if ((this.config.ignoreBroadcasts ?? true) && jid.endsWith('@broadcast')) continue
            if ((this.config.ignoreNewsletters ?? true) && jid.endsWith('@newsletter')) continue
            // Seed identity from the authoritative mapping for bare-LID keys.
            await this.seedIdentity(message.key as WAMessageKey)
            this.fan({ kind: 'message', message: toInbound(message, this.identity) })
          }
        }
      }

      if (events['messages.update']) {
        for (const update of events['messages.update']) {
          if (update.update.pollUpdates) {
            const creation = this.msgCache.get(cacheKey(update.key))
            if (creation) {
              const votes = getAggregateVotesInPollMessage({ message: creation.message ?? undefined as unknown as proto.IMessage, pollUpdates: update.update.pollUpdates })
              this.fan({
                kind: 'poll-vote',
                vote: {
                  ref: { id: update.key.id ?? '', chatId: update.key.remoteJid ?? '', native: creation },
                  senderId: update.key.participant ?? update.key.remoteJid ?? '',
                  options: votes.map((v) => ({ name: v.name, votes: v.voters.length, voters: v.voters })),
                },
              })
            }
          }
        }
      }

      if (events['messages.reaction']) {
        for (const { key, reaction } of events['messages.reaction'] as Array<{ key: WAMessageKey; reaction: { text?: string; senderTimestampMs?: number } }>) {
          this.fan({
            kind: 'reaction',
            reaction: {
              ref: { id: key.id ?? '', chatId: key.remoteJid ?? '', native: key },
              emoji: reaction.text ?? '',
              senderId: key.participant ?? key.remoteJid ?? '',
              removed: !reaction.text,
            },
          })
        }
      }

      if (events['call']) {
        for (const call of events['call']) {
          // Same canonical caller id as their messages (LID/PN), never the raw `from`.
          await this.seedCaller(call)
          this.fan({ kind: 'call', event: toCallEvent(call, this.identity, this.callGroups) })
        }
      }

      if (events['group-participants.update']) {
        const e = events['group-participants.update']
        this.fan({
          kind: 'group',
          event: { chatId: e.id, action: e.action as 'add' | 'remove' | 'promote' | 'demote', participants: (e.participants ?? []) as unknown as string[], actor: (e as { author?: string }).author },
        })
      }

      if (events['presence.update']) {
        const p = events['presence.update']
        this.fan({ kind: 'presence', event: { chatId: p.id, presences: p.presences as Record<string, { lastKnownPresence?: string; lastSeen?: number }> } })
      }

      if (events['lid-mapping.update']) this.cacheLidMapping(events['lid-mapping.update'])
    })
  }

  private async seedIdentity(key: WAMessageKey): Promise<void> {
    const candidates = [key.remoteJid, key.participant]
    for (const jid of candidates) {
      if (!jid || !jid.endsWith('@lid') || this.identity.knowsPnFor(jid)) continue
      await this.getPNForLID(jid).catch(() => undefined)
    }
  }

  /** A bare-LID caller without `callerPn`: learn its PN from the authoritative mapping first. */
  private async seedCaller(call: WACallEvent): Promise<void> {
    if (call.callerPn || !call.from?.endsWith('@lid') || this.identity.knowsPnFor(call.from)) return
    await this.getPNForLID(normalize(call.from)).catch(() => undefined)
  }

  private mapReason(statusCode?: number): DisconnectReason {
    const action = classifyDisconnect(statusCode)
    return action === 'wipe' ? 'sessionInvalid'
      : action === 'stop' ? 'sessionTakenOver'
        : 'transient'
  }

  private async onConnectionUpdate(u: {
    connection?: string
    lastDisconnect?: { error?: unknown }
    qr?: string
    isNewLogin?: boolean
    isOnline?: boolean
  }): Promise<void> {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      this.fan({ kind: 'connection', update: { state: 'authenticating', authPayload: qr } })
      this.renderQr(qr)
      if (this.config.pairingCode && !this.authState?.state?.creds?.registered && !this.pairingCodeRequested && this.sock) {
        this.pairingCodeRequested = true
        try {
          const code = await this.sock.requestPairingCode(this.config.pairingCode.replace(/\D/g, ''))
          this.fan({ kind: 'connection', update: { state: 'authenticating', authPayload: code } })
        } catch (error) { this.logger.warn({ error }, 'pairing code request failed — falling back to QR') }
      }
    }

    if (connection === 'connecting') this.fan({ kind: 'connection', update: { state: 'connecting' } })

    if (connection === 'open') {
      this.reconnectAttempts = 0
      this.fan({ kind: 'connection', update: { state: 'ready' } })
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const message = (lastDisconnect?.error as Boom)?.message
      const reason = this.mapReason(statusCode)
      this.fan({ kind: 'connection', update: { state: 'closed', reason, detail: { code: statusCode, message } } })

      if (this.config.reconnect === false || this.isShuttingDown || this.reconnectPending) return
      const action = classifyDisconnect(statusCode)

      if (action === 'wipe') {
        this.logger.warn({ statusCode }, 'session invalid — wiping')
        try {
          removeSessionDirectory(this.config.sessionsDir, this.config.session)
        } catch (error) {
          this.logger.error({ err: error, statusCode }, 'refusing to wipe an unsafe session path')
          this.fan({ kind: 'connection', update: { state: 'closed', detail: new Error('unsafe session path') } })
          return
        }
        this.reconnectAttempts = 0
        this.scheduleReconnect(0)
        return
      }
      if (action === 'stop') {
        this.logger.warn({ statusCode }, 'not reconnecting: session taken over (conflict) or forbidden.')
        return
      }
      if (action === 'reconnect-now') { this.scheduleReconnect(0); return }
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.logger.error({ statusCode, attempts: this.reconnectAttempts }, `giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`)
        return
      }
      const delay = backoffDelay(this.reconnectAttempts)
      this.reconnectAttempts++
      this.logger.warn({ statusCode, attempt: this.reconnectAttempts, delayMs: delay }, 'connection closed — reconnecting with backoff')
      this.scheduleReconnect(delay)
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectPending || this.isShuttingDown) return
    this.reconnectPending = true
    setTimeout(() => {
      this.reconnectPending = false
      if (this.isShuttingDown) return
      void this.start().catch((error) => this.onReconnectStartFailed(error))
    }, delayMs)
  }

  /**
   * A `start()` invoked from a scheduled reconnect rejected BEFORE a socket was
   * built (e.g. `fetchLatestBaileysVersion()` hit a network blip, or the auth
   * state failed to load). No socket means no future `connection: 'close'` event
   * will ever fire to drive the retry — so if we merely logged here the provider
   * would stay dead permanently. We must reschedule the retry ourselves, with
   * backoff, until the cap is reached.
   */
  private onReconnectStartFailed(error: unknown): void {
    if (this.isShuttingDown) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        { error, attempts: this.reconnectAttempts },
        `giving up: start() failed ${MAX_RECONNECT_ATTEMPTS} times during reconnect`,
      )
      this.fan({ kind: 'connection', update: { state: 'closed', reason: 'transient', detail: { message: 'reconnect exhausted' } } })
      return
    }
    const delay = backoffDelay(this.reconnectAttempts)
    this.reconnectAttempts++
    this.logger.warn({ error, attempt: this.reconnectAttempts, delayMs: delay }, 'reconnect start() failed — retrying with backoff')
    this.scheduleReconnect(delay)
  }

  private renderQr(qr: string): void {
    const cfg = this.config.qr ?? { terminal: true, small: true }
    if (cfg.terminal) {
      import('qrcode-terminal').then((mod) => {
        const cjs = mod as unknown as { default?: typeof mod }
        const qrmod = cjs.default ?? mod
        qrmod.generate(qr, { small: cfg.small ?? true }, (output: string) => process.stdout.write(`${output}\n`))
      }).catch((err) => this.logger.warn({ err }, 'failed to render QR in terminal'))
    }
    if (cfg.file) {
      const file = typeof cfg.file === 'string' ? cfg.file : `${this.config.session ?? 'default'}.qr.png`
      void (async () => {
        try {
          const [{ image }, { createWriteStream }] = await Promise.all([import('qr-image'), import('fs')])
          // Hook error/finish on BOTH ends of the pipe so an async write failure
          // (bad path, no permission, disk full) is surfaced instead of crashing
          // the process with an unhandled 'error' event.
          await new Promise<void>((resolve, reject) => {
            const src = image(qr, { type: 'png' })
            const out = createWriteStream(file)
            src.on('error', reject)
            out.on('error', reject)
            out.on('finish', () => resolve())
            src.pipe(out)
          })
        } catch (err) { this.logger.warn({ err }, `failed to write QR image to ${file}`) }
      })()
    }
    if (cfg.handler) void cfg.handler(qr)
  }
}
