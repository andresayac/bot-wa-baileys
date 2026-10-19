/**
 * Email threading -> stable chatIds.
 *
 * `thread` mode (default): one chat per email thread. The chatId is
 * `thread:<root Message-ID>`, where the root is found by (1) looking up
 * In-Reply-To / References in the message index (catches replies to the bot's
 * own outbound mail and clients that trim References), else (2) the first
 * entry of References (RFC 5322: the thread root), else (3) In-Reply-To, else
 * (4) the message's own Message-ID (a new thread).
 *
 * `sender` mode: one chat per correspondent — the chatId is the normalized
 * sender address, like a DM on a chat transport; the thread state still tracks
 * the latest Message-ID so replies thread correctly in the human's client.
 *
 * Ownership: a thread chat belongs to the correspondent who opened it (its
 * `owner`, a normalized address). Mail from anyone else that points into it
 * (a Cc'd colleague answering all, or a forged In-Reply-To / Message-ID) gets
 * its own chat, so a third party never joins, reads or redirects another
 * correspondent's conversation. A reply that points at a foreign thread is
 * traced back through that thread's References to the sender's own chat.
 *
 * Thread state (who to answer, subject, References chain) lives in an
 * `EmailThreadStore`. `MemoryThreadStore` is the bounded default; use
 * `cursorThreadStore(store)` to persist it through any `IStore` with cursors
 * (sqlite, redis, postgres, ...) so the bot can still answer after a restart.
 */

import { createHash } from 'node:crypto'
import type { ChatId, IStore } from '@bot-wa/core'
import { domainOf, normalizeAddress, type EmailAddress } from './address.js'
import type { ParsedEmail } from './mime.js'

export type EmailThreadingMode = 'thread' | 'sender'

/** When replies go to `Reply-To` instead of `From` (see `EmailProviderConfig.replyTo`). */
export type EmailReplyToPolicy = 'same-domain' | 'always' | 'never'

export interface EmailThreadState {
  chatId: ChatId
  /** Base subject (no `Re:`/`Fwd:` prefixes). */
  subject: string
  /** Who replies go to: Reply-To, else From of the latest inbound message. */
  counterpart: EmailAddress
  /** Normalized address of the correspondent the chat belongs to (defaults to the counterpart's). */
  owner?: string
  /** Message-ID of the latest message in the thread (no brackets). */
  lastMessageId?: string
  /** References chain to send with the next reply (no brackets, capped). */
  references: string[]
  updatedAt: number
}

/** Last IMAP UID the provider processed in a mailbox, valid only for that UIDVALIDITY. */
export interface EmailMailboxCursor {
  uidValidity: string
  uid: number
  /**
   * Set while the first UNSEEN backlog scan is unfinished: it still covers the
   * UNSEEN mail after `uid` up to this UID (mail already read there is skipped).
   */
  scanUntil?: number
}

const copyCursor = (c: EmailMailboxCursor): EmailMailboxCursor =>
  c.scanUntil === undefined ? { uidValidity: c.uidValidity, uid: c.uid } : { uidValidity: c.uidValidity, uid: c.uid, scanUntil: c.scanUntil }

/** Persistence seam for thread state and the Message-ID -> chatId index. */
export interface EmailThreadStore {
  getThread(chatId: ChatId): Promise<EmailThreadState | undefined>
  setThread(chatId: ChatId, state: EmailThreadState): Promise<void>
  getChatIdForMessage(messageId: string): Promise<ChatId | undefined>
  setChatIdForMessage(messageId: string, chatId: ChatId): Promise<void>
  /**
   * Optional: the IMAP UID cursor of a mailbox (`key` is `<bot address>/<mailbox>`).
   * When the store keeps it, a restarted provider resumes after the last UID it
   * processed instead of re-scanning UNSEEN mail, so `markSeen: false` never replays.
   */
  getMailboxCursor?(key: string): Promise<EmailMailboxCursor | undefined>
  setMailboxCursor?(key: string, cursor: EmailMailboxCursor): Promise<void>
}

export interface MemoryThreadStoreOptions {
  /** Max entries kept per map (threads and message index), oldest evicted first. Default 10 000. */
  maxEntries?: number
}

/** Bounded in-memory thread store (lost on restart). */
export class MemoryThreadStore implements EmailThreadStore {
  private readonly threads = new Map<ChatId, EmailThreadState>()
  private readonly index = new Map<string, ChatId>()
  private readonly cursors = new Map<string, EmailMailboxCursor>()
  private readonly max: number

  constructor(opts: MemoryThreadStoreOptions = {}) {
    this.max = Math.max(1, opts.maxEntries ?? 10_000)
  }

  private put<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key)
    map.set(key, value)
    while (map.size > this.max) {
      const oldest = map.keys().next().value as K
      map.delete(oldest)
    }
  }

  async getThread(chatId: ChatId): Promise<EmailThreadState | undefined> {
    const s = this.threads.get(chatId)
    return s ? { ...s, counterpart: { ...s.counterpart }, references: [...s.references] } : undefined
  }
  async setThread(chatId: ChatId, state: EmailThreadState): Promise<void> {
    this.put(this.threads, chatId, { ...state, counterpart: { ...state.counterpart }, references: [...state.references] })
  }
  async getChatIdForMessage(messageId: string): Promise<ChatId | undefined> {
    return this.index.get(messageId)
  }
  async setChatIdForMessage(messageId: string, chatId: ChatId): Promise<void> {
    this.put(this.index, messageId, chatId)
  }
  async getMailboxCursor(key: string): Promise<EmailMailboxCursor | undefined> {
    const c = this.cursors.get(key)
    return c ? { ...c } : undefined
  }
  async setMailboxCursor(key: string, cursor: EmailMailboxCursor): Promise<void> {
    this.put(this.cursors, key, copyCursor(cursor))
  }
}

/** Index key recording that the bot itself sent `messageId` (a space never occurs in a parsed id). */
export const outboundKey = (messageId: string): string => `<out> ${messageId}`

/** The correspondent a thread belongs to. */
export function threadOwner(state: EmailThreadState): string {
  return state.owner ?? normalizeAddress(state.counterpart.address)
}

const hashKey = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32)

/**
 * Thread store backed by the cursor API of any `IStore` (`getCursor`/`setCursor`).
 * Keys are hashed so arbitrary Message-IDs fit every backend's key rules.
 */
export function cursorThreadStore(
  store: Pick<IStore, 'getCursor' | 'setCursor'>,
  prefix = 'email:',
): EmailThreadStore {
  if (typeof store.getCursor !== 'function' || typeof store.setCursor !== 'function') {
    throw new TypeError('cursorThreadStore requires a store that implements getCursor/setCursor')
  }
  const get = (k: string): Promise<string | undefined> => store.getCursor!(k)
  const set = (k: string, v: string): Promise<void> => store.setCursor!(k, v)
  return {
    async getThread(chatId) {
      const raw = await get(`${prefix}thread:${hashKey(chatId)}`)
      if (!raw) return undefined
      try {
        return JSON.parse(raw) as EmailThreadState
      } catch {
        return undefined
      }
    },
    async setThread(chatId, state) {
      await set(`${prefix}thread:${hashKey(chatId)}`, JSON.stringify(state))
    },
    async getChatIdForMessage(messageId) {
      return (await get(`${prefix}msg:${hashKey(messageId)}`)) || undefined
    },
    async setChatIdForMessage(messageId, chatId) {
      await set(`${prefix}msg:${hashKey(messageId)}`, chatId)
    },
    async getMailboxCursor(key) {
      const raw = await get(`${prefix}imap:${hashKey(key)}`)
      if (!raw) return undefined
      try {
        const c = JSON.parse(raw) as Partial<EmailMailboxCursor>
        if (typeof c.uidValidity !== 'string' || typeof c.uid !== 'number') return undefined
        return copyCursor({ uidValidity: c.uidValidity, uid: c.uid, scanUntil: typeof c.scanUntil === 'number' ? c.scanUntil : undefined })
      } catch {
        return undefined
      }
    },
    async setMailboxCursor(key, cursor) {
      await set(`${prefix}imap:${hashKey(key)}`, JSON.stringify(copyCursor(cursor)))
    },
  }
}

const PREFIX = /^\s*((re|fw|fwd|rv|aw|wg|sv|vs|tr|r|enc|res|antw)(\[\d+\]|\(\d+\))?\s*:\s*)+/i

/** Subject without reply/forward prefixes (`Re:`, `RE[2]:`, `Fwd:`, `RV:`, `AW:`, ...). */
export function baseSubject(subject: string): string {
  let s = subject.trim()
  let prev: string
  do {
    prev = s
    s = s.replace(PREFIX, '').trim()
  } while (s !== prev)
  return s
}

/** Cap a References chain: keep the root (first) and the most recent tail, RFC 5322 §3.6.4 style. */
export function capReferences(refs: string[], max: number): string[] {
  const unique = [...new Set(refs)]
  if (unique.length <= max) return unique
  if (max <= 1) return unique.slice(-1)
  return [unique[0]!, ...unique.slice(unique.length - (max - 1))]
}

export interface ThreadTrackerOptions {
  store: EmailThreadStore
  mode: EmailThreadingMode
  /** Max References entries carried on outbound replies. Default 20. */
  maxReferences?: number
  /** Default `'same-domain'`. */
  replyTo?: EmailReplyToPolicy
  now?: () => number
}

/** Resolves inbound messages to chatIds and keeps per-thread reply state. */
export class ThreadTracker {
  readonly store: EmailThreadStore
  private readonly mode: EmailThreadingMode
  private readonly maxReferences: number
  private readonly replyTo: EmailReplyToPolicy
  private readonly now: () => number

  constructor(opts: ThreadTrackerOptions) {
    this.store = opts.store
    this.mode = opts.mode
    this.maxReferences = Math.max(1, opts.maxReferences ?? 20)
    this.replyTo = opts.replyTo ?? 'same-domain'
    this.now = opts.now ?? Date.now
  }

  /** `chatId` when it is unused or belongs to `sender`. */
  private async owned(chatId: ChatId, sender: string): Promise<'mine' | 'free' | 'foreign'> {
    const state = await this.store.getThread(chatId)
    if (!state) return 'free'
    return threadOwner(state) === sender ? 'mine' : 'foreign'
  }

  private async findChatId(email: ParsedEmail, messageId: string, senderId: string): Promise<ChatId> {
    if (this.mode === 'sender') return senderId
    // Most recent ancestors first: In-Reply-To, then References from the tail.
    const ancestors = [email.inReplyTo, ...[...email.references].reverse()].filter((x): x is string => !!x)
    const foreign: ChatId[] = []
    for (const id of ancestors) {
      const known = await this.store.getChatIdForMessage(id)
      if (!known) continue
      const state = await this.store.getThread(known)
      if (!state || threadOwner(state) === senderId) return known
      if (!foreign.includes(known)) foreign.push(known)
    }
    // Replying to someone else's message: find the sender's own chat through that thread's chain.
    for (const chat of foreign) {
      const refs = (await this.store.getThread(chat))?.references ?? []
      for (const id of [...refs].reverse()) {
        const known = await this.store.getChatIdForMessage(id)
        if (known && known !== chat && (await this.owned(known, senderId)) === 'mine') return known
      }
    }
    if (messageId) {
      const own = await this.store.getChatIdForMessage(messageId)
      if (own && (await this.owned(own, senderId)) !== 'foreign') return own
    }
    const root = foreign.length ? messageId : (email.references[0] ?? email.inReplyTo ?? messageId)
    const candidate = `thread:${root}`
    if ((await this.owned(candidate, senderId)) !== 'foreign') return candidate
    // Collision with another correspondent's thread (a reused or forged Message-ID).
    return `thread:${messageId || root}~${hashKey(senderId).slice(0, 12)}`
  }

  private pickCounterpart(email: ParsedEmail, senderId: string): EmailAddress {
    const from = email.from ?? { address: senderId }
    const replyTo = email.replyTo[0]
    if (!replyTo || this.replyTo === 'never') return from
    if (this.replyTo === 'always') return replyTo
    return domainOf(replyTo.address) === domainOf(from.address) ? replyTo : from
  }

  /**
   * Resolve (and record) the chat of an inbound email. `messageId` is the
   * message's id (real or synthesized); `senderId` its normalized sender.
   */
  async resolveInbound(email: ParsedEmail, senderId: string, messageId = email.messageId ?? ''): Promise<ChatId> {
    const chatId = await this.findChatId(email, messageId, senderId)
    const prev = await this.store.getThread(chatId)
    const counterpart = this.pickCounterpart(email, senderId)
    const subject = baseSubject(email.subject)
    const chain = [...email.references]
    if (email.inReplyTo && !chain.includes(email.inReplyTo)) chain.push(email.inReplyTo)
    // Merge with what the thread already knows: clients often send only In-Reply-To,
    // and the next reply should still carry the root and the bot's own messages.
    const freshTopic = this.mode === 'sender' && !chain.length
    const known = freshTopic ? [] : (prev?.references ?? [])
    const references = capReferences([...known, ...chain, ...(messageId ? [messageId] : [])], this.maxReferences)
    await this.store.setThread(chatId, {
      chatId,
      subject: this.mode === 'sender' ? (subject || prev?.subject || '') : (prev?.subject || subject),
      counterpart: { name: counterpart.name, address: counterpart.address },
      owner: senderId,
      lastMessageId: messageId || prev?.lastMessageId,
      references,
      updatedAt: this.now(),
    })
    if (messageId) await this.store.setChatIdForMessage(messageId, chatId)
    return chatId
  }

  /** Record a message the bot sent into `chatId` so replies to it land in the same chat. */
  async recordOutbound(chatId: ChatId, messageId: string, init?: { counterpart: EmailAddress; subject: string }): Promise<void> {
    const prev = await this.store.getThread(chatId)
    const base = prev ?? (init
      ? { chatId, subject: init.subject, counterpart: init.counterpart, owner: normalizeAddress(init.counterpart.address), references: [], updatedAt: 0 }
      : undefined)
    if (base) {
      await this.store.setThread(chatId, {
        ...base,
        lastMessageId: messageId,
        references: capReferences([...base.references, messageId], this.maxReferences),
        updatedAt: this.now(),
      })
    }
    await this.store.setChatIdForMessage(messageId, chatId)
    await this.store.setChatIdForMessage(outboundKey(messageId), chatId)
  }

  /** The chat of a message the bot sent, or `undefined` when the bot never sent `messageId`. */
  async outboundChat(messageId: string): Promise<ChatId | undefined> {
    return this.store.getChatIdForMessage(outboundKey(messageId))
  }
}

