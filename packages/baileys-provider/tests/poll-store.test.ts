/**
 * Pluggable poll persistence. Votes can only be decrypted with the poll's
 * messageSecret, so without a persistent `pollStore` a restart forgets every
 * poll and its later votes are dropped. With one, a fresh provider (a restart)
 * loads the poll from the store on its first vote, decrypts it and keeps the
 * tally collected before the restart. The fake store below round-trips every
 * entry through JSON, like a database or Redis would.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys'
import type { PollStore, StoredPoll } from '../src/index.js'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  const { fakeMakeWASocket } = await import('./support/harness.js')
  return { ...actual, default: fakeMakeWASocket, makeCacheableSignalKeyStore: (keys: unknown) => keys }
})

const B = await import('@whiskeysockets/baileys')
const { BaileysProvider } = await import('../src/BaileysProvider.js')
const { connect, ME_LID, ME_PN } = await import('./support/harness.js')
type Harness = Awaited<ReturnType<typeof connect>>

const GROUP = '120363000000000000@g.us'
const VOTER_LID = '200000000000001@lid'
const VOTER_PN = '573001111111@s.whatsapp.net'
const VOTER2_LID = '200000000000002@lid'
const VOTER2_PN = '573002222222@s.whatsapp.net'
const USER_LID = '300000000000001@lid'
const USER_PN = '573003333333@s.whatsapp.net'

/** A persistent store fake: JSON in a Map that outlives the providers. */
class JsonPollStore implements PollStore {
  readonly data = new Map<string, string>()
  async get(id: string) { const raw = this.data.get(id); return raw ? JSON.parse(raw) as StoredPoll : undefined }
  async set(id: string, poll: StoredPoll) { this.data.set(id, JSON.stringify(poll)) }
  async delete(id: string) { this.data.delete(id) }
}

const generatePoll = (jid: string, name: string, values: string[]) =>
  B.generateWAMessage(jid, { poll: { name, values, selectableCount: 1 } }, {
    userJid: ME_PN,
    upload: (async () => { throw new Error('no upload in tests') }) as never,
  })

async function sendPoll(h: Harness, chatId: string, question: string, options: string[]) {
  h.sock.sendMessage.mockImplementationOnce(async (jid: string) => generatePoll(jid, question, options))
  return (await h.provider.send(chatId, { kind: 'poll', question, options })).raw as WAMessage
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

let seq = 0
const voteMessage = (
  key: Partial<WAMessageKey> & { remoteJid: string },
  pollKey: Partial<WAMessageKey>,
  vote: { encPayload: Uint8Array; encIv: Uint8Array },
  at = Date.now(),
): WAMessage => ({
  key: { fromMe: false, id: `PS-VOTE-${++seq}`, ...key },
  message: { pollUpdateMessage: { pollCreationMessageKey: pollKey, vote, senderTimestampMs: at } },
  messageTimestamp: Math.floor(at / 1000),
} as unknown as WAMessage)

const upsert = (messages: WAMessage[], type: 'notify' | 'append' = 'notify') => ({ 'messages.upsert': { type, messages } })
const by1 = { remoteJid: GROUP, participant: VOTER_LID, participantAlt: VOTER_PN }
const by2 = { remoteJid: GROUP, participant: VOTER2_LID, participantAlt: VOTER2_PN }

describe('pollStore: restart continuity', () => {
  it('decrypts a vote after a restart and keeps the tally collected before it', async () => {
    const store = new JsonPollStore()
    const before = await connect(BaileysProvider, { pollStore: store })
    const poll = await sendPoll(before, GROUP, 'Lunch?', ['Pizza', 'Sushi'])
    const pollKey = { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID }
    await before.emit(upsert([voteMessage(by1, pollKey, encryptVote(poll, ME_LID, VOTER_LID, ['Pizza']), 1000)]))
    expect(before.ofKind('poll-vote')).toHaveLength(1)

    const after = await connect(BaileysProvider, { pollStore: store }) // a new process: empty memory
    await after.emit(upsert([voteMessage(by2, pollKey, encryptVote(poll, ME_LID, VOTER2_LID, ['Sushi']), 1001)]))

    const [event] = after.ofKind('poll-vote')
    expect(event?.vote.senderId).toBe(VOTER2_PN)
    expect(event?.vote.ref.id).toBe(poll.key.id)
    expect(event?.vote.ref.chatId).toBe(GROUP)
    expect(event?.vote.options).toEqual([
      { name: 'Pizza', votes: 1, voters: [VOTER_PN] },
      { name: 'Sushi', votes: 1, voters: [VOTER2_PN] },
    ])
    // The rebuilt native is a poll creation message the provider can quote.
    const native = event?.vote.ref.native as WAMessage
    expect(native.key.id).toBe(poll.key.id)
    expect(native.message?.pollCreationMessage?.name).toBe('Lunch?')
  })

  it('works for a DM poll another user created, and persists a vote changed after the restart', async () => {
    const store = new JsonPollStore()
    const before = await connect(BaileysProvider, { pollStore: store })
    const poll = await generatePoll(USER_LID, 'Theirs', ['Yes', 'No'])
    poll.key = { remoteJid: USER_LID, remoteJidAlt: USER_PN, fromMe: false, id: poll.key.id } as WAMessageKey
    await before.emit(upsert([poll]))
    expect(store.data.has(poll.key.id!)).toBe(true)

    const pollKey = { remoteJid: USER_LID, fromMe: false, id: poll.key.id }
    const mine = { remoteJid: USER_LID, remoteJidAlt: USER_PN, fromMe: true }
    const after = await connect(BaileysProvider, { pollStore: store })
    await after.emit(upsert([voteMessage(mine, pollKey, encryptVote(poll, USER_PN, ME_PN, ['No']), 2000)]))
    expect(after.ofKind('poll-vote')[0]?.vote.options.map((o) => [o.name, o.voters])).toEqual([['Yes', []], ['No', [ME_PN]]])

    const third = await connect(BaileysProvider, { pollStore: store })
    await third.emit(upsert([voteMessage(mine, pollKey, encryptVote(poll, USER_PN, ME_PN, ['Yes']), 1500)]))
    expect(third.ofKind('poll-vote')).toHaveLength(0) // older than the persisted vote
  })

  it('stores only plain JSON data: chat and creator key, secret, option names and hashes, latest votes', async () => {
    const store = new JsonPollStore()
    const h = await connect(BaileysProvider, { pollStore: store })
    const poll = await sendPoll(h, GROUP, 'Pick', ['A', 'B'])
    const stored = JSON.parse(store.data.get(poll.key.id!)!) as StoredPoll
    expect(stored).toEqual({
      id: poll.key.id,
      key: { remoteJid: GROUP, fromMe: true },
      name: 'Pick',
      secret: Buffer.from(poll.message!.messageContextInfo!.messageSecret!).toString('base64'),
      options: [
        { name: 'A', hash: Buffer.from(B.sha256(Buffer.from('A'))).toString('hex') },
        { name: 'B', hash: Buffer.from(B.sha256(Buffer.from('B'))).toString('hex') },
      ],
      votes: [],
      timestamp: expect.any(Number),
    })
  })

  it('never lets a later poll reusing a stored id overwrite the stored poll', async () => {
    const store = new JsonPollStore()
    const before = await connect(BaileysProvider, { pollStore: store })
    const poll = await sendPoll(before, GROUP, 'Pick', ['A', 'B'])

    const after = await connect(BaileysProvider, { pollStore: store })
    const rival = await generatePoll(GROUP, 'Rival', ['A', 'B'])
    rival.key = { remoteJid: GROUP, fromMe: false, id: poll.key.id, participant: VOTER2_LID, participantAlt: VOTER2_PN } as WAMessageKey
    await after.emit(upsert([rival]))
    expect((JSON.parse(store.data.get(poll.key.id!)!) as StoredPoll).name).toBe('Pick')

    const pollKey = { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID }
    await after.emit(upsert([voteMessage(by1, pollKey, encryptVote(poll, ME_LID, VOTER_LID, ['B']))]))
    expect(after.ofKind('poll-vote')[0]?.vote.options.map((o) => o.votes)).toEqual([0, 1])
  })

  it('keeps the chat binding after a restart: a vote from another chat is dropped', async () => {
    const store = new JsonPollStore()
    const before = await connect(BaileysProvider, { pollStore: store })
    const poll = await sendPoll(before, GROUP, 'Pick', ['A', 'B'])

    const after = await connect(BaileysProvider, { pollStore: store })
    await after.emit(upsert([voteMessage(
      { remoteJid: USER_LID, remoteJidAlt: USER_PN },
      { remoteJid: USER_LID, fromMe: true, id: poll.key.id },
      encryptVote(poll, ME_LID, USER_LID, ['A']),
    )]))
    expect(after.events).toHaveLength(0)
  })

  it('keeps both votes when two votes for a stored poll are processed concurrently after a restart', async () => {
    // Baileys handles separate `messages.upsert` batches concurrently. Slow reads
    // make both votes miss the cache and load the poll at the same time; the
    // first write is slower than the second, so unordered saves would leave the
    // older snapshot in the store.
    class SlowStore extends JsonPollStore {
      setDelays: number[] = []
      override async get(id: string) { await new Promise((r) => setTimeout(r, 10)); return super.get(id) }
      override async set(id: string, poll: StoredPoll) {
        const snapshot = JSON.stringify(poll)
        await new Promise((r) => setTimeout(r, this.setDelays.shift() ?? 0))
        this.data.set(id, snapshot)
      }
    }
    const store = new SlowStore()
    const before = await connect(BaileysProvider, { pollStore: store })
    const poll = await sendPoll(before, GROUP, 'Lunch?', ['Pizza', 'Sushi'])
    const pollKey = { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID }

    const after = await connect(BaileysProvider, { pollStore: store })
    store.setDelays = [30, 0]
    await Promise.all([
      after.emit(upsert([voteMessage(by1, pollKey, encryptVote(poll, ME_LID, VOTER_LID, ['Pizza']), 1000)])),
      after.emit(upsert([voteMessage(by2, pollKey, encryptVote(poll, ME_LID, VOTER2_LID, ['Sushi']), 1001)])),
    ])

    const both = [{ name: 'Pizza', votes: 1, voters: [VOTER_PN] }, { name: 'Sushi', votes: 1, voters: [VOTER2_PN] }]
    expect(after.ofKind('poll-vote')).toHaveLength(2)
    expect(after.ofKind('poll-vote').at(-1)?.vote.options).toEqual(both)

    const third = await connect(BaileysProvider, { pollStore: store })
    const by3 = { remoteJid: GROUP, participant: USER_LID, participantAlt: USER_PN }
    await third.emit(upsert([voteMessage(by3, pollKey, encryptVote(poll, ME_LID, USER_LID, ['Pizza']), 1002)]))
    expect(third.ofKind('poll-vote')[0]?.vote.options.map((o) => o.voters)).toEqual([[VOTER_PN, USER_PN], [VOTER2_PN]])
  })

  it('deletes a malformed stored entry and drops the vote; a failing store never breaks sends or votes', async () => {
    const lines: Array<Record<string, unknown>> = []
    const logger = pino({ level: 'debug' }, { write: (s: string) => { lines.push(JSON.parse(s)) } })
    const store = new JsonPollStore()
    store.data.set('BROKEN', JSON.stringify({ id: 'BROKEN', key: { remoteJid: GROUP }, secret: 42, options: 'x' }))
    const h = await connect(BaileysProvider, { pollStore: store, logger })
    await h.emit(upsert([voteMessage(by1, { remoteJid: GROUP, fromMe: true, id: 'BROKEN' }, { encPayload: randomBytes(16), encIv: randomBytes(12) })]))
    expect(h.events).toHaveLength(0)
    expect(store.data.has('BROKEN')).toBe(false)

    const failing: PollStore = {
      get: async () => { throw new Error('db down') },
      set: async () => { throw new Error('db down') },
      delete: async () => { throw new Error('db down') },
    }
    const f = await connect(BaileysProvider, { pollStore: failing, logger })
    const poll = await sendPoll(f, GROUP, 'Pick', ['A', 'B']) // does not reject
    await f.emit(upsert([voteMessage(by1, { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID }, encryptVote(poll, ME_LID, VOTER_LID, ['A']))]))
    expect(f.ofKind('poll-vote')).toHaveLength(1) // the in-memory cache still works
    expect(lines.some((l) => l.level === 40 && String(l.msg).includes('poll store'))).toBe(true)
    expect(JSON.stringify(lines)).not.toContain(VOTER_LID)
  })

  it('without a pollStore, a restart still forgets the poll (bounded in-memory default)', async () => {
    const before = await connect(BaileysProvider)
    const poll = await sendPoll(before, GROUP, 'Pick', ['A', 'B'])
    const after = await connect(BaileysProvider)
    await after.emit(upsert([voteMessage(by1, { remoteJid: GROUP, fromMe: true, id: poll.key.id, participant: ME_LID }, encryptVote(poll, ME_LID, VOTER_LID, ['A']))]))
    expect(after.events).toHaveLength(0)
  })
})
