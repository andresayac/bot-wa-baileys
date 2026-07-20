/**
 * BaileysProvider — thin wrapper around makeWASocket.
 *
 * Responsibilities:
 *   - Manage the WhatsApp socket lifecycle (connect, display QR, reconnect).
 *   - Emit normalized events via the HookSystem.
 *   - Expose primitive senders (text, media, etc) used by MessageContext / Bot.
 *
 * It knows about flows, plugins, scheduler — nothing. Pure plumbing.
 */

import { EventEmitter } from 'events'
import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import makeWASocket, {
  Browsers,
  type BaileysEventMap,
  type proto,
  type WAMessage,
  type WAMessageKey,
  fetchLatestBaileysVersion,
  getAggregateVotesInPollMessage,
  getContentType,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import type { Logger } from 'pino'

import type { BotConfig, ConnectionUpdate, ConnectionState, IProvider } from '../core/types.js'
import { classifyDisconnect, backoffDelay, MAX_RECONNECT_ATTEMPTS } from './reconnect.js'
import { putBounded } from '../utils/boundedMap.js'

/** Max entries kept in `lidCache` — every resolved LID<->PN pair costs 2 (one per direction). */
const LID_CACHE_MAX = 2000

export interface ProviderEvents {
  connection: ConnectionUpdate
  pairingCode: string
  rawMessage: { message: WAMessage; type: 'notify' | 'append' }
  messageUpdate: { key: WAMessageKey; update: any }
  reaction: { key: WAMessageKey; reaction: number | string; from: string }
  pollVote: { key: WAMessageKey; votes: any[]; from: string }
  call: { id: string; from: string; status: string }
  groupParticipants: { id: string; action: 'add' | 'remove' | 'promote' | 'demote'; participants: string[]; author?: string }
  groupsUpsert: any[]
  groupsUpdate: any[]
  contactsUpsert: any[]
  contactsUpdate: any[]
  chatsUpsert: any[]
  chatsUpdate: any[]
  chatsDelete: string[]
  historySet: BaileysEventMap['messaging-history.set']
  credentialsUpdated: void
  presenceUpdate: { id: string; presences: Record<string, any> }
}

/**
 * Strongly-typed emitter — listeners get the right payload shape for free.
 */
export class TypedEmitter<TEvents extends Record<string, any>> extends EventEmitter {
  emitTyped<K extends keyof TEvents>(event: K, payload: TEvents[K]): boolean {
    return this.emit(String(event), payload)
  }
  onTyped<K extends keyof TEvents>(event: K, listener: (payload: TEvents[K]) => void | Promise<void>): this {
    return this.on(String(event), listener as (...args: any[]) => void)
  }
  offTyped<K extends keyof TEvents>(event: K, listener: (payload: TEvents[K]) => void | Promise<void>): this {
    return this.off(String(event), listener as (...args: any[]) => void)
  }
}

export class BaileysProvider extends TypedEmitter<ProviderEvents> implements IProvider {
  private sock: ReturnType<typeof makeWASocket> | null = null
  private msgRetryCounterCache = new NodeCache({ stdTTL: 0, useClones: false })
  private authState: Awaited<ReturnType<typeof useMultiFileAuthState>> | null = null
  private version: [number, number, number] = [0, 0, 0]
  private reconnectPending: boolean = false
  /** Consecutive backoff-reconnect attempts; reset to 0 on a successful 'open'. */
  private reconnectAttempts: number = 0
  private isShuttingDown: boolean = false
  /** True once a pairing code was requested for the current socket — QR refreshes every ~20s and must not re-request. */
  private pairingCodeRequested: boolean = false
  /** LID <-> PN cache — every resolved pair is stored under both keys. */
  private lidCache = new Map<string, string>()

  constructor(
    private config: BotConfig,
    private logger: Logger,
    /** Returns the original message for retries & poll decryption. */
    private getMessage: (key: WAMessageKey) => Promise<proto.IMessage | undefined>
  ) {
    super()
  }

  /** The current raw Baileys socket — undefined until connected. */
  get socket(): ReturnType<typeof makeWASocket> | null {
    return this.sock
  }

  get sessionDir(): string {
    return join(
      this.config.sessionsDir ?? './sessions',
      this.config.session ?? 'default'
    )
  }

  /** Start — open the socket and wait for `open` or first QR. */
  async start(): Promise<void> {
    // A fresh socket invalidates any previously issued pairing code, so allow one new request.
    this.pairingCodeRequested = false
    this.authState = await useMultiFileAuthState(this.sessionDir)
    const versionInfo = await fetchLatestBaileysVersion()
    this.version = versionInfo.version
    this.logger.debug({ version: this.version, latest: versionInfo.isLatest }, 'baileys version')
    await this.buildSocket()
  }

  /** Stop — close the socket cleanly. */
  async stop(): Promise<void> {
    this.reconnectPending = false
    this.isShuttingDown = true
    if (this.sock) {
      try {
        // Use logout for clean disconnect — avoids the "connection errored" log
        await this.sock.logout()
      } catch {
        try { this.sock.end(new Error('shutdown')) } catch { /* ignore */ }
      }
      this.sock = null
    }
  }

  /** Authenticate state for downstream consumers (cached key store). */
  get auth() {
    if (!this.authState) throw new Error('Provider not started')
    return this.authState
  }

  /** Send ephemeral media download — reupload expired media automatically. */
  async downloadMedia(message: WAMessage, format: 'buffer' | 'stream' = 'buffer') {
    if (!this.sock) throw new Error('Provider not connected')
    return downloadMediaMessage(message, format, {}, {
      logger: this.logger,
      reuploadRequest: this.sock.updateMediaMessage,
    })
  }

  /** Generic send — exposed to higher layers. Resolves LID → PN automatically. */
  async send(jid: string, content: any, options?: any): Promise<WAMessage> {
    if (!this.sock) throw new Error('Provider not connected')
    // Baileys 7: private chats arrive as @lid but sendMessage needs @s.whatsapp.net
    const resolvedJid = await this.resolveJid(jid)
    return (await this.sock.sendMessage(resolvedJid, content, options)) as WAMessage
  }

  /** Resolve a LID JID to a PN JID if needed for sending. */
  private async resolveJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid
    // If we can't resolve, send to the LID anyway (Baileys may handle it)
    return (await this.getPNForLID(jid)) ?? jid
  }

  /** PN for a LID — checks the local cache first, then the signal repository. */
  async getPNForLID(lid: string): Promise<string | undefined> {
    const cached = this.lidCache.get(lid)
    if (cached) return cached
    const pn = await this.sock?.signalRepository.lidMapping.getPNForLID(lid).catch(() => null)
    if (pn) this.cacheLid(lid, pn)
    return pn ?? undefined
  }

  /** LID for a PN — checks the local cache first, then the signal repository. */
  async getLIDForPN(pn: string): Promise<string | undefined> {
    const cached = this.lidCache.get(pn)
    if (cached) return cached
    const lid = await this.sock?.signalRepository.lidMapping.getLIDForPN(pn).catch(() => null)
    if (lid) this.cacheLid(pn, lid)
    return lid ?? undefined
  }

  /** Stores a LID<->PN pair under both keys, bounded to `LID_CACHE_MAX` entries (oldest evicted first). */
  private cacheLid(a: string, b: string): void {
    putBounded(this.lidCache, a, b, LID_CACHE_MAX)
  }

  /**
   * Cache a `lid-mapping.update` payload. The observed shape (Baileys 7.0.0-rc13)
   * is a single `{ lid, pn }` pair, but this is coded defensively in case a build
   * emits an array of pairs or a plain `{ [a]: b }` record instead.
   */
  private cacheLidMapping(update: unknown): void {
    if (!update || typeof update !== 'object') return
    const pairs = Array.isArray(update) ? update : [update]
    let sawPairShape = false
    for (const entry of pairs) {
      if (entry && typeof entry === 'object' && 'lid' in entry && 'pn' in entry) {
        sawPairShape = true
        const { lid, pn } = entry as { lid?: string; pn?: string }
        if (lid && pn) this.cacheLid(lid, pn)
      }
    }
    if (!sawPairShape && !Array.isArray(update)) {
      for (const [a, b] of Object.entries(update as Record<string, string>)) {
        this.cacheLid(a, b)
      }
    }
  }

  /** Read receipts — mark messages read. */
  async readMessages(keys: WAMessageKey[]): Promise<void> {
    await this.sock?.readMessages(keys)
  }

  /** Reject incoming call. */
  async rejectCall(id: string, from: string): Promise<void> {
    await this.sock?.rejectCall(id, from)
  }

  /** Group management passthrough. */
  groupMetadata(jid: string): Promise<any> {
    return this.sock!.groupMetadata(jid)
  }

  // ---------------------------------------------------------------------------

  private async buildSocket(): Promise<void> {
    if (!this.authState) throw new Error('auth state missing — call start() first')

    const browser: [string, string, string] =
      this.config.browser === undefined || this.config.browser === 'macOS'
        ? Browsers.macOS('Desktop')
        : this.config.browser === 'ubuntu'
          ? Browsers.ubuntu('Bot')
          : this.config.browser === 'windows'
            ? Browsers.windows('Bot')
            : this.config.browser === 'appropriate'
              ? Browsers.appropriate('Bot')
              : (this.config.browser as [string, string, string])

    const make = (makeWASocket as any).default ?? makeWASocket
    this.sock = make({
      version: this.version,
      logger: this.logger,
      auth: {
        creds: this.authState.state.creds,
        keys: makeCacheableSignalKeyStore(this.authState.state.keys, this.logger),
      },
      browser,
      msgRetryCounterCache: this.msgRetryCounterCache,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: this.config.markOnlineOnConnect ?? false,
      syncFullHistory: this.config.syncFullHistory ?? false,
      getMessage: this.getMessage,
    }) as ReturnType<typeof makeWASocket>

    this.sock.ev.process(async (events) => {
      /* Connection -------------------------------------------------------- */
      if (events['connection.update']) {
        const u = events['connection.update']
        await this.onConnectionUpdate(u)
      }

      /* Credentials ------------------------------------------------------- */
      if (events['creds.update']) {
        await this.authState!.saveCreds()
        this.emitTyped('credentialsUpdated', undefined as unknown as void)
      }

      /* Messages ---------------------------------------------------------- */
      if (events['messages.upsert']) {
        const { messages, type } = events['messages.upsert']
        for (const message of messages) {
          this.emitTyped('rawMessage', { message, type })
        }
      }

      if (events['messages.update']) {
        for (const update of events['messages.update']) {
          this.emitTyped('messageUpdate', { key: update.key, update: update.update })

          // Poll vote aggregation
          if (update.update.pollUpdates) {
            const creation = await this.getMessage(update.key)
            if (creation) {
              const votes = getAggregateVotesInPollMessage({
                message: creation,
                pollUpdates: update.update.pollUpdates,
              })
              this.emitTyped('pollVote', {
                key: update.key,
                votes,
                from: update.key.remoteJid ?? '',
              })
            }
          }
        }
      }

      if (events['messages.reaction']) {
        for (const { key, reaction } of events['messages.reaction'] as any) {
          this.emitTyped('reaction', {
            key,
            reaction: reaction as any,
            from: key.remoteJid ?? '',
          })
        }
      }

      /* Calls ------------------------------------------------------------- */
      if (events['call']) {
        for (const call of events['call']) {
          this.emitTyped('call', { id: call.id, from: call.from, status: call.status })
        }
      }

      /* Groups ------------------------------------------------------------ */
      if (events['groups.upsert']) {
        this.emitTyped('groupsUpsert', events['groups.upsert'])
      }
      if (events['groups.update']) {
        this.emitTyped('groupsUpdate', events['groups.update'])
      }
      if (events['group-participants.update']) {
        const e = events['group-participants.update'] as any
        this.emitTyped('groupParticipants', {
          id: e.id,
          action: e.action as 'add' | 'remove' | 'promote' | 'demote',
          participants: (e.participants ?? []) as string[],
          author: e.author,
        })
      }

      /* Chats ------------------------------------------------------------- */
      if (events['chats.upsert']) this.emitTyped('chatsUpsert', events['chats.upsert'])
      if (events['chats.update']) this.emitTyped('chatsUpdate', events['chats.update'])
      if (events['chats.delete']) this.emitTyped('chatsDelete', events['chats.delete'])

      /* Contacts ---------------------------------------------------------- */
      if (events['contacts.upsert']) this.emitTyped('contactsUpsert', events['contacts.upsert'])
      if (events['contacts.update']) this.emitTyped('contactsUpdate', events['contacts.update'])

      /* History ----------------------------------------------------------- */
      if (events['messaging-history.set']) {
        this.emitTyped('historySet', events['messaging-history.set'])
      }

      /* Presence ---------------------------------------------------------- */
      if (events['presence.update']) {
        this.emitTyped('presenceUpdate', events['presence.update'])
      }

      /* LID/PN identity ----------------------------------------------------- */
      if (events['lid-mapping.update']) {
        this.cacheLidMapping(events['lid-mapping.update'])
      }
    })
  }

  private async onConnectionUpdate(u: any): Promise<void> {
    const { connection, lastDisconnect, qr, isNewLogin, isOnline, receivedPendingNotifications } = u

    if (qr) {
      this.emitTyped('connection', {
        state: 'qr',
        qr,
        isNewLogin,
        isOnline,
      })

      // Pairing-code login (v1 parity): once a QR is available the socket is ready to
      // issue a pairing code. Requires `config.pairingCode` to be the phone number in
      // full international format (e.g. '+573001234567'); Baileys wants digits only.
      if (
        this.config.pairingCode &&
        !this.authState?.state?.creds?.registered &&
        !this.pairingCodeRequested &&
        this.sock
      ) {
        this.pairingCodeRequested = true
        try {
          const phone = this.config.pairingCode.replace(/\D/g, '')
          const code = await this.sock.requestPairingCode(phone)
          this.emitTyped('pairingCode', code)
        } catch (error) {
          this.logger.warn({ error }, 'pairing code request failed — falling back to QR')
        }
      }
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0 // successful connection resets the backoff
      this.emitTyped('connection', {
        state: 'open',
        isNewLogin,
        isOnline: isOnline ?? true,
      })
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const reason = (lastDisconnect?.error as Boom)?.message

      this.emitTyped('connection', {
        state: 'close',
        lastDisconnect: { statusCode, reason },
      })

      if (this.config.reconnect === false || this.isShuttingDown || this.reconnectPending) {
        return
      }

      const action = classifyDisconnect(statusCode)

      if (action === 'wipe') {
        // Session is invalid — wipe auth state and start fresh.
        this.logger.warn({ statusCode }, 'session invalid — wiping')
        try {
          rmSync(this.sessionDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
        this.reconnectAttempts = 0
        this.scheduleReconnect(0)
        return
      }

      if (action === 'stop') {
        // conflict/replaced (another device or instance owns this session) or
        // forbidden — reconnecting just fights the other client forever and
        // risks a ban. Stop and let the operator resolve it.
        this.logger.warn(
          { statusCode },
          'not reconnecting: session taken over by another client (conflict) or forbidden. ' +
            'Close the other WhatsApp Web/linked-device session or use a different `session` name.'
        )
        return
      }

      if (action === 'reconnect-now') {
        // restartRequired (515) — expected during pairing; reconnect promptly.
        this.scheduleReconnect(0)
        return
      }

      // reconnect-backoff — transient failure. Exponential backoff with a cap,
      // and give up after MAX_RECONNECT_ATTEMPTS consecutive failures.
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.logger.error(
          { statusCode, attempts: this.reconnectAttempts },
          `giving up after ${MAX_RECONNECT_ATTEMPTS} consecutive reconnect attempts`
        )
        return
      }
      const delay = backoffDelay(this.reconnectAttempts)
      this.reconnectAttempts++
      this.logger.warn(
        { statusCode, attempt: this.reconnectAttempts, delayMs: delay },
        'connection closed — reconnecting with backoff'
      )
      this.scheduleReconnect(delay)
    }

    if (connection === 'connecting') {
      this.emitTyped('connection', { state: 'connecting' })
    }
  }

  /** Schedule a single reconnect after `delayMs`, guarded against overlap and shutdown. */
  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectPending || this.isShuttingDown) return
    this.reconnectPending = true
    setTimeout(() => {
      this.reconnectPending = false
      if (this.isShuttingDown) return
      void this.start().catch((error) =>
        this.logger.error({ error }, 'reconnect attempt failed')
      )
    }, delayMs)
  }
}
