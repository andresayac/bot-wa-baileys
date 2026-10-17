/**
 * Transcript recorder — wraps any {@link IProvider} (a real transport or a
 * MockProvider) and records inbound messages/interactions and successful sends
 * as {@link Transcript} turns. The wrapper is transparent: the bot talks to it
 * exactly as it would to the wrapped provider.
 *
 * @example
 * ```ts
 * const recorder = recordTranscript(new MockProvider())
 * const bot = new Bot({ provider: recorder.provider })
 * // ... traffic ...
 * const golden = redactTranscript(recorder.transcript({ name: 'checkout' }))
 * ```
 */

import type {
  ChatId,
  IProvider,
  InboundEvent,
  OutboundContent,
  ProviderCapabilities,
  SendOptions,
  SendResult,
  UserId,
} from '../../core/provider.js'
import {
  createTranscript,
  outboundText,
  serializeContent,
  type Transcript,
  type TranscriptOutbound,
  type TranscriptTurn,
} from './format.js'

/** Options for {@link recordTranscript}. */
export interface RecordTranscriptOptions {
  /** Clock used for `t` offsets (default `Date.now`). */
  now?: () => number
  /** Also record messages flagged `fromMe` (echoes of the bot's own sends). Default `false`. */
  includeFromMe?: boolean
}

/** Handle returned by {@link recordTranscript}. */
export interface TranscriptRecorder<P extends IProvider = IProvider> {
  /** The recording provider to hand to `new Bot({ provider })`. */
  readonly provider: RecordingProvider<P>
  /** Snapshot of the turns recorded so far as a transcript. */
  transcript(meta?: { name?: string; description?: string }): Transcript
  /** Forget everything recorded so far (the clock restarts on the next turn). */
  clear(): void
  /** Stop recording; the provider keeps forwarding traffic. */
  pause(): void
  /** Resume recording after {@link pause}. */
  resume(): void
}

type Listener = (event: InboundEvent) => void | Promise<void>

interface PendingOut {
  turn: TranscriptOutbound
  settled: boolean
  failed: boolean
}

/** Transparent {@link IProvider} wrapper that records a transcript. */
export class RecordingProvider<P extends IProvider = IProvider> implements IProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  readonly inner: P

  ingest?: IProvider['ingest']
  downloadMedia?: IProvider['downloadMedia']
  getMessage?: IProvider['getMessage']
  markRead?: IProvider['markRead']
  typing?: IProvider['typing']
  deleteMessage?: IProvider['deleteMessage']
  editMessage?: IProvider['editMessage']
  acknowledgeInteraction?: IProvider['acknowledgeInteraction']

  /** @internal */ recording = true
  private readonly entries: Array<TranscriptTurn | PendingOut> = []
  private readonly listeners = new Set<Listener>()
  private startedAt: number | undefined
  private readonly now: () => number
  private readonly includeFromMe: boolean

  constructor(inner: P, options: RecordTranscriptOptions = {}) {
    this.inner = inner
    this.id = inner.id
    this.capabilities = inner.capabilities
    this.now = options.now ?? Date.now
    this.includeFromMe = options.includeFromMe ?? false

    if (inner.ingest) this.ingest = inner.ingest.bind(inner)
    if (inner.downloadMedia) this.downloadMedia = inner.downloadMedia.bind(inner)
    if (inner.getMessage) this.getMessage = inner.getMessage.bind(inner)
    if (inner.markRead) this.markRead = inner.markRead.bind(inner)
    if (inner.typing) this.typing = inner.typing.bind(inner)
    if (inner.deleteMessage) this.deleteMessage = inner.deleteMessage.bind(inner)
    if (inner.editMessage) this.editMessage = inner.editMessage.bind(inner)
    if (inner.acknowledgeInteraction) this.acknowledgeInteraction = inner.acknowledgeInteraction.bind(inner)

    inner.onEvent((event) => {
      this.observe(event)
      const results = [...this.listeners].map((listener) => listener(event))
      return Promise.all(results).then(() => undefined)
    })
  }

  get selfId(): UserId | null | undefined { return this.inner.selfId }
  get connection(): unknown { return this.inner.connection }

  start(): Promise<void> { return this.inner.start() }
  stop(): Promise<void> { return this.inner.stop() }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    const pending: PendingOut | undefined = this.recording
      ? {
          turn: { dir: 'out', chatId, kind: content.kind, text: outboundText(content), content: serializeContent(content), t: this.offset() },
          settled: false,
          failed: false,
        }
      : undefined
    if (pending) this.entries.push(pending)
    try {
      const result = await this.inner.send(chatId, content, options)
      if (pending) {
        pending.settled = true
        if (result.skipped) pending.failed = true
        else if (result.ref?.id) pending.turn.id = result.ref.id
      }
      return result
    } catch (error) {
      if (pending) { pending.settled = true; pending.failed = true }
      throw error
    }
  }

  /** @internal Number of raw entries (failed sends included) — a stable cursor for {@link snapshot}. */
  size(): number { return this.entries.length }

  /** @internal Recorded turns from raw cursor `from` on (failed/skipped sends excluded). */
  snapshot(from = 0, to?: number): TranscriptTurn[] {
    const turns: TranscriptTurn[] = []
    for (const entry of this.entries.slice(from, to)) {
      if ('dir' in entry) turns.push({ ...entry })
      else if (!entry.failed) turns.push({ ...entry.turn })
    }
    return turns
  }

  /** @internal */
  started(): number | undefined { return this.startedAt }

  /** @internal */
  reset(): void {
    this.entries.length = 0
    this.startedAt = undefined
  }

  private offset(): number {
    const now = this.now()
    if (this.startedAt === undefined) this.startedAt = now
    return now - this.startedAt
  }

  private observe(event: InboundEvent): void {
    if (!this.recording) return
    if (event.kind === 'message') {
      const message = event.message
      if (message.fromMe && !this.includeFromMe) return
      this.entries.push({
        dir: 'in',
        chatId: message.chatId,
        senderId: message.senderId,
        type: message.type,
        text: message.body ?? '',
        ...(message.isGroup ? { isGroup: true } : {}),
        ...(message.senderInfo?.displayName ? { displayName: message.senderInfo.displayName } : {}),
        ...(message.ref?.id ? { id: message.ref.id } : {}),
        t: this.offset(),
      })
    } else if (event.kind === 'interaction') {
      const it = event.interaction
      this.entries.push({
        dir: 'in',
        event: 'interaction',
        chatId: it.chatId,
        senderId: it.senderId,
        type: it.kind,
        text: it.data,
        ...(it.isGroup ? { isGroup: true } : {}),
        ...(it.senderInfo?.displayName ? { displayName: it.senderInfo.displayName } : {}),
        ...(it.ref?.id ? { id: it.ref.id } : {}),
        t: this.offset(),
      })
    }
  }
}

/**
 * Wrap `provider` in a {@link RecordingProvider}. Give `recorder.provider` to the
 * bot; read the conversation back with `recorder.transcript()`.
 */
export function recordTranscript<P extends IProvider>(provider: P, options: RecordTranscriptOptions = {}): TranscriptRecorder<P> {
  const recording = new RecordingProvider(provider, options)
  return {
    provider: recording,
    transcript(meta = {}) {
      const startedAt = recording.started()
      return createTranscript(recording.snapshot(), {
        source: 'recorder',
        ...(meta.name ? { name: meta.name } : {}),
        ...(meta.description ? { description: meta.description } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
      })
    },
    clear() { recording.reset() },
    pause() { recording.recording = false },
    resume() { recording.recording = true },
  }
}
