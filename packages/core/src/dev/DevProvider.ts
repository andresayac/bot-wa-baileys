/**
 * DevProvider — the in-memory transport `botmesh dev` injects into your bot
 * factory. It is a {@link MockProvider} (no sockets, nothing leaves the
 * process) extended with what an interactive simulator needs:
 *
 *  - {@link DevProvider.onOutbound}: observe every message the bot sends, with
 *    the send ref (so polls can be voted on later);
 *  - {@link DevProvider.injectMedia}: simulate an inbound image/video/audio/...
 *    whose bytes `downloadMedia()` returns;
 *  - {@link DevProvider.injectPollVote}: simulate a poll vote (`bot.on('poll')`).
 *
 * Text and button taps reuse MockProvider's `incoming()` / `interaction()`.
 */

import type {
  ChatId,
  InboundEvent,
  InboundListener,
  InboundMessage,
  MediaRef,
  MessageRef,
  OutboundContent,
  SendOptions,
  SendResult,
  UserId,
} from '../core/provider.js'
import { MockProvider } from '../testing/MockProvider.js'

/** The simulated bot's own user id (`selfId`). Mention it as `@bot` in groups. */
export const DEV_BOT_ID = 'bot'

/** Inbound media kinds the simulator can inject with `:media`. */
export type DevMediaKind = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker'

/** One outbound message observed by {@link DevProvider.onOutbound}. */
export interface DevOutbound {
  chatId: ChatId
  content: OutboundContent
  options?: SendOptions
  /** The ref returned to the bot for this send. */
  ref: MessageRef
}

/** Who sends a simulated inbound event, and where. */
export interface DevSender {
  /** Chat the event belongs to (the user id in a DM, the group id in a group). */
  chatId: ChatId
  /** The simulated sender. */
  senderId: UserId
  isGroup: boolean
  /** Shown as `ctx.pushName` / `ctx.senderInfo.displayName`. */
  displayName?: string
  mentions?: UserId[]
}

/** A simulated inbound media message for {@link DevProvider.injectMedia}. */
export interface DevMediaInput extends DevSender {
  kind: DevMediaKind
  /** The file bytes `downloadMedia()` will return. */
  data: Uint8Array
  filename?: string
  mimetype?: string
  /** Becomes `ctx.body`. */
  caption?: string
}

/** A simulated poll vote for {@link DevProvider.injectPollVote}. */
export interface DevPollVoteInput {
  /** Ref of the poll message (from {@link DevOutbound.ref}). */
  poll: MessageRef
  /** Every option of the poll, in order. */
  options: string[]
  /** The option(s) this voter picked. */
  chosen: string[]
  senderId: UserId
}

/** Opaque media token carried in `MediaRef.token` for injected media. */
interface DevMediaToken {
  readonly devMedia: Uint8Array
}

function isDevMediaToken(token: unknown): token is DevMediaToken {
  return typeof token === 'object' && token !== null && (token as { devMedia?: unknown }).devMedia instanceof Uint8Array
}


export class DevProvider extends MockProvider {
  private readonly outboundListeners = new Set<(message: DevOutbound) => void>()
  private readonly devListeners = new Set<InboundListener>()
  private devSeq = 0

  constructor() {
    super()
    this.selfId = DEV_BOT_ID
  }

  /** Observe every outbound send. Returns an unsubscriber. Listener errors are ignored. */
  onOutbound(listener: (message: DevOutbound) => void): () => void {
    this.outboundListeners.add(listener)
    return () => { this.outboundListeners.delete(listener) }
  }

  override onEvent(listener: InboundListener): () => void {
    const off = super.onEvent(listener)
    this.devListeners.add(listener)
    return () => {
      off()
      this.devListeners.delete(listener)
    }
  }

  override async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    const result = await super.send(chatId, content, options)
    const message: DevOutbound = { chatId, content, options, ref: result.ref }
    for (const listener of [...this.outboundListeners]) {
      try { listener(message) } catch { /* a broken observer must not fail the bot's send */ }
    }
    return result
  }

  /** Returns the bytes of media injected with {@link injectMedia}; empty for anything else. */
  override async downloadMedia(ref?: MediaRef): Promise<Buffer> {
    const token = ref?.token
    return isDevMediaToken(token) ? Buffer.from(token.devMedia) : Buffer.alloc(0)
  }

  /** Simulate an inbound media message (type = `kind`, body = caption). */
  injectMedia(input: DevMediaInput): void {
    const id = `dev-in-${++this.devSeq}`
    const message: InboundMessage = {
      ref: { id, chatId: input.chatId },
      chat: { id: input.chatId, kind: input.isGroup ? 'group' : 'dm', isGroup: input.isGroup, isBroadcast: false },
      senderInfo: { id: input.senderId, displayName: input.displayName },
      from: input.chatId,
      sender: input.senderId,
      chatId: input.chatId,
      senderId: input.senderId,
      isGroup: input.isGroup,
      isBroadcast: false,
      fromMe: false,
      type: input.kind,
      body: input.caption ?? '',
      timestamp: Math.floor(Date.now() / 1000),
      mentions: input.mentions ?? [],
      media: {
        kind: input.kind,
        mimetype: input.mimetype,
        filename: input.filename,
        size: input.data.byteLength,
        token: { devMedia: input.data } satisfies DevMediaToken,
      },
      raw: {},
    }
    this.emitDev({ kind: 'message', message })
  }

  /** Simulate a vote on a poll the bot sent (surfaces as `bot.on('poll', vote)`). */
  injectPollVote(input: DevPollVoteInput): void {
    const chosen = new Set(input.chosen)
    this.emitDev({
      kind: 'poll-vote',
      vote: {
        ref: input.poll,
        senderId: input.senderId,
        options: input.options.map((name) => (chosen.has(name)
          ? { name, votes: 1, voters: [input.senderId] }
          : { name, votes: 0, voters: [] })),
      },
    })
  }

  private emitDev(event: InboundEvent): void {
    for (const listener of [...this.devListeners]) {
      // Same fire-and-forget delivery as MockProvider / real transports.
      try { void Promise.resolve(listener(event)).catch(() => undefined) }
      catch { /* surfaced through the Bot's error event */ }
    }
  }
}
