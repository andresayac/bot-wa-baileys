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
 * and option hashes), {@link decryptVote} tries the creator/voter JID forms a
 * client may have used (LID and PN differ per addressing mode; AES-GCM rejects a
 * wrong pair, so trying them is safe), and {@link recordVote}/{@link tally} keep
 * the latest selection per voter and aggregate it into per-option counts.
 */
import { createHash } from 'node:crypto'
import { decryptPollVote, normalizeMessageContent, type proto, type WAMessage } from '@whiskeysockets/baileys'

/** Default number of polls remembered; the oldest idle poll is evicted first. */
export const POLL_CACHE_MAX = 500

export interface PollOption {
  name: string
  /** Hex SHA-256 of the option name: what a decrypted vote selects. */
  hash: string
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

  constructor(private readonly max: number = POLL_CACHE_MAX) {}

  get size(): number { return this.polls.size }

  /**
   * Remember `message` if it is a poll creation carrying its messageSecret.
   * Returns whether it is tracked. Seeing the same poll again (the `send()`
   * result, then Baileys' `append` echo) keeps the tallies collected so far.
   */
  remember(message: WAMessage): boolean {
    const id = message.key?.id
    if (!id) return false
    if (this.polls.has(id)) return true
    const creation = pollCreationOf(message)
    if (!creation?.secret?.length) return false
    this.polls.set(id, {
      id,
      message,
      secret: creation.secret,
      options: creation.options.map((name) => ({ name, hash: optionHash(name) })),
      votes: new Map(),
    })
    while (this.polls.size > this.max) {
      const oldest = this.polls.keys().next()
      if (oldest.done) break
      this.polls.delete(oldest.value)
    }
    return true
  }

  get(id: string): TrackedPoll | undefined { return this.polls.get(id) }

  /** Mark a poll as recently used so active polls outlive idle ones. */
  touch(poll: TrackedPoll): void {
    if (this.polls.delete(poll.id)) this.polls.set(poll.id, poll)
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
 * older than the one already stored.
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
