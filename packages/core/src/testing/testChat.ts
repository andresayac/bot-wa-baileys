/**
 * Test chat views for {@link createTestBot}: one {@link TestChat} per (chat, sender)
 * pair over a shared {@link MockProvider}. A view simulates what a user does (text,
 * media, locations, reactions, native button presses, raw interactions) and asserts
 * on what the bot sent back (`expectReply`, `expectNoReply`, `replies`, `sent`), or
 * snapshots the whole exchange as a golden {@link Transcript}. Views of the same chat
 * share one reply cursor, so group participants read the chat's replies in order.
 */

import type {
  ChatId,
  InboundInteraction,
  InboundLocation,
  MediaRef,
  MessageRef,
  MessageType,
  OutboundContent,
} from '../core/provider.js'
import { renderOutbound } from '../dev/render.js'
import type { MockMediaOptions, MockMediaSource, MockOutgoing, MockProvider } from './MockProvider.js'
import {
  createTranscript,
  inboundTurnOf,
  outboundTurnOf,
  transcriptToText,
  type Transcript,
  type TranscriptInboundEvent,
  type TranscriptTurn,
} from './transcripts/format.js'

/** Default user of `createTestBot().chat` (a DM: `chatId === senderId`). */
export const DEFAULT_TEST_USER = 'user@s.whatsapp.net'
/** Default display name of simulated users (the mock's own default push name). */
export const DEFAULT_TEST_NAME = 'Test User'

/** Thrown by the test chat helpers on misuse (nothing to press, nothing to react to, an unexpected reply...). */
export class TestKitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TestKitError'
  }
}

/** Media kinds {@link TestChat.sendMedia} can simulate. */
export type TestMediaKind = MediaRef['kind']

/** What {@link TestChat.pressButton} pressed. */
export interface PressedButton {
  /** Button / row id (what the bot receives as `ctx.body` and `ctx.interaction.data`). */
  id: string
  title: string
  /** 1-based position among the message's choices. */
  index: number
  /** Interaction kind emitted: `'list'` for a list row, `'button'` otherwise. */
  kind: 'button' | 'list'
}

/** Options of {@link TestChat.transcript}. */
export interface TestTranscriptOptions {
  name?: string
  /** Keep `t` offsets (default `false`: snapshots must be stable). */
  timestamps?: boolean
  /** Keep message ids (default `false`: the mock's `in-N`/`mock-N` counters depend on test order). */
  ids?: boolean
  /** `'chat'` (default): this chat only; `'all'`: every chat the mock saw, interleaved as it happened. */
  scope?: 'chat' | 'all'
}

/** One message the bot sent, with the `ref` the mock returned (see {@link TestChat.sent}). */
export interface TestSent extends MockOutgoing {
  ref: MessageRef
}

/** A (chat, sender) view over the test bot. See {@link createTestBot}. */
export interface TestChat {
  /** @deprecated Alias of {@link chatId}. */
  jid: string
  /** The chat this view drives (the user id on a DM, the group id on a group). */
  chatId: string
  /** The simulated user (`ctx.senderId`). */
  senderId: string
  isGroup: boolean
  /** Push name the simulated user shows (`ctx.senderInfo.displayName`). */
  displayName: string

  /** Simulate an inbound message from this user, then yield one macrotask so the dispatch starts. */
  send(text: string, opts?: { type?: MessageType }): Promise<void>
  /** Simulate a shared location (`ctx.sharedLocation`, `c.waitLocation()`). */
  sendLocation(location: InboundLocation): Promise<void>
  sendLocation(lat: number, lng: number, extra?: Omit<InboundLocation, 'latitude' | 'longitude'>): Promise<void>
  /**
   * Simulate an inbound media message: `ctx.body` is the caption, `loadMediaOf(ctx)` resolves
   * with the bytes. A `{ url }` source without bytes makes the download reject with
   * `MediaUnavailableError` (the mock never touches the network).
   */
  sendMedia(kind: TestMediaKind, source: MockMediaSource, caption?: string | MockMediaOptions): Promise<void>
  /**
   * Simulate a reaction (`bot.on('reaction')`, `'reaction'` hooks). Default target: the bot's
   * last message in this chat, else the user's last message. `{ removed: true }` retracts it.
   */
  sendReaction(emoji: string, target?: MessageRef | { to?: MessageRef; removed?: boolean }): Promise<void>
  /** Simulate a raw interaction (`provider.interaction`): `data` is what `ctx.body` / `ctx.interaction.data` carry. */
  sendInteraction(data: string, opts?: { kind?: InboundInteraction['kind']; id?: string }): Promise<void>
  /**
   * Press a native button, list row or card button of the LAST interactive message the bot sent
   * to this chat: by id, by title (case-insensitive) or 1-based index. The bot receives what a
   * real press produces (a `'buttons'` message whose body is the id).
   */
  pressButton(target: string | number): Promise<PressedButton>

  /** Resolve with the first reply matching `matcher` (already sent or arriving before the timeout). */
  expectReply(matcher: string | RegExp, timeoutMs?: number): Promise<string>
  /**
   * Resolve when no reply beyond the ones already consumed exists now nor arrives within
   * `timeout` (default 300 ms); reject listing the unexpected replies. Consumes nothing.
   */
  expectNoReply(opts?: { timeout?: number } | number): Promise<void>

  /** Snapshot of all text/caption replies sent to this chat so far (buttons and lists: their text). */
  replies(): string[]
  /** Every message the bot sent to this chat, with its full content and `ref`. */
  sent(): TestSent[]
  /** The last message the bot sent to this chat. */
  lastReply(): TestSent | undefined

  /**
   * The exchange so far as a golden {@link Transcript} (same shape `recordTranscript`
   * produces: it parses, redacts and replays with `assertTranscript`). Deterministic by
   * default (no ids, no timestamps), so it fits `toMatchSnapshot()`.
   */
  transcript(opts: TestTranscriptOptions & { as: 'text' }): string
  transcript(opts?: TestTranscriptOptions): Transcript

  /** Same chat seen by another participant (groups). On a DM: another DM with the same bot. */
  as(userId: string, opts?: { displayName?: string }): TestChat
}

/** Identity of a view. */
export interface TestChatIdentity {
  chatId: ChatId
  senderId: string
  isGroup: boolean
  displayName: string
}

/** Extract the human-readable text/caption from an outbound content descriptor (the body of buttons, lists and cards too). */
export function textOf(m: { content: OutboundContent }): string {
  const c = m.content
  if (c.kind === 'text' || c.kind === 'buttons' || c.kind === 'list') return c.text
  if (c.kind === 'card') return c.title
  if ('caption' in c && typeof c.caption === 'string') return c.caption
  return ''
}

const INTERACTIVE_KINDS = new Set<OutboundContent['kind']>(['buttons', 'list', 'card'])

function assertId(value: string, what: string): void {
  if (typeof value !== 'string' || value === '') throw new RangeError(`${what} needs a non-empty id`)
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Builds {@link TestChat} views over one provider; all views of a chat share its reply cursor. */
export class TestChatFactory {
  private readonly cursors = new Map<ChatId, { cursor: number }>()

  constructor(readonly provider: MockProvider) {}

  /** A DM view (`chatId === senderId === userId`). */
  dm(userId: string, opts: { displayName?: string } = {}): TestChat {
    assertId(userId, 'dm()')
    return this.view({ chatId: userId, senderId: userId, isGroup: false, displayName: opts.displayName ?? DEFAULT_TEST_NAME })
  }

  /** A group view; `as` is the participant driving it. */
  group(groupId: string, opts: { as?: string; displayName?: string } = {}): TestChat {
    assertId(groupId, 'group()')
    const as = opts.as ?? DEFAULT_TEST_USER
    assertId(as, 'group({ as })')
    return this.view({ chatId: groupId, senderId: as, isGroup: true, displayName: opts.displayName ?? DEFAULT_TEST_NAME })
  }

  view(identity: TestChatIdentity): TestChat {
    return new TestChatView(this, identity)
  }

  /** Shared reply cursor of a chat. */
  cursorOf(chatId: ChatId): { cursor: number } {
    let entry = this.cursors.get(chatId)
    if (!entry) { entry = { cursor: 0 }; this.cursors.set(chatId, entry) }
    return entry
  }
}

class TestChatView implements TestChat {
  readonly jid: string
  readonly chatId: string
  readonly senderId: string
  readonly isGroup: boolean
  readonly displayName: string
  private readonly provider: MockProvider
  private readonly ledger: { cursor: number }

  constructor(private readonly factory: TestChatFactory, identity: TestChatIdentity) {
    this.provider = factory.provider
    this.chatId = identity.chatId
    this.jid = identity.chatId
    this.senderId = identity.senderId
    this.isGroup = identity.isGroup
    this.displayName = identity.displayName
    this.ledger = factory.cursorOf(identity.chatId)
  }

  private get from(): { from: ChatId; sender: string; isGroup: boolean; pushName: string } {
    return { from: this.chatId, sender: this.senderId, isGroup: this.isGroup, pushName: this.displayName }
  }

  private outbox(): MockOutgoing[] {
    return this.provider.outbox.filter((m) => m.chatId === this.chatId)
  }

  async send(text: string, opts?: { type?: MessageType }): Promise<void> {
    this.provider.incoming(text, { ...this.from, ...(opts?.type !== undefined ? { type: opts.type } : {}) })
    await tick()
  }

  async sendLocation(location: InboundLocation): Promise<void>
  async sendLocation(lat: number, lng: number, extra?: Omit<InboundLocation, 'latitude' | 'longitude'>): Promise<void>
  async sendLocation(first: InboundLocation | number, lng?: number, extra?: Omit<InboundLocation, 'latitude' | 'longitude'>): Promise<void> {
    const location: InboundLocation = typeof first === 'number'
      ? { latitude: first, longitude: lng as number, ...extra }
      : first
    this.provider.incomingLocation(location, this.from)
    await tick()
  }

  async sendMedia(kind: TestMediaKind, source: MockMediaSource, caption?: string | MockMediaOptions): Promise<void> {
    const opts = typeof caption === 'string' ? { caption } : caption ?? {}
    this.provider.incomingMedia(kind, source, { ...opts, ...this.from })
    await tick()
  }

  async sendReaction(emoji: string, target?: MessageRef | { to?: MessageRef; removed?: boolean }): Promise<void> {
    let to: MessageRef | undefined
    let removed = false
    if (target && 'id' in target) to = target
    else if (target) { to = target.to; removed = target.removed === true }
    to ??= this.lastReply()?.ref ?? this.lastInboundRef()
    if (!to) {
      throw new TestKitError(`nothing to react to in ${this.chatId}: send or receive a message first, or pass a MessageRef`)
    }
    this.provider.reaction(emoji, { to, from: this.chatId, sender: this.senderId, removed })
    await tick()
  }

  async sendInteraction(data: string, opts: { kind?: InboundInteraction['kind']; id?: string } = {}): Promise<void> {
    this.provider.interaction(data, { ...this.from, ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.id ? { id: opts.id } : {}) })
    await tick()
  }

  async pressButton(target: string | number): Promise<PressedButton> {
    const nativeOff = this.provider.capabilities.buttons === false
    const last = [...this.outbox()].reverse().find((m) =>
      INTERACTIVE_KINDS.has(m.content.kind) && !(nativeOff && m.content.kind !== 'list'))
    if (!last) {
      const hint = nativeOff ? " (with MockProvider({ buttons: false }) menus are numbered text: use chat.send('1'))" : ''
      throw new TestKitError(`no native buttons, list or card sent to ${this.chatId} yet${hint}`)
    }
    const choices = renderOutbound(last.content).choices
    const wanted = typeof target === 'string' ? target.trim() : target
    const choice = typeof wanted === 'number'
      ? choices.find((c) => c.n === wanted)
      : choices.find((c) => c.value === wanted)
        ?? choices.find((c) => c.label.toLowerCase() === wanted.toLowerCase())
        ?? choices.find((c) => c.value.toLowerCase() === wanted.toLowerCase())
    if (!choice) {
      const available = choices.map((c) => `${c.n} · ${c.value} · ${c.label}`).join(', ')
      throw new TestKitError(`no button ${JSON.stringify(target)} in the last ${last.content.kind} sent to ${this.chatId}; available: ${available}`)
    }
    if (choice.url) {
      throw new TestKitError(`"${choice.label}" is a link button (${choice.url}): it opens a URL and sends nothing to the bot`)
    }
    const kind: PressedButton['kind'] = last.content.kind === 'list' ? 'list' : 'button'
    this.provider.interaction(choice.value, { ...this.from, kind })
    await tick()
    return { id: choice.value, title: choice.label, index: choice.n, kind }
  }

  replies(): string[] {
    return this.outbox().map(textOf)
  }

  sent(): TestSent[] {
    const out: TestSent[] = []
    for (const entry of this.provider.journal) {
      if (entry.dir === 'out' && entry.chatId === this.chatId) {
        out.push({ chatId: entry.chatId, content: entry.content, options: entry.options, ref: entry.ref })
      }
    }
    return out
  }

  lastReply(): TestSent | undefined {
    const all = this.sent()
    return all[all.length - 1]
  }

  expectReply(matcher: string | RegExp, timeoutMs = 1000): Promise<string> {
    const matches = (s: string) => (typeof matcher === 'string' ? s.includes(matcher) : matcher.test(s))
    const ledger = this.ledger
    const scanFrom = (): string | undefined => {
      const scan = this.outbox()
      for (; ledger.cursor < scan.length; ledger.cursor++) {
        const t = textOf(scan[ledger.cursor])
        if (matches(t)) { ledger.cursor++; return t }
      }
      return undefined
    }
    return new Promise<string>((resolve, reject) => {
      const first = scanFrom()
      if (first !== undefined) return resolve(first)
      const timer = setTimeout(() => {
        clearInterval(iv)
        reject(new TestKitError(`No reply matching ${String(matcher)} within ${timeoutMs}ms. Outbox: ${JSON.stringify(this.replies())}`))
      }, timeoutMs)
      const iv = setInterval(() => {
        const found = scanFrom()
        if (found !== undefined) { clearTimeout(timer); clearInterval(iv); resolve(found) }
      }, 5)
    })
  }

  expectNoReply(opts: { timeout?: number } | number = {}): Promise<void> {
    const timeout = typeof opts === 'number' ? opts : opts.timeout ?? 300
    const unexpected = (): string[] => this.outbox().slice(this.ledger.cursor).map((m) => textOf(m) || `[${m.content.kind}]`)
    const fail = (got: string[]) => new TestKitError(`Expected no reply in ${this.chatId} within ${timeout}ms, got: ${JSON.stringify(got)}`)
    return new Promise<void>((resolve, reject) => {
      const now = unexpected()
      if (now.length > 0) return reject(fail(now))
      const timer = setTimeout(() => { clearInterval(iv); resolve() }, timeout)
      const iv = setInterval(() => {
        const got = unexpected()
        if (got.length > 0) { clearTimeout(timer); clearInterval(iv); reject(fail(got)) }
      }, 5)
    })
  }

  transcript(opts: TestTranscriptOptions & { as: 'text' }): string
  transcript(opts?: TestTranscriptOptions): Transcript
  transcript(opts: TestTranscriptOptions & { as?: 'text' } = {}): Transcript | string {
    const entries = this.provider.journal.filter((entry) =>
      opts.scope === 'all' || (entry.dir === 'out' ? entry.chatId : chatIdOf(entry.event)) === this.chatId)
    const startedAt = entries[0]?.at
    const turns: TranscriptTurn[] = entries.map((entry) => {
      const t = opts.timestamps && startedAt !== undefined ? entry.at - startedAt : undefined
      if (entry.dir === 'out') return outboundTurnOf(entry.chatId, entry.content, t, opts.ids ? entry.ref.id : undefined)
      const turn = inboundTurnOf(entry.event, t)
      if (!opts.ids) delete turn.id
      return turn
    })
    const transcript = createTranscript(turns, { source: 'recorder', ...(opts.name ? { name: opts.name } : {}) })
    return opts.as === 'text' ? transcriptToText(transcript) : transcript
  }

  as(userId: string, opts: { displayName?: string } = {}): TestChat {
    if (!this.isGroup) return this.factory.dm(userId, opts)
    assertId(userId, 'as()')
    return this.factory.view({ chatId: this.chatId, senderId: userId, isGroup: true, displayName: opts.displayName ?? DEFAULT_TEST_NAME })
  }

  private lastInboundRef(): MessageRef | undefined {
    for (let i = this.provider.journal.length - 1; i >= 0; i--) {
      const entry = this.provider.journal[i]
      if (entry.dir !== 'in' || chatIdOf(entry.event) !== this.chatId) continue
      return entry.event.kind === 'message' ? entry.event.message.ref : entry.event.interaction.ref
    }
    return undefined
  }
}

function chatIdOf(event: TranscriptInboundEvent): ChatId {
  return event.kind === 'message' ? event.message.chatId : event.interaction.chatId
}
