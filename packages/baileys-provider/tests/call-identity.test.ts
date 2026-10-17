/**
 * Call events must carry the caller's CANONICAL identity — the same id their
 * messages carry — or a `flow(CALL).ask(...)` registers its conversation under a
 * LID key while the caller's text answer arrives keyed by the PN (stuck ask).
 * They must also say which chat the call belongs to (the group, for a group
 * call, across all of its status updates).
 *
 * In Baileys 7 a call's `from` is `infoChild.attrs.from || call-creator`: often a
 * (device-qualified) LID, with the PN twin in `callerPn` only sometimes.
 */
import { describe, it, expect, vi } from 'vitest'
import type { WACallEvent, WAMessage } from '@whiskeysockets/baileys'
import { connect, fakeMakeWASocket } from './support/harness.js'
import { toCallEvent } from '../src/toCallEvent.js'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  return { ...actual, default: fakeMakeWASocket, makeCacheableSignalKeyStore: (keys: unknown) => keys }
})

const { BaileysProvider } = await import('../src/BaileysProvider.js')

const LID = '300000000000001@lid'
const PN = '573003333333@s.whatsapp.net'
const GROUP = '120363000000000000@g.us'

const call = (over: Partial<WACallEvent>): WACallEvent =>
  ({ id: 'C1', chatId: LID, from: LID, date: new Date(0), offline: false, status: 'offer', ...over } as WACallEvent)

const dm = (key: Record<string, unknown>, body = 'hola'): WAMessage =>
  ({ key: { fromMe: false, id: `M-${Math.random()}`, ...key }, message: { conversation: body }, messageTimestamp: 1 } as unknown as WAMessage)

async function harness() {
  const h = await connect(BaileysProvider)
  return {
    ...h,
    calls: () => h.ofKind('call').map((e) => e.event),
    messages: () => h.ofKind('message').map((e) => e.message),
  }
}

describe('toCallEvent (unit)', () => {
  it('a 1:1 call is the DM with the caller; isVideo/offline pass through', () => {
    const event = toCallEvent(call({ isVideo: true, offline: true }), PN, undefined, new Map())
    expect(event).toEqual({ id: 'C1', from: PN, status: 'offer', chatId: PN, isGroup: false, isVideo: true, offline: true })
  })

  it('a group call belongs to the group, also on later updates that no longer carry groupJid', () => {
    const groups = new Map<string, string>()
    const offer = toCallEvent(call({ isGroup: true, groupJid: GROUP }), PN, GROUP, groups)
    expect(offer).toMatchObject({ from: PN, chatId: GROUP, isGroup: true })
    // Baileys copies isGroup from its offer cache but not groupJid.
    const ended = toCallEvent(call({ status: 'terminate', isGroup: true }), PN, undefined, groups)
    expect(ended).toMatchObject({ from: PN, chatId: GROUP, isGroup: true })
    expect(groups.size).toBe(0) // forgotten once the call ended
  })

  it('a group call whose group is unknown falls back to the DM with the caller', () => {
    const event = toCallEvent(call({ isGroup: true, status: 'terminate' }), PN, undefined, new Map())
    expect(event).toMatchObject({ chatId: PN, isGroup: false })
  })
})

describe('BaileysProvider — call events', () => {
  it('emits the caller as the PN their messages carry (callerPn present)', async () => {
    const h = await harness()
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [dm({ remoteJid: PN })] } })
    await h.emit({ call: [call({ from: '300000000000001:2@lid', callerPn: PN })] })
    expect(h.calls()[0]?.from).toBe(h.messages()[0]?.senderId)
    expect(h.calls()[0]).toMatchObject({ id: 'C1', from: PN, chatId: PN, isGroup: false, status: 'offer' })
  })

  it('canonicalises a device-qualified LID caller with a learned mapping (same id as their messages)', async () => {
    const h = await harness()
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [dm({ remoteJid: LID, remoteJidAlt: PN })] } })
    await h.emit({ call: [call({ from: '300000000000001:3@lid', status: 'terminate' })] })
    expect(h.calls()[0]?.from).toBe(h.messages()[0]?.senderId)
    expect(h.calls()[0]?.from).toBe(PN)
  })

  it('resolves a bare-LID caller through the LID mapping store (no callerPn, nothing learned yet)', async () => {
    const h = await harness()
    h.sock.lidMap.set(LID, '573003333333:4@s.whatsapp.net')
    await h.emit({ call: [call({ from: '300000000000001:4@lid' })] })
    expect(h.calls()[0]?.from).toBe(PN)
    // …and a later bare-LID message from the same person lands on the same id.
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [dm({ remoteJid: LID })] } })
    expect(h.messages()[0]?.chatId).toBe(PN)
  })

  it('normalises a device-qualified caller even when no PN is known', async () => {
    const h = await harness()
    await h.emit({ call: [call({ id: 'A', from: '300000000000001:3@lid' })] })
    await h.emit({ call: [call({ id: 'B', from: '573003333333:5@s.whatsapp.net' })] })
    expect(h.calls().map((e) => e.from)).toEqual([LID, PN])
  })

  it('projects a group call into the group across its updates', async () => {
    const h = await harness()
    await h.emit({ call: [call({ id: 'G1', callerPn: PN, isGroup: true, groupJid: GROUP })] })
    await h.emit({ call: [call({ id: 'G1', status: 'terminate', isGroup: true })] })
    expect(h.calls().map((e) => [e.status, e.chatId, e.isGroup, e.from])).toEqual([
      ['offer', GROUP, true, PN],
      ['terminate', GROUP, true, PN],
    ])
  })
})
