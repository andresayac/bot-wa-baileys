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
  type BaileysEventMap,
  type GroupParticipant,
  type WAMessage,
  type WAMessageKey,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  toNumber,
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
import { resolveBrowser, type BrowserConfig } from './browser.js'
import { IdentityStore, canonicalKey, type IdentityKey } from './identity.js'
import { normalize, isLidUser, isPnUser } from './jid.js'
import {
  PollTracker, POLL_CACHE_MAX, decryptVote, fromStoredPoll, pollCreationOf, pollUpdateOf, recordVote, tally, toStoredPoll,
  type PollStore, type TrackedPoll,
} from './polls.js'
import { toInbound } from './toInbound.js'
import { toCallEvent } from './toCallEvent.js'
import { toOutbound } from './toOutbound.js'
import { RateLimiter, type RateLimitConfig } from './RateLimiter.js'
import {
  assertSessionDirectorySafe,
  removeSessionDirectory,
  resolveSessionDirectory,
} from './sessionPath.js'

const LID_CACHE_MAX = 2000
const MSG_CACHE_MAX = 2000
/** LID lookups per message for mentioned users (the quoted author is always looked up). */
const MAX_MENTION_LOOKUPS = 64

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
  /**
   * Browser identity advertised in the WhatsApp Web handshake. Leave it unset
   * (recommended): Baileys >= 7.0.0-rc14 then uses its own default,
   * `Browsers.macOS('Chrome')`. A preset advertises Chrome on that OS. A custom
   * `[os, browserName, osVersion]` tuple is passed through verbatim and logged
   * as a warning: since late July 2026 WhatsApp closes non-standard clients
   * with 428 "Connection Terminated" before the QR.
   */
  browser?: BrowserConfig
  markOnlineOnConnect?: boolean
  syncFullHistory?: boolean
  ignoreNewsletters?: boolean
  ignoreBroadcasts?: boolean
  reconnect?: boolean
  qr?: QrConfig
  /** Phone number (international format) for pairing-code login instead of QR. */
  pairingCode?: string
  /**
   * Persistence for polls, so votes cast after a restart can still be
   * decrypted and tallied (vote decryption needs each poll's secret). Without
   * it, only polls seen by the running process are known (a bounded in-memory
   * cache of {@link POLL_CACHE_MAX} polls). See {@link PollStore}.
   */
  pollStore?: PollStore
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
    streaming: 'none', // no live preview: ctx.stream() sends sentence chunks with typing
    forms: 'degraded', // flow().form() asks field by field
    textFormat: 'whatsapp', // WhatsApp markup: *bold* _italic_ ~strike~
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
  /** Polls seen by this process (sent or received), so their votes can be decrypted. */
  private polls = new PollTracker(POLL_CACHE_MAX)
  /** One pending {@link PollStore} read per poll id, shared by concurrent votes. */
  private pollLoads = new Map<string, Promise<TrackedPoll | undefined>>()
  /** Tail of each poll's save chain, so writes reach the store in order. */
  private pollSaves = new Map<string, Promise<void>>()
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
    if (Array.isArray(config.browser)) {
      this.logger.warn(
        { browser: config.browser },
        'custom browser tuple overrides the Baileys default (macOS Chrome) handshake; WhatsApp may close the connection with 428 before the QR',
      )
    }
  }

  get connection(): unknown | null { return this.sock }
  /**
   * The bot's canonical id: its normalised PN (`creds.me.id` without the device
   * suffix), the same id its own reactions and votes carry. Core matches
   * `groupMode: 'mentions'` against it, and mentions are canonical too.
   */
  get selfId(): UserId | null {
    return this.self().id || null
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
    // Never throws: on a network/parse failure Baileys falls back to the WA Web
    // version bundled with the installed release (isLatest: false, error set).
    const versionInfo = await fetchLatestBaileysVersion()
    this.version = versionInfo.version
    this.logger.debug({ version: this.version, latest: versionInfo.isLatest, err: versionInfo.error }, 'baileys version')
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
    // Everything below rejects through mapSendError, so send() only ever rejects
    // with ProviderError subclasses (rate-limiter timeouts and resets included).
    try {
      const waContent = await toOutbound(content)
      const waOptions: Record<string, unknown> = {}
      if (options?.quoted?.native) waOptions.quoted = options.quoted.native
      const resolvedJid = await this.resolveJid(chatId)
      await this.rateLimiter.acquire(chatId)
      if (!this.sock) throw new ProviderError('Provider not connected')
      const sent = (await this.sock.sendMessage(resolvedJid, waContent, waOptions)) as WAMessage
      // Serve retry requests (getMessage) and decrypt votes on polls we send.
      if (sent?.key) { this.rememberMessage(sent); await this.rememberPoll(sent) }
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

  /**
   * Resolve a LID to its phone-number JID, or `undefined` when no mapping is
   * known (e.g. a username-only contact). The mapping store answers with a
   * device-qualified JID (`<user>:<device>@s.whatsapp.net`); it is normalised to
   * the user JID so the cache, the identity store and outbound sends agree.
   */
  async getPNForLID(lid: string): Promise<string | undefined> {
    const cached = this.lidCache.get(lid)
    if (cached) return cached
    const raw = await this.sock?.signalRepository.lidMapping.getPNForLID(lid).catch(() => null)
    const pn = raw ? normalize(raw) : undefined
    if (pn) { this.cacheLid(lid, pn); this.identity.observe(lid, pn) }
    return pn
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
    // Omit the key entirely when unset: makeWASocket spreads our config over its
    // defaults, so `browser: undefined` would erase rc14's default identity.
    const browser = resolveBrowser(this.config.browser)

    const make = (makeWASocket as unknown as { default?: typeof makeWASocket }).default ?? makeWASocket
    this.sock = make({
      version: this.version,
      logger: this.logger,
      auth: { creds: this.authState.state.creds, keys: makeCacheableSignalKeyStore(this.authState.state.keys, this.logger) },
      ...(browser ? { browser } : {}),
      msgRetryCounterCache: this.msgRetryCounterCache as unknown as undefined,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: this.config.markOnlineOnConnect ?? false,
      syncFullHistory: this.config.syncFullHistory ?? false,
      getMessage: async (key: WAMessageKey) => this.msgCache.get(cacheKey(key))?.message ?? undefined,
    }) as ReturnType<typeof makeWASocket>

    this.sock.ev.process(async (events) => this.handleEvents(events))
  }

  /**
   * Translate one batch of Baileys events. Every user/chat id emitted here goes
   * through the same LID/PN canonicalisation as messages ({@link canonicalKey} /
   * {@link IdentityStore.resolve}), whatever the event kind.
   */
  private async handleEvents(events: Partial<BaileysEventMap>): Promise<void> {
    if (events['connection.update']) await this.onConnectionUpdate(events['connection.update'])
    if (events['creds.update']) await this.authState!.saveCreds()
    // Learn new LID↔PN pairs first so the rest of the batch canonicalises with them.
    if (events['lid-mapping.update']) this.cacheLidMapping(events['lid-mapping.update'])

    if (events['messages.upsert']) await this.onMessagesUpsert(events['messages.upsert'])
    // Baileys 7 never fills `messages.update[].update.pollUpdates` (its vote
    // decryption is commented out); votes are decrypted from the upsert instead.
    if (events['messages.reaction']) await this.onReactions(events['messages.reaction'])
    if (events['call']) await this.onCalls(events['call'])
    if (events['group-participants.update']) await this.onGroupParticipants(events['group-participants.update'])
    if (events['presence.update']) await this.onPresence(events['presence.update'])
  }

  private acceptsChat(jid: string): boolean {
    if (jid === 'status@broadcast') return false
    if ((this.config.ignoreBroadcasts ?? true) && jid.endsWith('@broadcast')) return false
    if ((this.config.ignoreNewsletters ?? true) && jid.endsWith('@newsletter')) return false
    return true
  }

  private async onMessagesUpsert({ messages, type }: BaileysEventMap['messages.upsert']): Promise<void> {
    // Learn the bot's own LID↔PN pair so mentions of its LID canonicalise to selfId.
    this.self()
    for (const message of messages) {
      const jid = message.key?.remoteJidAlt ?? message.key?.remoteJid ?? ''
      const accepted = this.acceptsChat(jid)
      // Cache upserts, `append` included (Baileys emits the bot's own sends and
      // offline deliveries as `append`): getMessage() retries and poll vote
      // decryption both need them. Only messages from chats the bot listens to,
      // plus its own wherever they are, take a slot in these bounded caches, so
      // a flood from ignored chats (status, broadcasts, newsletters) cannot
      // evict the ones that matter.
      if (accepted || message.key?.fromMe) {
        this.rememberMessage(message)
        await this.rememberPoll(message)
      }
      if (!accepted) continue
      // An encrypted vote is a poll-vote event, never a message.
      if (pollUpdateOf(message)) { await this.onPollVote(message); continue }
      if (type !== 'notify' || message.key?.fromMe) continue
      // Seed identity from the authoritative mapping for bare-LID keys.
      await this.seedIdentity(message.key)
      await this.seedQuotedIdentity(message)
      this.fan({ kind: 'message', message: toInbound(message, this.identity) })
    }
  }

  private async onPollVote(message: WAMessage): Promise<void> {
    const update = pollUpdateOf(message)
    const creationKey = update?.pollCreationMessageKey
    const pollId = creationKey?.id ?? undefined
    const poll = update && pollId ? this.polls.get(pollId) ?? await this.loadPoll(pollId) : undefined
    if (!update || !creationKey || !poll) {
      // Typically a poll sent before a restart (no pollStore), or evicted from the bounded cache.
      this.logger.debug({ pollId }, 'poll vote for a poll this process has not seen; cannot decrypt it')
      return
    }

    const key = message.key
    const pollKey = poll.message.key as IdentityKey
    for (const k of [key, pollKey, creationKey]) await this.seedIdentity(k)
    const self = this.self()
    const { chatId, senderId, isGroup, rawParticipant } = canonicalKey(key, this.identity, message.participant)

    // The vote names its poll by id only, its key derivation does not cover the
    // chat, and every member knows a poll's id and secret. Bind it to the
    // tracked poll's own key: Baileys rewrites the creation key's remoteJid to
    // the vote's chat, so that key cannot vouch for the chat.
    if (!this.overlaps(this.jidCandidates(pollKey.remoteJid, pollKey.remoteJidAlt), this.jidCandidates(key.remoteJid, key.remoteJidAlt))) {
      this.logger.debug({ pollId }, 'poll vote from another chat than its poll; dropped')
      return
    }
    const creators = this.creatorForms(pollKey)
    const claimed = this.creatorForms(creationKey)
    if (!this.overlaps(creators, claimed)) {
      // Another poll reusing the id (ids are chosen by the sending client).
      this.logger.debug({ pollId }, 'poll vote names another creator than its poll; dropped')
      return
    }
    if (key.id && this.polls.hasVote(poll, key.id)) {
      this.logger.debug({ pollId }, 'poll vote already counted (redelivered); dropped')
      return
    }

    const voters = key.fromMe
      ? self.jids
      : isGroup
        ? this.jidCandidates(rawParticipant, key.participantAlt)
        : this.jidCandidates(key.remoteJid, key.remoteJidAlt)
    // Same person, so the creation key's forms are safe extra candidates.
    const decrypted = decryptVote(update.vote, poll, [...new Set([...creators, ...claimed])], voters)
    if (!decrypted) {
      this.logger.warn({ pollId }, 'failed to decrypt poll vote')
      return
    }

    const voterId = key.fromMe ? self.id : senderId
    const at = toNumber(update.senderTimestampMs) || toNumber(message.messageTimestamp) * 1000 || Date.now()
    if (!recordVote(poll, voterId, decrypted.hashes, at, (id) => this.identity.canonical(id))) return
    if (key.id) this.polls.markVote(poll, key.id)
    this.polls.touch(poll)
    await this.savePoll(poll)
    this.fan({
      kind: 'poll-vote',
      vote: { ref: { id: poll.id, chatId, native: poll.message }, senderId: voterId, options: tally(poll) },
    })
  }

  /* Poll cache + optional persistence ----------------------------------- */

  /**
   * Track a poll creation message so its votes can be decrypted, persisting it
   * when a {@link PollStore} is configured. A poll id already in the store keeps
   * the stored poll: like the in-memory cache, a later poll reusing an id (ids
   * are chosen by the sending client) never replaces the first one.
   */
  private async rememberPoll(message: WAMessage): Promise<void> {
    const id = message.key?.id
    if (!id || this.polls.get(id) || !pollCreationOf(message)?.secret?.length) return
    const store = this.config.pollStore
    if (!store) { this.polls.remember(message); return }
    let stored: TrackedPoll | undefined
    try {
      stored = await this.loadPoll(id, true)
    } catch {
      // The store is unreachable: track in memory only, never overwrite blindly.
      this.polls.remember(message)
      return
    }
    if (stored) return
    const tracked = this.polls.track(message)
    if (tracked?.isNew) await this.savePoll(tracked.poll)
  }

  /**
   * Load a poll from the {@link PollStore} into the in-memory cache. A
   * malformed entry is deleted. Store failures are logged and read as a miss,
   * unless `rethrow` is set.
   */
  private async loadPoll(id: string, rethrow = false): Promise<TrackedPoll | undefined> {
    if (!this.config.pollStore) return undefined
    // Concurrent votes (separate upsert batches run in parallel) share one read,
    // so they all record on the same object and no vote is lost.
    let pending = this.pollLoads.get(id)
    if (!pending) {
      pending = this.readPoll(id).finally(() => this.pollLoads.delete(id))
      this.pollLoads.set(id, pending)
    }
    try {
      return await pending
    } catch (err) {
      if (rethrow) throw err
      return undefined
    }
  }

  private async readPoll(id: string): Promise<TrackedPoll | undefined> {
    const store = this.config.pollStore!
    let raw: unknown
    try {
      raw = await store.get(id)
    } catch (err) {
      this.logger.warn({ err, pollId: id }, 'poll store get failed')
      throw err
    }
    // A poll tracked while the read was pending (e.g. its own send) wins.
    const cached = this.polls.get(id)
    if (cached) return cached
    if (raw === undefined || raw === null) return undefined
    const poll = fromStoredPoll(id, raw)
    if (!poll) {
      this.logger.warn({ pollId: id }, 'poll store entry is malformed; deleting it')
      await store.delete(id).catch((err: unknown) => this.logger.warn({ err, pollId: id }, 'poll store delete failed'))
      return undefined
    }
    this.polls.adopt(poll)
    return poll
  }

  /**
   * Persist a poll (creation or new tally). Saves of one poll run one after
   * another and each serialises the poll when it runs, so the last write always
   * holds the latest tally. Failures are logged, never thrown.
   */
  private async savePoll(poll: TrackedPoll): Promise<void> {
    const store = this.config.pollStore
    if (!store) return
    const write = async (): Promise<void> => {
      try {
        await store.set(poll.id, toStoredPoll(poll))
      } catch (err) {
        this.logger.warn({ err, pollId: poll.id }, 'poll store set failed')
      }
    }
    const next = (this.pollSaves.get(poll.id) ?? Promise.resolve()).then(write)
    this.pollSaves.set(poll.id, next)
    try {
      await next
    } finally {
      if (this.pollSaves.get(poll.id) === next) this.pollSaves.delete(poll.id)
    }
  }

  private async onReactions(reactions: BaileysEventMap['messages.reaction']): Promise<void> {
    for (const { key, reaction } of reactions) {
      // `key` is the REACTED-TO message; `reaction.key` is the reactor's own key.
      const reactorKey = reaction.key ?? undefined
      if (reactorKey) await this.seedIdentity(reactorKey)
      const { chatId, senderId } = canonicalKey(reactorKey ?? { remoteJid: key.remoteJid }, this.identity)
      this.fan({
        kind: 'reaction',
        reaction: {
          ref: { id: key.id ?? '', chatId, native: key },
          emoji: reaction.text ?? '',
          senderId: reactorKey?.fromMe ? this.self().id : senderId,
          removed: !reaction.text,
        },
      })
    }
  }

  private async onCalls(calls: BaileysEventMap['call']): Promise<void> {
    for (const call of calls) {
      const from = await this.canonicalId(call.from, call.callerPn)
      const groupId = call.groupJid ? await this.canonicalId(call.groupJid) : undefined
      this.fan({ kind: 'call', event: toCallEvent(call, from, groupId, this.callGroups) })
    }
  }

  private async onGroupParticipants(e: BaileysEventMap['group-participants.update']): Promise<void> {
    const participants: UserId[] = []
    // Baileys 7 sends participant objects ({ id, phoneNumber?, lid? }); accept bare JIDs too.
    for (const p of (e.participants ?? []) as Array<GroupParticipant | string>) {
      const id = typeof p === 'string'
        ? await this.canonicalId(p)
        : await this.canonicalId(p?.id, p?.phoneNumber ?? p?.lid)
      if (id) participants.push(id)
    }
    const actor = e.author || e.authorPn ? await this.canonicalId(e.author, e.authorPn) : ''
    this.fan({
      kind: 'group',
      event: {
        chatId: await this.canonicalId(e.id),
        action: e.action === 'modify' ? 'update' : e.action,
        participants,
        actor: actor || undefined,
      },
    })
  }

  private async onPresence(p: BaileysEventMap['presence.update']): Promise<void> {
    const presences: Record<UserId, { lastKnownPresence?: string; lastSeen?: number }> = {}
    for (const [jid, presence] of Object.entries(p.presences ?? {})) {
      presences[await this.canonicalId(jid)] = presence
    }
    this.fan({ kind: 'presence', event: { chatId: await this.canonicalId(p.id), presences } })
  }

  /* Identity helpers for events ------------------------------------------ */

  private async seedIdentity(key: IdentityKey): Promise<void> {
    const candidates = [key.remoteJid, key.participant]
    for (const jid of candidates) {
      if (!jid || !jid.endsWith('@lid') || this.identity.knowsPnFor(jid)) continue
      await this.getPNForLID(jid).catch(() => undefined)
    }
  }

  /**
   * Look up the PN of bare-LID users a message quotes or mentions, so
   * `quoted.senderId` and `mentions` canonicalise like the sender does.
   */
  private async seedQuotedIdentity(message: WAMessage): Promise<void> {
    const ctx = message.message?.extendedTextMessage?.contextInfo
    if (!ctx) return
    // Bounded: a mention-everyone message can name hundreds of members.
    const jids = [ctx.participant, ...(ctx.mentionedJid ?? []).slice(0, MAX_MENTION_LOOKUPS)]
    for (const jid of jids) {
      const lid = jid ? normalize(jid) : ''
      if (!isLidUser(lid) || this.identity.knowsPnFor(lid)) continue
      await this.getPNForLID(lid).catch(() => undefined)
    }
  }

  /**
   * Canonical id for a bare JID from a non-message event. `alt` is the twin the
   * event carries (PN or LID); without a PN twin, a LID is first looked up in
   * the signal mapping store, as for message keys.
   */
  private async canonicalId(jid?: string | null, alt?: string | null): Promise<string> {
    const lid = jid ? normalize(jid) : ''
    if (isLidUser(lid) && !(alt && isPnUser(alt)) && !this.identity.knowsPnFor(lid)) {
      await this.getPNForLID(lid).catch(() => undefined)
    }
    return this.identity.resolve(jid, alt)
  }

  /** The bot's own canonical id and the JID forms (LID, PN) it signs with. */
  private self(): { id: UserId; jids: string[] } {
    const me = this.authState?.state?.creds?.me
    const pn = me?.id ? normalize(me.id) : ''
    const lid = me?.lid ? normalize(me.lid) : ''
    if (pn && lid) this.identity.observe(lid, pn)
    return { id: pn || lid, jids: [lid, pn].filter(Boolean) }
  }

  /** Normalised JIDs plus their learned twins, deduplicated, in order. */
  private jidCandidates(...jids: Array<string | null | undefined>): string[] {
    const out = new Set<string>()
    for (const jid of jids) {
      const n = jid ? normalize(jid) : ''
      if (!n) continue
      out.add(n)
      const twin = this.identity.alias(n)
      if (twin) out.add(twin)
    }
    return [...out]
  }

  /**
   * The JID forms of a poll's creator per a message key: the bot (both forms)
   * for its own polls, otherwise the group participant or the DM partner, with
   * learned twins. Works for the poll's own key and for a vote's
   * `pollCreationMessageKey` (which Baileys rewrites to our perspective:
   * `fromMe` when the bot created it, the voter as participant when unset).
   */
  private creatorForms(key: IdentityKey): string[] {
    if (key.fromMe) return this.self().jids
    return (key.remoteJid ?? '').endsWith('@g.us')
      ? this.jidCandidates(key.participant, key.participantAlt)
      : this.jidCandidates(key.remoteJid, key.remoteJidAlt)
  }

  /** Whether two JID-form lists name the same user or chat. */
  private overlaps(a: string[], b: string[]): boolean {
    return a.some((jid) => b.includes(jid))
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
        } catch (error) { this.logger.warn({ err: error }, 'pairing code request failed — falling back to QR') }
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
        this.logger.warn({ statusCode, detail: message }, 'session invalid — wiping')
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
        this.logger.warn({ statusCode, detail: message }, 'not reconnecting: session taken over (conflict) or forbidden.')
        return
      }
      if (action === 'reconnect-now') { this.scheduleReconnect(0); return }
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.logger.error({ statusCode, detail: message, attempts: this.reconnectAttempts }, `giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`)
        return
      }
      const delay = backoffDelay(this.reconnectAttempts)
      this.reconnectAttempts++
      this.logger.warn({ statusCode, detail: message, attempt: this.reconnectAttempts, delayMs: delay }, 'connection closed — reconnecting with backoff')
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
        { err: error, attempts: this.reconnectAttempts },
        `giving up: start() failed ${MAX_RECONNECT_ATTEMPTS} times during reconnect`,
      )
      this.fan({ kind: 'connection', update: { state: 'closed', reason: 'transient', detail: { message: 'reconnect exhausted' } } })
      return
    }
    const delay = backoffDelay(this.reconnectAttempts)
    this.reconnectAttempts++
    this.logger.warn({ err: error, attempt: this.reconnectAttempts, delayMs: delay }, 'reconnect start() failed — retrying with backoff')
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
