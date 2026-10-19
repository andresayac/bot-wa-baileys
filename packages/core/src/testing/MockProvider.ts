/**
 * MockProvider — an in-memory {@link IProvider} v2 for tests. No sockets, no
 * transport. `incoming()` emits a normalized message event; `interaction()`
 * emits an interaction event; `outbox` records everything sent.
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
  InboundMessage,
  MessageType,
  OutboundContent,
  ProviderCapabilities,
  SendOptions,
  SendResult,
  MediaRef,
} from '../core/provider.js'

let counter = 0

const MEDIA_TYPES: MessageType[] = ['image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact']

export interface MockOutgoing {
  chatId: ChatId
  content: OutboundContent
  options?: SendOptions
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
}

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

  constructor(options: MockProviderOptions = {}) {
    const streaming = options.streaming ?? 'none'
    const supports = options.supports ?? {}
    const edit = supports.edit ?? streaming !== 'none'
    const buttons = options.buttons ?? true
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

  async start(): Promise<void> {
    this.emitEvent({ kind: 'connection', update: { state: 'ready' } })
  }
  async stop(): Promise<void> {}

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    this.outbox.push({ chatId, content, options })
    return { ref: { id: `mock-${++counter}`, chatId } }
  }

  onEvent(listener: (e: InboundEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async downloadMedia(): Promise<Buffer> { return Buffer.alloc(0) }

  private emitEvent(e: InboundEvent): void {
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
    const type = opts.type ?? 'text'
    const media: MediaRef | undefined = MEDIA_TYPES.includes(type)
      ? { kind: type as MediaRef['kind'], token: null }
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
      raw: {},
    }
    this.emitEvent({ kind: 'message', message })
  }

  /** Simulate a UI interaction (button/slash/callback). */
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
        isGroup, kind: 'button', data,
        timestamp: Math.floor(Date.now() / 1000),
        raw: {},
      },
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
