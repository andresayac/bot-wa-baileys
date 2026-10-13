/**
 * Poll votes (GitHub issue #7). Baileys 7 ships its own vote decryption
 * commented out (Utils/process-message.js), so `messages.update` never carries
 * `pollUpdates`: a vote reaches us only as an encrypted `pollUpdateMessage`
 * upsert. The provider must remember the polls it sees (its own sends and the
 * `append` echo included), decrypt each vote with the poll's messageSecret and
 * emit a `poll-vote` event with canonical voter ids, never a `poll` message.
 *
 * Votes here are encrypted with an independent implementation of WhatsApp's
 * key derivation (HMAC(pollId|creator|voter|'Poll Vote'|1) over HMAC(secret)),
 * using the JID forms a real client uses for the chat's addressing mode.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  const { fakeMakeWASocket } = await import('./support/harness.js')
  return { ...actual, default: fakeMakeWASocket, makeCacheableSignalKeyStore: (keys: unknown) => keys }
})

const B = await import('@whiskeysockets/baileys')
const { BaileysProvider } = await import('../src/BaileysProvider.js')
const { PollTracker } = await import('../src/polls.js')
const { connect, ME_LID, ME_PN } = await import('./support/harness.js')
type Harness = Awaited<ReturnType<typeof connect>>

const GROUP = '120363000000000000@g.us'
const VOTER_LID = '200000000000001@lid'
const VOTER_PN = '573001111111@s.whatsapp.net'
const VOTER2_LID = '200000000000002@lid'
const VOTER2_PN = '573002222222@s.whatsapp.net'
const USER_LID = '300000000000001@lid'
const USER_PN = '573003333333@s.whatsapp.net'

const generatePoll = (jid: string, name: string, values: string[], multi = false) =>
  B.generateWAMessage(jid, { poll: { name, values, selectableCount: multi ? values.length : 1 } }, {
    userJid: ME_PN,
    upload: (async () => { throw new Error('no upload in tests') }) as never,
  })

/** Send a poll through provider.send(); the fake socket answers like Baileys' sendMessage. */
async function sendPoll(h: Harness, chatId: string, question: string, options: string[], multiSelect = false) {
  h.sock.sendMessage.mockImplementationOnce(async (jid: string) => generatePoll(jid, question, options, multiSelect))
  const res = await h.provider.send(chatId, { kind: 'poll', question, options, multiSelect })
  return res.raw as WAMessage
}

function encryptVote(poll: WAMessage, creator: string, voter: string, selected: string[]) {
  const secret = poll.message!.messageContextInfo!.messageSecret!
  const pollId = poll.key.id!
  const sign = Buffer.concat([
    Buffer.from(pollId), Buffer.from(creator), Buffer.from(voter), Buffer.from('Poll Vote'), new Uint8Array([1]),
  ])
  const key = B.hmacSign(sign, B.hmacSign(secret, new Uint8Array(32), 'sha256'), 'sha256')
  const encIv = randomBytes(12)
  const plain = B.proto.Message.PollVoteMessage.encode({ selectedOptions: selected.map((o) => B.sha256(Buffer.from(o))) }).finish()
  const encPayload = B.aesEncryptGCM(plain, key, encIv, Buffer.from(`${pollId}\u0000${voter}`))
  return { encPayload, encIv }
}

let voteSeq = 0
function voteMessage(
  key: Partial<WAMessageKey> & { remoteJid: string },
  pollKey: Partial<WAMessageKey>,
  vote: { encPayload: Uint8Array; encIv: Uint8Array },
  senderTimestampMs = Date.now(),
): WAMessage {
  return {
    key: { fromMe: false, id: `VOTE-${++voteSeq}`, ...key },
    message: { pollUpdateMessage: { pollCreationMessageKey: pollKey, vote, senderTimestampMs } },
    messageTimestamp: Math.floor(senderTimestampMs / 1000),
  } as unknown as WAMessage
}

const upsert = (messages: WAMessage[], type: 'notify' | 'append' = 'notify') => ({ 'messages.upsert': { type, messages } })

describe('poll votes: decryption and poll-vote events', () => {
  it('decrypts a vote on a poll the bot sent to a LID-addressed group (LID creator + LID voter)', async () => {
    const h = await connect(BaileysProvider)
    const poll = await sendPoll(h, GROUP, 'Lunch?', ['Pizza', 'Sushi'])

    await h.emit(upsert([voteMessage(
      { remoteJid: GROUP, participant: VOTER_LID, participantAlt: VOTER_PN },
      { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID },
      encryptVote(poll, ME_LID, VOTER_LID, ['Sushi']),
    )]))

    expect(h.ofKind('message')).toHaveLength(0) // the encrypted update is not a message
    const votes = h.ofKind('poll-vote')
    expect(votes).toHaveLength(1)
    const { vote } = votes[0]!
    expect(vote.ref).toEqual({ id: poll.key.id, chatId: GROUP, native: poll })
    expect(vote.senderId).toBe(VOTER_PN)
    expect(vote.options).toEqual([
      { name: 'Pizza', votes: 0, voters: [] },
      { name: 'Sushi', votes: 1, voters: [VOTER_PN] },
    ])
  })

  it('decrypts a PN-addressed DM vote and reports the chatId the poll was sent to', async () => {
    const h = await connect(BaileysProvider)
    const poll = await sendPoll(h, USER_PN, 'Confirm?', ['Yes', 'No'])

    // The vote arrives keyed by the user's LID with the PN twin alongside.
    await h.emit(upsert([voteMessage(
      { remoteJid: USER_LID, remoteJidAlt: USER_PN },
      { remoteJid: USER_LID, fromMe: true, id: poll.key.id },
      encryptVote(poll, ME_PN, USER_PN, ['Yes']),
    )]))

    const [event] = h.ofKind('poll-vote')
    expect(event?.vote.senderId).toBe(USER_PN)
    expect(event?.vote.ref.chatId).toBe(USER_PN)
    expect(event?.vote.options.map((o) => [o.name, o.votes])).toEqual([['Yes', 1], ['No', 0]])
  })

  it('keeps the latest vote per person: a change replaces, an empty selection retracts, a stale vote is ignored', async () => {
    const h = await connect(BaileysProvider)
    const poll = await sendPoll(h, GROUP, 'Pick', ['A', 'B', 'C'], true)
    const pollKey = { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID }
    const by1 = { remoteJid: GROUP, participant: VOTER_LID, participantAlt: VOTER_PN }
    const by2 = { remoteJid: GROUP, participant: VOTER2_LID, participantAlt: VOTER2_PN }
    const tallies = () => h.ofKind('poll-vote').at(-1)!.vote.options.map((o) => [o.name, o.votes, o.voters])

    await h.emit(upsert([voteMessage(by1, pollKey, encryptVote(poll, ME_LID, VOTER_LID, ['A', 'B']), 1000)]))
    await h.emit(upsert([voteMessage(by2, pollKey, encryptVote(poll, ME_LID, VOTER2_LID, ['B']), 1001)]))
    expect(tallies()).toEqual([['A', 1, [VOTER_PN]], ['B', 2, [VOTER_PN, VOTER2_PN]], ['C', 0, []]])

    await h.emit(upsert([voteMessage(by1, pollKey, encryptVote(poll, ME_LID, VOTER_LID, ['C']), 1002)]))
    await h.emit(upsert([voteMessage(by2, pollKey, encryptVote(poll, ME_LID, VOTER2_LID, []), 1003)]))
    expect(tallies()).toEqual([['A', 0, []], ['B', 0, []], ['C', 1, [VOTER_PN]]])
    expect(h.ofKind('poll-vote').at(-1)!.vote.senderId).toBe(VOTER2_PN)

    const before = h.ofKind('poll-vote').length
    await h.emit(upsert([voteMessage(by1, pollKey, encryptVote(poll, ME_LID, VOTER_LID, ['A']), 999)]))
    expect(h.ofKind('poll-vote')).toHaveLength(before)
    expect(tallies()).toEqual([['A', 0, []], ['B', 0, []], ['C', 1, [VOTER_PN]]])
  })

  it('counts one person once when their votes arrive as a bare LID first and with the PN twin later', async () => {
    const h = await connect(BaileysProvider)
    const poll = await sendPoll(h, GROUP, 'Pick', ['A', 'B'])
    const pollKey = { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID }

    await h.emit(upsert([voteMessage({ remoteJid: GROUP, participant: VOTER_LID }, pollKey, encryptVote(poll, ME_LID, VOTER_LID, ['A']), 1000)]))
    expect(h.ofKind('poll-vote').at(-1)!.vote.senderId).toBe(VOTER_LID) // no mapping known yet

    await h.emit(upsert([voteMessage(
      { remoteJid: GROUP, participant: VOTER_LID, participantAlt: VOTER_PN }, pollKey,
      encryptVote(poll, ME_LID, VOTER_LID, ['B']), 1001,
    )]))
    const { vote } = h.ofKind('poll-vote').at(-1)!
    expect(vote.senderId).toBe(VOTER_PN)
    expect(vote.options).toEqual([
      { name: 'A', votes: 0, voters: [] },
      { name: 'B', votes: 1, voters: [VOTER_PN] },
    ])
  })

  it('resolves a bare-LID voter through the signal LID mapping store', async () => {
    const h = await connect(BaileysProvider)
    h.sock.lidMap.set(VOTER_LID, '573001111111:4@s.whatsapp.net')
    const poll = await sendPoll(h, GROUP, 'Pick', ['A', 'B'])

    await h.emit(upsert([voteMessage(
      { remoteJid: GROUP, participant: VOTER_LID },
      { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID },
      encryptVote(poll, ME_LID, VOTER_LID, ['B']),
    )]))

    expect(h.ofKind('poll-vote')[0]?.vote.senderId).toBe(VOTER_PN)
  })

  it('learns polls from `append` upserts (Baileys echoes the bot\'s own sends) without emitting them', async () => {
    const h = await connect(BaileysProvider)
    const poll = await generatePoll(GROUP, 'Echoed', ['X', 'Y'])
    await h.emit(upsert([poll], 'append'))
    expect(h.events).toHaveLength(0)

    await h.emit(upsert([voteMessage(
      { remoteJid: GROUP, participant: VOTER_LID, participantAlt: VOTER_PN },
      { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID },
      encryptVote(poll, ME_LID, VOTER_LID, ['Y']),
    )]))
    expect(h.ofKind('poll-vote')[0]?.vote.options.map((o) => o.votes)).toEqual([0, 1])
  })

  it('decrypts votes on a poll another group member created', async () => {
    const h = await connect(BaileysProvider)
    const poll = await generatePoll(GROUP, 'Their poll', ['One', 'Two'])
    poll.key = { remoteJid: GROUP, fromMe: false, id: poll.key.id, participant: VOTER2_LID, participantAlt: VOTER2_PN } as WAMessageKey
    await h.emit(upsert([poll]))
    const [created] = h.ofKind('message')
    expect(created?.message.type).toBe('poll')
    expect(created?.message.body).toBe('Their poll')

    await h.emit(upsert([voteMessage(
      { remoteJid: GROUP, participant: VOTER_LID, participantAlt: VOTER_PN },
      { remoteJid: GROUP, fromMe: false, id: poll.key.id, participant: VOTER2_LID },
      encryptVote(poll, VOTER2_LID, VOTER_LID, ['Two']),
    )]))
    const [event] = h.ofKind('poll-vote')
    expect(event?.vote.senderId).toBe(VOTER_PN)
    expect(event?.vote.options.map((o) => [o.name, o.voters])).toEqual([['One', []], ['Two', [VOTER_PN]]])
  })

  it('attributes a vote cast from the bot owner\'s phone (fromMe) to the bot itself', async () => {
    const h = await connect(BaileysProvider)
    const poll = await sendPoll(h, GROUP, 'Pick', ['A', 'B'])

    await h.emit(upsert([voteMessage(
      { remoteJid: GROUP, fromMe: true, participant: ME_LID },
      { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID },
      encryptVote(poll, ME_LID, ME_LID, ['A']),
    )]))

    const [event] = h.ofKind('poll-vote')
    expect(event?.vote.senderId).toBe(ME_PN)
    expect(event?.vote.options[0]).toEqual({ name: 'A', votes: 1, voters: [ME_PN] })
  })

  it('drops a vote for a poll it never saw (e.g. sent before a restart) without emitting anything', async () => {
    const h = await connect(BaileysProvider)
    const poll = await generatePoll(GROUP, 'Unknown', ['A', 'B'])

    await h.emit(upsert([voteMessage(
      { remoteJid: GROUP, participant: VOTER_LID },
      { remoteJid: GROUP, fromMe: true, id: poll.key.id },
      encryptVote(poll, ME_LID, VOTER_LID, ['A']),
    )]))

    expect(h.events).toHaveLength(0)
  })

  it('drops a vote that does not decrypt and logs a warning without JIDs or content', async () => {
    const lines: Array<Record<string, unknown>> = []
    const logger = pino({ level: 'debug' }, { write: (s: string) => { lines.push(JSON.parse(s)) } })
    const h = await connect(BaileysProvider, { logger })
    const poll = await sendPoll(h, GROUP, 'Pick', ['A', 'B'])
    const forged = await generatePoll(GROUP, 'Other secret', ['A', 'B'])
    forged.key.id = poll.key.id

    await h.emit(upsert([voteMessage(
      { remoteJid: GROUP, participant: VOTER_LID },
      { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID },
      encryptVote(forged, ME_LID, VOTER_LID, ['A']),
    )]))

    expect(h.events).toHaveLength(0)
    const warn = lines.find((l) => String(l.msg).includes('poll vote'))
    expect(warn?.level).toBe(40)
    expect(warn?.pollId).toBe(poll.key.id)
    expect(JSON.stringify(warn)).not.toContain(VOTER_LID)
  })
})

describe('PollTracker', () => {
  it('is bounded: the oldest poll is evicted first', async () => {
    const tracker = new PollTracker(2)
    const polls = await Promise.all(['a', 'b', 'c'].map((q) => generatePoll(GROUP, q, ['1', '2'])))
    for (const p of polls) expect(tracker.remember(p)).toBe(true)

    expect(tracker.size).toBe(2)
    expect(tracker.get(polls[0]!.key.id!)).toBeUndefined()
    expect(tracker.get(polls[2]!.key.id!)?.options.map((o) => o.name)).toEqual(['1', '2'])
  })

  it('ignores messages that are not poll creations or lack a messageSecret', () => {
    const tracker = new PollTracker(10)
    const text = { key: { remoteJid: GROUP, id: 'T1' }, message: { conversation: 'hi' } } as unknown as WAMessage
    const noSecret = { key: { remoteJid: GROUP, id: 'P1' }, message: { pollCreationMessage: { name: 'q', options: [{ optionName: 'a' }] } } } as unknown as WAMessage
    expect(tracker.remember(text)).toBe(false)
    expect(tracker.remember(noSecret)).toBe(false)
    expect(tracker.size).toBe(0)
  })
})
