import { TypedEmitter, type ProviderEvents } from '../provider/BaileysProvider.js'
import type { IProvider, OutgoingMessage } from '../core/types.js'

let counter = 0

export class MockProvider extends TypedEmitter<ProviderEvents> implements IProvider {
  outbox: OutgoingMessage[] = []
  readonly socket: unknown | null = null

  async start(): Promise<void> {
    this.emitTyped('connection', { state: 'open' } as ProviderEvents['connection'])
  }
  async stop(): Promise<void> {}

  async send(jid: string, content: Record<string, unknown>, options?: Record<string, unknown>) {
    const out: OutgoingMessage = { jid, content, options }
    this.outbox.push(out)
    this.emit('sent', out)
    return { key: { id: `mock-${++counter}`, remoteJid: jid, fromMe: true } }
  }

  async readMessages(): Promise<void> {}
  async downloadMedia(): Promise<Buffer> { return Buffer.alloc(0) }

  /** Simulate an incoming WhatsApp message. */
  incoming(
    text: string,
    opts: {
      from?: string
      participant?: string
      /** PN twin of `from`, for simulating a LID-addressed DM (Baileys 7). */
      remoteJidAlt?: string
      /** PN twin of `participant`, for simulating a LID-addressed group sender. */
      participantAlt?: string
      type?: string
      id?: string
    } = {},
  ): void {
    const from = opts.from ?? 'user@s.whatsapp.net'
    const type = opts.type ?? 'text'
    const message: Record<string, unknown> = {}
    switch (type) {
      case 'text':
        message.conversation = text
        break
      case 'voice':
        message.audioMessage = { ptt: true, caption: text }
        break
      case 'poll':
        message.pollCreationMessage = { name: text }
        break
      case 'buttons':
        message.buttonsResponseMessage = { selectedButtonId: text, selectedDisplayText: text }
        break
      case 'list':
        message.listResponseMessage = { title: text }
        break
      default:
        // image / video / audio / document / sticker / location / contact ...
        message[`${type}Message`] = { caption: text }
    }
    this.emitTyped('rawMessage', {
      message: {
        key: {
          remoteJid: from,
          fromMe: false,
          id: opts.id ?? `in-${++counter}`,
          participant: opts.participant,
          remoteJidAlt: opts.remoteJidAlt,
          participantAlt: opts.participantAlt,
        },
        message,
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Test User',
      },
      type: 'notify',
    } as ProviderEvents['rawMessage'])
  }
}
