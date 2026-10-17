/**
 * Poll tracking and vote decryption for Baileys 7.
 *
 * WhatsApp encrypts every poll vote end to end with a key derived from the
 * poll's 32-byte `messageContextInfo.messageSecret`, the poll id, the poll
 * creator's JID and the voter's JID. Baileys 7 ships its own decryption
 * commented out (Utils/process-message.js), so `messages.update` never carries
 * `pollUpdates`: a vote only arrives as an encrypted `pollUpdateMessage` upsert.
 *
 * {@link PollTracker} remembers the polls this process sees (with their secret
 * and option hashes) and the vote messages already counted, {@link decryptVote}
 * tries the creator/voter JID forms a client may have used (LID and PN differ
 * per addressing mode; AES-GCM rejects a wrong pair, so trying them is safe), and
 * {@link recordVote}/{@link tally} keep the latest selection per voter and
 * aggregate it into per-option counts.
 *
 * The key derivation does not cover the chat, and every member of a chat knows
 * its polls' ids and secrets, so a decryptable vote is not proof that it belongs
 * to the poll it names: the caller must also bind the vote to the poll's chat and
 * creator (see BaileysProvider.onPollVote).
 */
import { createHash } from 'node:crypto'
import { decryptPollVote, normalizeMessageContent, type proto, type WAMessage } from '@whiskeysockets/baileys'

/** Default number of polls remembered; the oldest idle poll is evicted first. */
export const POLL_CACHE_MAX = 500
/** Default number of counted vote message ids remembered to drop redeliveries. */
export const VOTE_IDS_MAX = 5000

export interface PollOption {
  name: string
  /** Hex SHA-256 of the option name: what a decrypted vote selects. */
  hash: string
}

/**
 * The JSON-safe record a {@link PollStore} keeps for one poll: what a later
 * process needs to decrypt, bind and tally its votes. No message bodies beyond
 * the poll question and option names.
 */
export interface StoredPoll {
  /** The poll message id (the store key). */
  id: string
  /** The poll message key: its chat and creator, as Baileys delivered it. */
  key: {
    remoteJid: string
    remoteJidAlt?: string
    participant?: string
    participantAlt?: string
    fromMe: boolean
  }
  /** The poll question. */
  name: string
  /** Base64 of the poll's 32-byte messageSecret (the vote decryption key material). */
  secret: string
  /** Option names with their hex SHA-256, in the poll's order. */
  options: PollOption[]
  /** Latest selection per canonical voter id (empty `hashes` = retracted). */
  votes: Array<{ voter: string; hashes: string[]; at: number }>
  /** Poll creation time, unix seconds, when known. */
  timestamp?: number
}

/**
 * Pluggable persistence for polls, so votes cast after a restart can still be
 * decrypted and tallied. Keyed by poll message id. The provider calls `set`
 * when it first sees a poll and after every counted vote, `get` when a vote
 * names a poll missing from its in-memory cache (or a new poll reuses an id),
 * and `delete` when a stored entry is malformed. Retention (TTL, cleanup) is up
 * to the host. A rejecting call is logged and never breaks sends or ingress.
 * The entry holds the poll's secret: keep the store as private as the session.
 */
export interface PollStore {
  get(pollId: string): Promise<StoredPoll | null | undefined>
  set(pollId: string, poll: StoredPoll): Promise<void>
  delete(pollId: string): Promise<void>
}

export interface TrackedPoll {
  id: string
  /** The poll creation message (the `native` of a poll-vote `ref`). */
  message: WAMessage
  secret: Uint8Array
  options: PollOption[]
  /** Latest selection per canonical voter id. An empty list is a retracted vote. */
  votes: Map<string, { hashes: string[]; at: number }>
}

/** The poll creation inside a message (any version, unwrapped), or `undefined`. */
export function pollCreationOf(
  message: WAMessage,
): { name: string; options: string[]; secret?: Uint8Array } | undefined {
  const content = normalizeMessageContent(message.message)
  const creation = content?.pollCreationMessage ?? content?.pollCreationMessageV2 ?? content?.pollCreationMessageV3
  if (!creation) return undefined
  const secret = content?.messageContextInfo?.messageSecret ?? message.message?.messageContextInfo?.messageSecret
  return {
    name: creation.name ?? '',
    options: (creation.options ?? []).map((o) => o.optionName ?? ''),
    secret: secret ?? undefined,
  }
}

/** The encrypted vote inside a message (unwrapped), or `undefined`. */
export function pollUpdateOf(message: WAMessage): proto.Message.IPollUpdateMessage | undefined {
  return normalizeMessageContent(message.message)?.pollUpdateMessage ?? undefined
}

const optionHash = (name: string): string => createHash('sha256').update(Buffer.from(name)).digest('hex')

/** Bounded, insertion-ordered cache of the polls whose votes can be decrypted. */
export class PollTracker {
  private readonly polls = new Map<string, TrackedPoll>()
  /** `<pollId> <voteMessageId>` of the votes already counted, oldest first. */
  private readonly votesSeen = new Set<string>()

  constructor(
    private readonly max: number = POLL_CACHE_MAX,
    private readonly maxVoteIds: number = VOTE_IDS_MAX,
  ) {}

  get size(): number { return this.polls.size }

  /**
   * Remember `message` if it is a poll creation carrying its messageSecret.
   * Returns whether it is tracked. Seeing the same poll again (the `send()`
   * result, then Baileys' `append` echo) keeps the tallies collected so far. A
   * different poll reusing a tracked id (ids are chosen by the sending client)
   * never replaces it; its votes fail the caller's creator check.
   */
  remember(message: WAMessage): boolean {
    return !!this.track(message)
  }

  /**
   * Like {@link remember}, returning the tracked poll and whether this call
   * added it (`isNew`), so a caller can persist new polls only.
   */
  track(message: WAMessage): { poll: TrackedPoll; isNew: boolean } | undefined {
    const id = message.key?.id
    if (!id) return undefined
    const existing = this.polls.get(id)
    if (existing) return { poll: existing, isNew: false }
    const creation = pollCreationOf(message)
    if (!creation?.secret?.length) return undefined
    const poll: TrackedPoll = {
      id,
      message,
      secret: creation.secret,
      options: creation.options.map((name) => ({ name, hash: optionHash(name) })),
      votes: new Map(),
    }
    this.adopt(poll)
    return { poll, isNew: true }
  }

  /** Insert an already-built poll (e.g. loaded from a {@link PollStore}), evicting the oldest. */
  adopt(poll: TrackedPoll): void {
    this.polls.delete(poll.id)
    this.polls.set(poll.id, poll)
    while (this.polls.size > this.max) {
      const oldest = this.polls.keys().next()
      if (oldest.done) break
      this.polls.delete(oldest.value)
    }
  }

  get(id: string): TrackedPoll | undefined { return this.polls.get(id) }

  /** Mark a poll as recently used so active polls outlive idle ones. */
  touch(poll: TrackedPoll): void {
    if (this.polls.delete(poll.id)) this.polls.set(poll.id, poll)
  }

  /**
   * Whether the vote message `voteId` was already counted for `poll`. Baileys
   * re-emits offline deliveries as `append` upserts, so the same vote message
   * can arrive twice.
   */
  hasVote(poll: TrackedPoll, voteId: string): boolean {
    return this.votesSeen.has(`${poll.id} ${voteId}`)
  }

  /** Record that `voteId` was counted for `poll`; the oldest ids are forgotten first. */
  markVote(poll: TrackedPoll, voteId: string): void {
    this.votesSeen.add(`${poll.id} ${voteId}`)
    while (this.votesSeen.size > this.maxVoteIds) {
      const oldest = this.votesSeen.values().next()
      if (oldest.done) break
      this.votesSeen.delete(oldest.value)
    }
  }
}

/**
 * Decrypt an encrypted vote, trying every creator × voter JID candidate (both
 * normalised, device-free). Returns the selected option hashes (hex), or
 * `undefined` when no pair authenticates: wrong secret, or a JID form we do not
 * know.
 */
export function decryptVote(
  vote: proto.Message.IPollEncValue | null | undefined,
  poll: TrackedPoll,
  creators: string[],
  voters: string[],
): { hashes: string[] } | undefined {
  if (!vote?.encPayload?.length || !vote.encIv?.length) return undefined
  for (const pollCreatorJid of creators) {
    for (const voterJid of voters) {
      try {
        const decoded = decryptPollVote(vote, { pollCreatorJid, pollMsgId: poll.id, pollEncKey: poll.secret, voterJid })
        return { hashes: (decoded.selectedOptions ?? []).map((h) => Buffer.from(h).toString('hex')) }
      } catch {
        // Wrong JID pair: GCM authentication fails. Try the next candidate.
      }
    }
  }
  return undefined
}

/**
 * Store `voterId`'s latest selection. Earlier entries whose voter has since been
 * canonicalised to another id (a bare LID whose PN was learned) are merged first,
 * so one person is counted once. Returns `false`, changing nothing, for a vote
 * older than the one already stored. A vote with the same timestamp replaces it:
 * it is another vote message sent in the same millisecond, because redeliveries
 * of an already counted message are dropped earlier ({@link PollTracker.hasVote}).
 */
export function recordVote(
  poll: TrackedPoll,
  voterId: string,
  hashes: string[],
  at: number,
  canonical: (id: string) => string,
): boolean {
  for (const [id, entry] of [...poll.votes]) {
    const target = canonical(id)
    if (!target || target === id) continue
    poll.votes.delete(id)
    const existing = poll.votes.get(target)
    if (!existing || existing.at <= entry.at) poll.votes.set(target, entry)
  }
  const previous = poll.votes.get(voterId)
  if (previous && at < previous.at) return false
  poll.votes.set(voterId, { hashes, at })
  return true
}

/** Per-option tallies in the poll's option order, with canonical voter ids. */
export function tally(poll: TrackedPoll): Array<{ name: string; votes: number; voters: string[] }> {
  return poll.options.map((option) => {
    const voters = [...poll.votes].filter(([, v]) => v.hashes.includes(option.hash)).map(([id]) => id)
    return { name: option.name, votes: voters.length, voters }
  })
}

/** Optional key fields kept beside `remoteJid`/`fromMe`: the twins and the group creator. */
const KEY_FIELDS = ['remoteJidAlt', 'participant', 'participantAlt'] as const

/** The JSON-safe {@link StoredPoll} for a tracked poll. */
export function toStoredPoll(poll: TrackedPoll): StoredPoll {
  const raw = poll.message.key ?? {}
  const key: StoredPoll['key'] = { remoteJid: raw.remoteJid ?? '', fromMe: !!raw.fromMe }
  for (const field of KEY_FIELDS) {
    const value = raw[field]
    if (typeof value === 'string' && value) key[field] = value
  }
  const timestamp = Number(poll.message.messageTimestamp ?? 0)
  return {
    id: poll.id,
    key,
    name: pollCreationOf(poll.message)?.name ?? '',
    secret: Buffer.from(poll.secret).toString('base64'),
    options: poll.options.map((o) => ({ name: o.name, hash: o.hash })),
    votes: [...poll.votes].map(([voter, v]) => ({ voter, hashes: [...v.hashes], at: v.at })),
    ...(Number.isFinite(timestamp) && timestamp > 0 ? { timestamp } : {}),
  }
}

const isString = (v: unknown): v is string => typeof v === 'string'
const HEX_HASH = /^[0-9a-f]{64}$/

/**
 * Rebuild a tracked poll from a stored record, or `undefined` when the record
 * is malformed (wrong id, missing chat, secret not 32 bytes, bad options or
 * votes). `message` is a minimal poll creation message carrying the stored key,
 * usable as the `native` of a poll-vote ref (e.g. to quote the poll).
 */
export function fromStoredPoll(id: string, stored: unknown): TrackedPoll | undefined {
  if (!stored || typeof stored !== 'object') return undefined
  const s = stored as Partial<StoredPoll>
  if (s.id !== id || !s.key || typeof s.key !== 'object' || !isString(s.key.remoteJid) || !s.key.remoteJid) return undefined
  if (!isString(s.secret)) return undefined
  const secret = new Uint8Array(Buffer.from(s.secret, 'base64'))
  if (secret.length !== 32) return undefined
  if (!Array.isArray(s.options) || !s.options.every((o) => o && isString(o.name) && isString(o.hash) && HEX_HASH.test(o.hash))) return undefined
  const votes = new Map<string, { hashes: string[]; at: number }>()
  for (const v of Array.isArray(s.votes) ? s.votes : []) {
    if (!v || !isString(v.voter) || !Array.isArray(v.hashes) || !v.hashes.every(isString) || typeof v.at !== 'number') return undefined
    votes.set(v.voter, { hashes: [...v.hashes], at: v.at })
  }
  const key: Record<string, unknown> = { remoteJid: s.key.remoteJid, fromMe: !!s.key.fromMe, id }
  for (const field of KEY_FIELDS) if (isString(s.key[field]) && s.key[field]) key[field] = s.key[field]
  const message = {
    key,
    message: {
      pollCreationMessage: { name: isString(s.name) ? s.name : '', options: s.options.map((o) => ({ optionName: o.name })) },
      messageContextInfo: { messageSecret: secret },
    },
    ...(typeof s.timestamp === 'number' ? { messageTimestamp: s.timestamp } : {}),
  } as unknown as WAMessage
  return { id, message, secret, options: s.options.map((o) => ({ name: o.name, hash: o.hash })), votes }
}
