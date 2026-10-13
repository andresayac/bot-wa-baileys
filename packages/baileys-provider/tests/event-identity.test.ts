/**
 * Identity contract for the non-message events. Every user/chat id the
 * provider emits (reaction, poll-vote, group, call, presence) must go through
 * the same LID/PN canonicalisation as messages, so one person never shows up
 * as a LID on one event type and as a PN on another.
 *
 * Also pins the reactor fix: in Baileys' `messages.reaction`, `key` is the
 * REACTED-TO message and `reaction.key` is the reactor's own message key.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WAMessage } from '@whiskeysockets/baileys'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  const { fakeMakeWASocket } = await import('./support/harness.js')
  return { ...actual, default: fakeMakeWASocket, makeCacheableSignalKeyStore: (keys: unknown) => keys }
})

const { BaileysProvider } = await import('../src/BaileysProvider.js')
const { connect, ME_LID, ME_PN } = await import('./support/harness.js')

const GROUP = '120363000000000000@g.us'
const AUTHOR_LID = '400000000000001@lid'
const AUTHOR_PN = '573004444444@s.whatsapp.net'
const REACTOR_LID = '400000000000002@lid'
const REACTOR_PN = '573005555555@s.whatsapp.net'
const USER_LID = '300000000000001@lid'
const USER_PN = '573003333333@s.whatsapp.net'

const text = (key: Record<string, unknown>, body = 'hola'): WAMessage =>
  ({ key: { fromMe: false, id: `M-${Math.random()}`, ...key }, message: { conversation: body }, messageTimestamp: 1 } as unknown as WAMessage)

describe('messages.reaction', () => {
  it('reports the reactor (reaction.key), not the author of the reacted-to message, in a group', async () => {
    const h = await connect(BaileysProvider)
    await h.emit({
      'messages.reaction': [{
        key: { remoteJid: GROUP, fromMe: false, id: 'TARGET', participant: AUTHOR_LID },
        reaction: { key: { remoteJid: GROUP, fromMe: false, id: 'R1', participant: REACTOR_LID, participantAlt: REACTOR_PN }, text: '👍', senderTimestampMs: 1 },
      }],
    })

    const [event] = h.ofKind('reaction')
    expect(event?.reaction.senderId).toBe(REACTOR_PN)
    expect(event?.reaction.ref.id).toBe('TARGET')
    expect(event?.reaction.ref.chatId).toBe(GROUP)
    expect(event?.reaction.emoji).toBe('👍')
    expect(event?.reaction.removed).toBe(false)
  })

  it('canonicalises a DM reactor and chat from LID to PN, matching the ids of their messages', async () => {
    const h = await connect(BaileysProvider)
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [text({ remoteJid: USER_LID, remoteJidAlt: USER_PN })] } })
    const [msg] = h.ofKind('message')

    // Reaction to the bot's own message; the reactor arrives as a bare LID.
    await h.emit({
      'messages.reaction': [{
        key: { remoteJid: USER_LID, fromMe: true, id: 'OUT-1' },
        reaction: { key: { remoteJid: USER_LID, fromMe: false, id: 'R2' }, text: '' },
      }],
    })

    const [event] = h.ofKind('reaction')
    expect(event?.reaction.senderId).toBe(msg?.message.senderId)
    expect(event?.reaction.senderId).toBe(USER_PN)
    expect(event?.reaction.ref.chatId).toBe(msg?.message.chatId)
    expect(event?.reaction.removed).toBe(true)
  })

  it('resolves a bare-LID reactor through the signal LID mapping store', async () => {
    const h = await connect(BaileysProvider)
    h.sock.lidMap.set(REACTOR_LID, '573005555555:7@s.whatsapp.net')
    await h.emit({
      'messages.reaction': [{
        key: { remoteJid: GROUP, fromMe: false, id: 'TARGET', participant: AUTHOR_LID },
        reaction: { key: { remoteJid: GROUP, fromMe: false, id: 'R3', participant: REACTOR_LID }, text: '🔥' },
      }],
    })
    expect(h.ofKind('reaction')[0]?.reaction.senderId).toBe(REACTOR_PN)
  })

  it('attributes a reaction the bot owner sent from their phone to the bot', async () => {
    const h = await connect(BaileysProvider)
    await h.emit({
      'messages.reaction': [{
        key: { remoteJid: GROUP, fromMe: false, id: 'TARGET', participant: AUTHOR_LID },
        reaction: { key: { remoteJid: GROUP, fromMe: true, id: 'R4', participant: ME_LID }, text: '❤️' },
      }],
    })
    expect(h.ofKind('reaction')[0]?.reaction.senderId).toBe(ME_PN)
  })
})

describe('group-participants.update', () => {
  it('emits canonical participant ids (Baileys 7 sends participant objects) and the canonical actor', async () => {
    const h = await connect(BaileysProvider)
    await h.emit({
      'group-participants.update': {
        id: GROUP,
        author: AUTHOR_LID,
        authorPn: AUTHOR_PN,
        participants: [
          { id: REACTOR_LID, phoneNumber: REACTOR_PN, admin: null },
          { id: USER_PN, lid: USER_LID, admin: null },
        ],
        action: 'add',
      },
    })

    const [event] = h.ofKind('group')
    expect(event?.event).toEqual({ chatId: GROUP, action: 'add', participants: [REACTOR_PN, USER_PN], actor: AUTHOR_PN })
  })

  it('canonicalises plain-string participants with a learned mapping and maps `modify` to `update`', async () => {
    const h = await connect(BaileysProvider)
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [text({ remoteJid: GROUP, participant: USER_LID, participantAlt: USER_PN })] } })

    await h.emit({ 'group-participants.update': { id: GROUP, author: USER_LID, participants: [USER_LID], action: 'modify' } })

    const [event] = h.ofKind('group')
    expect(event?.event).toEqual({ chatId: GROUP, action: 'update', participants: [USER_PN], actor: USER_PN })
  })
})

describe('call', () => {
  it('emits the caller as the canonical PN when Baileys provides callerPn', async () => {
    const h = await connect(BaileysProvider)
    await h.emit({ call: [{ id: 'C1', chatId: USER_LID, from: USER_LID, callerPn: USER_PN, date: new Date(), offline: false, status: 'offer' }] })
    expect(h.ofKind('call')[0]?.event).toEqual({ id: 'C1', from: USER_PN, status: 'offer' })
  })

  it('canonicalises a device-qualified LID caller with a learned mapping', async () => {
    const h = await connect(BaileysProvider)
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [text({ remoteJid: USER_LID, remoteJidAlt: USER_PN })] } })
    await h.emit({ call: [{ id: 'C2', chatId: USER_LID, from: '300000000000001:3@lid', date: new Date(), offline: false, status: 'terminate' }] })
    expect(h.ofKind('call')[0]?.event.from).toBe(USER_PN)
  })
})

describe('presence.update', () => {
  it('canonicalises the DM chat id and the presence keys', async () => {
    const h = await connect(BaileysProvider)
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [text({ remoteJid: USER_LID, remoteJidAlt: USER_PN })] } })

    await h.emit({ 'presence.update': { id: USER_LID, presences: { [USER_LID]: { lastKnownPresence: 'composing' } } } })

    expect(h.ofKind('presence')[0]?.event).toEqual({ chatId: USER_PN, presences: { [USER_PN]: { lastKnownPresence: 'composing' } } })
  })

  it('keeps the group as chat id and canonicalises participant keys through the mapping store', async () => {
    const h = await connect(BaileysProvider)
    h.sock.lidMap.set(REACTOR_LID, '573005555555:2@s.whatsapp.net')
    await h.emit({ 'presence.update': { id: GROUP, presences: { [REACTOR_LID]: { lastKnownPresence: 'recording' } } } })
    expect(h.ofKind('presence')[0]?.event).toEqual({ chatId: GROUP, presences: { [REACTOR_PN]: { lastKnownPresence: 'recording' } } })
  })
})
