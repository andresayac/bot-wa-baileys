/**
 * MockProvider — an in-memory {@link IProvider} v2 for tests. No sockets, no
 * transport. `incoming()` emits a normalized message event; `interaction()`
 * emits an interaction event; `outbox` records everything sent.
 */

import type {
  ChatId,
  IProvider,
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

export interface IncomingOpts {
  from?: ChatId
  sender?: string
  isGroup?: boolean
  type?: MessageType
  id?: string
  pushName?: string
  mentions?: string[]
}

export class MockProvider implements IProvider {
  readonly id = 'mock'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll', 'buttons', 'list', 'reaction'],
    buttons: true, lists: true, polls: true, reactions: true, edit: false,
    typing: true, presence: true, readReceipts: true, groups: true, templates: false,
    interactionsRequireAck: false, pushIngress: false,
  }
  selfId: string | null = null

  outbox: MockOutgoing[] = []
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
  incoming(text: string, opts: IncomingOpts = {}): void {
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
      senderInfo: { id: senderId, displayName: opts.pushName ?? 'Test User' },
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
  interaction(data: string, opts: IncomingOpts = {}): void {
    const from = opts.from ?? 'user-1'
    const isGroup = opts.isGroup ?? false
    const senderId = opts.sender ?? from
    this.emitEvent({
      kind: 'interaction',
      interaction: {
        interactionId: `it-${++counter}`,
        ref: { id: opts.id ?? `in-${++counter}`, chatId: from },
        chat: { id: from, kind: isGroup ? 'group' : 'dm', isGroup, isBroadcast: false },
        senderInfo: { id: senderId, displayName: opts.pushName ?? 'Test User' },
        from, sender: senderId, chatId: from, senderId,
        isGroup, kind: 'button', data,
        timestamp: Math.floor(Date.now() / 1000),
        raw: {},
      },
    })
  }

  /**
   * Simulate an inbound call notification (what `bot.on('call')` and the `CALL`
   * trigger receive). Reuse the same `id` to emit later updates of one call.
   */
  call(opts: { id?: string; from?: string; status?: string } = {}): void {
    this.emitEvent({
      kind: 'call',
      event: { id: opts.id ?? `call-${++counter}`, from: opts.from ?? 'user-1', status: opts.status ?? 'offer' },
    })
  }
}
