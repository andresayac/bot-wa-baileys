/**
 * MockProvider — an in-memory {@link IProvider} v2 for tests. No sockets, no
 * transport. `incoming()` emits a normalized message event; `incomingMedia()` a
 * media message whose bytes `downloadMedia()` returns; `interaction()` an
 * interaction event; `reaction()` a reaction; `outbox` records everything sent
 * and `journal` keeps inbound traffic and sends in order (for transcripts).
 */

import type {
  CallEvent,
  ChatId,
  DraftOptions,
  IProvider,
  MessageRef,
  StreamingMode,
  TextFormat,
  InboundEvent,
  InboundInteraction,
  InboundLocation,
  InboundMessage,
  MessageType,
  OutboundContent,
  ProviderCapabilities,
  SendOptions,
  SendResult,
  MediaRef,
  UserId,
} from '../core/provider.js'
import { MediaUnavailableError } from '../core/mediaRefs.js'

let counter = 0

const MEDIA_TYPES: MessageType[] = ['image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact']

/** Default `mimetype` of a simulated media, per kind. */
const DEFAULT_MIMETYPES: Partial<Record<MediaRef['kind'], string>> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  voice: 'audio/ogg',
  document: 'application/octet-stream',
  sticker: 'image/webp',
}

/** Default journal cap ({@link MockProviderOptions.maxJournal}). */
const DEFAULT_MAX_JOURNAL = 10_000

export interface MockOutgoing {
  chatId: ChatId
  content: OutboundContent
  options?: SendOptions
}

/** Bytes or URL behind a simulated inbound media (the `MediaRef.token` the mock builds). */
export interface MockMediaToken {
  /** What {@link MockProvider.downloadMedia} returns (a copy). Absent: the download rejects. */
  bytes?: Buffer | Uint8Array
  /** Metadata only — the mock never fetches it. */
  url?: string
}

/** Source of a simulated inbound media: the bytes, or a URL with optional bytes. */
export type MockMediaSource = Buffer | Uint8Array | { url: string; bytes?: Buffer | Uint8Array }

/** Media fields of {@link MockProvider.incomingMedia}. */
export interface MockMediaOptions {
  /** Message body (`ctx.body`), as real providers set it. Default `''`. */
  caption?: string
  /** Default: a common type for the kind (`image/jpeg`, `audio/ogg`, ...). */
  mimetype?: string
  filename?: string
  /** Default: the byte length of the source, when bytes were given. */
  size?: number
}

/** Options of {@link MockProvider.incoming} / {@link MockProvider.interaction}. */
export interface MockIncomingOptions {
  from?: ChatId
  sender?: string
  isGroup?: boolean
  type?: MessageType
  id?: string
  pushName?: string
  mentions?: string[]
  /** Provider-reported sender language (`SenderInfo.language`). */
  language?: string
  /** Transport extras on `SenderInfo.platformData` (e.g. `{ languageCode: 'en' }`). */
  platformData?: Record<string, unknown>
  /** Shared location (`InboundMessage.location`); implies `type: 'location'` unless `type` is given. */
  location?: InboundLocation
  /** Override fields of the auto-built `MediaRef` of a media `type` (`token`, `mimetype`, `filename`, `size`). */
  media?: Partial<Omit<MediaRef, 'kind'>>
  /** Interaction kind for {@link MockProvider.interaction} (default `'button'`; `'list'` for list rows). */
  kind?: InboundInteraction['kind']
}

/** One entry of {@link MockProvider.journal}: what the "user" did or what the bot sent, in order. */
export type MockJournalEntry =
  | { dir: 'in'; seq: number; at: number; event: Extract<InboundEvent, { kind: 'message' | 'interaction' }> }
  | { dir: 'out'; seq: number; at: number; chatId: ChatId; content: OutboundContent; options?: SendOptions; ref: MessageRef }

/** Options of {@link MockProvider}. */
export interface MockProviderOptions {
  /**
   * Streaming mode to simulate (`capabilities.streaming`). `'edit'` also exposes
   * `editMessage` (recorded in `edits`); `'draft'` exposes `sendDraft` (recorded in
   * `drafts`) and `editMessage`. Default `'none'` (no edit, no drafts).
   */
  streaming?: StreamingMode
  /** `capabilities.maxTextLength` to simulate. Default: unset. */
  maxTextLength?: number
  /** `capabilities.textFormat` to simulate (e.g. `'whatsapp'`). Default: unset. */
  textFormat?: TextFormat
  /**
   * Native buttons to simulate (`capabilities.buttons` and the `'buttons'` content
   * kind). `false` simulates a channel without them (Baileys, SMS…). Default `true`.
   */
  buttons?: boolean
  /**
   * Per-chat text format to simulate (`IProvider.textFormatFor`), e.g. a provider that
   * serves WhatsApp and SMS chats. Default: unset (the mock has no `textFormatFor`).
   */
  textFormatFor?: (chatId: ChatId) => TextFormat | undefined
  /**
   * Which optional seams the mock exposes. A disabled seam is hidden (the instance
   * property reads `undefined`), so the bot treats it exactly like a provider that
   * lacks the method. Defaults follow `streaming`: `edit` and `delete` when it is not
   * `'none'`, `drafts` when it is `'draft'`. When left unset, a subclass's own
   * override of the method is never hidden; an explicit `false` hides it too.
   */
  supports?: MockProviderSupports
  /**
   * `capabilities.exclusiveSession` to simulate: a transport that allows one live
   * connection (Baileys). Multi-replica coordination then starts the mock on the elected
   * replica only. Default: unset.
   */
  exclusiveSession?: boolean
  /**
   * Cap of {@link MockProvider.journal}; the oldest entries are dropped first (default
   * `10000`, `Infinity` disables the cap). `outbox` is never capped.
   */
  maxJournal?: number
}

/** {@link MockProviderOptions.supports}. */
export interface MockProviderSupports {
  /** `editMessage` (recorded in `edits`); also sets `capabilities.edit` unless given. */
  edit?: boolean
  /** `deleteMessage` (recorded in `deleted`). */
  delete?: boolean
  /** `sendDraft` (recorded in `drafts`). */
  drafts?: boolean
}

/** One recorded {@link MockProvider.editMessage} call. */
export interface MockEdit {
  ref: MessageRef
  content: OutboundContent
}

/** One recorded {@link MockProvider.sendDraft} call. */
export interface MockDraft {
  chatId: ChatId
  draftId: number
  text: string
  opts?: DraftOptions
}

export class MockProvider implements IProvider {
  readonly id = 'mock'
  readonly capabilities: ProviderCapabilities
  selfId: string | null = null

  outbox: MockOutgoing[] = []
  /**
   * Chronological journal of inbound messages/interactions (as emitted, before any chaos
   * wrapper) and of every `send` with the `ref` it returned. Bounded by `maxJournal`.
   */
  journal: MockJournalEntry[] = []
  /** Edits recorded by {@link editMessage} (enabled by `streaming` `'edit'`/`'draft'` or `supports.edit`). */
  edits: MockEdit[] = []
  /** Draft previews recorded by {@link sendDraft} (enabled by `streaming: 'draft'` or `supports.drafts`). */
  drafts: MockDraft[] = []
  /** Messages deleted through {@link deleteMessage} (enabled by `streaming` not `'none'` or `supports.delete`). */
  deleted: MessageRef[] = []
  /** Interaction acks recorded by {@link acknowledgeInteraction}, in order. */
  acks: Array<{ interactionId: string; opts?: { text?: string; defer?: boolean } }> = []
  /** Per-chat text format — present only when {@link MockProviderOptions.textFormatFor} is given. */
  declare textFormatFor?: (chatId: ChatId) => TextFormat | undefined
  /** Journal cap ({@link MockProviderOptions.maxJournal}). */
  readonly maxJournal: number
  private journalSeq = 0

  constructor(options: MockProviderOptions = {}) {
    const streaming = options.streaming ?? 'none'
    const supports = options.supports ?? {}
    const edit = supports.edit ?? streaming !== 'none'
    const buttons = options.buttons ?? true
    const maxJournal = options.maxJournal ?? DEFAULT_MAX_JOURNAL
    if (!(maxJournal >= 1)) throw new RangeError('maxJournal must be >= 1')
    this.maxJournal = maxJournal
    const kinds: Array<OutboundContent['kind']> = ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll', 'buttons', 'list', 'reaction']
    this.capabilities = {
      contentKinds: buttons ? kinds : kinds.filter((k) => k !== 'buttons'),
      buttons, lists: true, polls: true, reactions: true, edit,
      typing: true, presence: true, readReceipts: true, groups: true, templates: false,
      interactionsRequireAck: false, pushIngress: false,
      streaming,
      forms: 'degraded',
      ...(options.maxTextLength !== undefined ? { maxTextLength: options.maxTextLength } : {}),
      ...(options.textFormat !== undefined ? { textFormat: options.textFormat } : {}),
      ...(options.exclusiveSession !== undefined ? { exclusiveSession: options.exclusiveSession } : {}),
    }
    if (options.textFormatFor) this.textFormatFor = options.textFormatFor
    hideSeam(this, 'editMessage', supports.edit, edit)
    hideSeam(this, 'deleteMessage', supports.delete, supports.delete ?? streaming !== 'none')
    hideSeam(this, 'sendDraft', supports.drafts, supports.drafts ?? streaming === 'draft')
  }

  /** Records the edit in {@link edits}. Hidden (`undefined`) unless enabled — see {@link MockProviderOptions.supports}. */
  async editMessage(ref: MessageRef, content: OutboundContent): Promise<SendResult> {
    this.edits.push({ ref, content })
    return { ref }
  }

  /** Records the ack in {@link acks} (button/callback interactions). */
  async acknowledgeInteraction(interactionId: string, opts?: { text?: string; defer?: boolean }): Promise<void> {
    this.acks.push(opts === undefined ? { interactionId } : { interactionId, opts })
  }

  /** Records the ref in {@link deleted}. Hidden (`undefined`) unless enabled — see {@link MockProviderOptions.supports}. */
  async deleteMessage(ref: MessageRef): Promise<void> {
    this.deleted.push(ref)
  }

  /** Records the draft in {@link drafts}. Hidden (`undefined`) unless enabled — see {@link MockProviderOptions.supports}. */
  async sendDraft(chatId: ChatId, draftId: number, text: string, opts?: DraftOptions): Promise<void> {
    this.drafts.push({ chatId, draftId, text, opts })
  }

  /** Simulate the user pressing "stop" on the latest draft that offered it. */
  stopDraft(): boolean {
    for (let i = this.drafts.length - 1; i >= 0; i--) {
      const stop = this.drafts[i].opts?.onStop
      if (stop) { stop(); return true }
    }
    return false
  }
  private listeners = new Set<(e: InboundEvent) => void | Promise<void>>()

  /** `start()` calls so far. */
  starts = 0
  /** `stop()` calls so far. */
  stops = 0

  async start(): Promise<void> {
    this.starts++
    this.emitEvent({ kind: 'connection', update: { state: 'ready' } })
  }
  async stop(): Promise<void> { this.stops++ }

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    this.outbox.push({ chatId, content, options })
    const ref: MessageRef = { id: `mock-${++counter}`, chatId }
    this.record({ dir: 'out', seq: ++this.journalSeq, at: Date.now(), chatId, content, options, ref })
    return { ref }
  }

  onEvent(listener: (e: InboundEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Bytes of a simulated media: a copy of the bytes behind the ref (`incomingMedia`,
   * `chat.sendMedia`); an empty buffer for a legacy `token: null` ref
   * (`incoming(text, { type: 'image' })`). A `{ url }` token without bytes rejects with
   * `MediaUnavailableError` — the mock never touches the network.
   */
  async downloadMedia(ref?: MediaRef): Promise<Buffer> {
    const token = ref?.token
    if (isMockMediaToken(token)) {
      if (token.bytes) return Buffer.from(token.bytes)
      throw new MediaUnavailableError(
        'rehydrate-failed',
        `MockProvider: this media was simulated as { url: ${JSON.stringify(token.url ?? '')} } without bytes; pass bytes (incomingMedia(kind, buffer) / chat.sendMedia(kind, buffer)) to make downloads resolve — the mock never touches the network`,
      )
    }
    return Buffer.alloc(0)
  }

  /** Forget the journal (the `seq` counter keeps growing; `outbox` is untouched). */
  clearJournal(): void {
    this.journal.length = 0
  }

  private record(entry: MockJournalEntry): void {
    this.journal.push(entry)
    const overflow = this.journal.length - this.maxJournal
    if (overflow > 0) this.journal.splice(0, overflow)
  }

  private emitEvent(e: InboundEvent): void {
    if (e.kind === 'message' || e.kind === 'interaction') {
      this.record({ dir: 'in', seq: ++this.journalSeq, at: Date.now(), event: e })
    }
    for (const listener of this.listeners) {
      // Match real transports' fire-and-forget delivery without leaking
      // rejected async listeners as process-level unhandled rejections.
      try { void Promise.resolve(listener(e)).catch(() => undefined) }
      catch { /* tests may assert errors through Bot's public error event */ }
    }
  }

  /** Simulate an incoming message. */
  incoming(text: string, opts: MockIncomingOptions = {}): void {
    const from = opts.from ?? 'user-1'
    const isGroup = opts.isGroup ?? false
    const senderId = opts.sender ?? from
    const type = opts.type ?? (opts.location ? 'location' : 'text')
    const media: MediaRef | undefined = MEDIA_TYPES.includes(type)
      ? { kind: type as MediaRef['kind'], token: null, ...opts.media }
      : undefined
    const message: InboundMessage = {
      ref: { id: opts.id ?? `in-${++counter}`, chatId: from },
      chat: { id: from, kind: isGroup ? 'group' : 'dm', isGroup, isBroadcast: false },
      senderInfo: senderInfoOf(senderId, opts),
      from, sender: senderId, chatId: from, senderId,
      isGroup, isBroadcast: false, fromMe: false,
      type, body: type === 'text' ? text : text ?? '',
      timestamp: Math.floor(Date.now() / 1000),
      mentions: opts.mentions ?? [],
      media,
      ...(opts.location ? { location: { ...opts.location } } : {}),
      raw: {},
    }
    this.emitEvent({ kind: 'message', message })
  }

  /**
   * Simulate an inbound media message (`type: kind`, body = caption). `source` bytes are
   * what {@link downloadMedia} returns; `{ url }` alone is metadata only, and the download
   * then rejects with `MediaUnavailableError`.
   */
  incomingMedia(kind: MediaRef['kind'], source: MockMediaSource, opts: MockIncomingOptions & MockMediaOptions = {}): void {
    const { caption, mimetype, filename, size, media, ...rest } = opts
    const bytes = isBytes(source) ? source : source.bytes
    const token: MockMediaToken = {
      ...(bytes !== undefined ? { bytes } : {}),
      ...(!isBytes(source) ? { url: source.url } : {}),
    }
    const mime = mimetype ?? DEFAULT_MIMETYPES[kind]
    const length = size ?? bytes?.byteLength
    const ref: Partial<Omit<MediaRef, 'kind'>> = {
      ...(mime !== undefined ? { mimetype: mime } : {}),
      ...(filename !== undefined ? { filename } : {}),
      ...(length !== undefined ? { size: length } : {}),
      token,
      ...media,
    }
    this.incoming(caption ?? '', { ...rest, type: kind, media: ref })
  }

  /**
   * Simulate a shared location (`type: 'location'`, `ctx.sharedLocation`). The body is
   * the place name, else the address, else `''` — as the real providers set it.
   */
  incomingLocation(location: InboundLocation, opts: Omit<MockIncomingOptions, 'location' | 'type'> = {}): void {
    this.incoming(location.name ?? location.address ?? '', { ...opts, type: 'location', location })
  }

  /** Simulate a UI interaction (button/list row/slash command; `kind` defaults to `'button'`). */
  interaction(data: string, opts: MockIncomingOptions = {}): void {
    const from = opts.from ?? 'user-1'
    const isGroup = opts.isGroup ?? false
    const senderId = opts.sender ?? from
    this.emitEvent({
      kind: 'interaction',
      interaction: {
        interactionId: `it-${++counter}`,
        ref: { id: opts.id ?? `in-${++counter}`, chatId: from },
        chat: { id: from, kind: isGroup ? 'group' : 'dm', isGroup, isBroadcast: false },
        senderInfo: senderInfoOf(senderId, opts),
        from, sender: senderId, chatId: from, senderId,
        isGroup, kind: opts.kind ?? 'button', data,
        timestamp: Math.floor(Date.now() / 1000),
        raw: {},
      },
    })
  }

  /**
   * Simulate a reaction to a message (`bot.on('reaction')`, `'reaction'` hooks). `to` is
   * the reacted message; the sender defaults to `from` (the chat), as in a DM.
   */
  reaction(emoji: string, opts: { to: MessageRef; from?: ChatId; sender?: UserId; removed?: boolean }): void {
    const senderId = opts.sender ?? opts.from ?? opts.to.chatId
    this.emitEvent({
      kind: 'reaction',
      reaction: { ref: opts.to, emoji, senderId, ...(opts.removed ? { removed: true } : {}) },
    })
  }

  /**
   * Simulate an inbound call notification (what `bot.on('call')` and the `CALL`
   * trigger receive). Reuse the same `id` to emit later updates of one call. For a
   * group call pass `chatId` (the group) and `isGroup: true`; `from` is the caller.
   */
  call(opts: Partial<CallEvent> = {}): void {
    const { id, from, status, ...extra } = opts
    this.emitEvent({
      kind: 'call',
      event: { id: id ?? `call-${++counter}`, from: from ?? 'user-1', status: status ?? 'offer', ...extra },
    })
  }
}

function senderInfoOf(id: string, opts: MockIncomingOptions): InboundMessage['senderInfo'] {
  return {
    id,
    displayName: opts.pushName ?? 'Test User',
    ...(opts.language !== undefined ? { language: opts.language } : {}),
    ...(opts.platformData !== undefined ? { platformData: opts.platformData } : {}),
  }
}

function isBytes(source: MockMediaSource): source is Buffer | Uint8Array {
  return source instanceof Uint8Array
}

/** `token` was built by {@link MockProvider.incomingMedia} (bytes and/or a URL). */
function isMockMediaToken(token: unknown): token is MockMediaToken {
  if (typeof token !== 'object' || token === null) return false
  const t = token as Record<string, unknown>
  return t.bytes instanceof Uint8Array || typeof t.url === 'string'
}

type OptionalSeam = 'editMessage' | 'deleteMessage' | 'sendDraft'

/**
 * Make a disabled seam read `undefined` on the instance (the bot gates these optional
 * `IProvider` methods on presence). With no explicit setting, a subclass override of
 * the method stays visible; an explicit `false` hides it as well.
 */
function hideSeam(target: MockProvider, name: OptionalSeam, explicit: boolean | undefined, enabled: boolean): void {
  if (enabled) return
  const overridden = target[name] !== MockProvider.prototype[name]
  if (explicit === undefined && overridden) return
  Object.defineProperty(target, name, { value: undefined, writable: true, configurable: true, enumerable: false })
}
