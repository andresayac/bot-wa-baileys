/**
 * Call events must carry the caller's CANONICAL identity — the same id their
 * messages carry — or a `flow(CALL).ask(...)` registers its conversation under a
 * LID key while the caller's text answer arrives keyed by the PN (stuck ask).
 *
 * In Baileys 7 a call's `from` is `infoChild.attrs.from || call-creator`: often a
 * (device-qualified) LID, with the PN twin in `callerPn` only sometimes.
 */
import { describe, it, expect, vi } from 'vitest'
import type { WACallEvent, WAMessage } from '@whiskeysockets/baileys'
import type { InboundEvent } from '@bot-wa/core'
import { IdentityStore } from '../src/identity.js'
import { toInbound } from '../src/toInbound.js'
import { toCallEvent } from '../src/toCallEvent.js'

type ProcessHandler = (events: Record<string, unknown>) => Promise<void>
interface FakeSocket {
  ev: { process: (handler: ProcessHandler) => void }
  end: () => void
  signalRepository: { lidMapping: { getPNForLID: ReturnType<typeof vi.fn> } }
  handler?: ProcessHandler
}
const sockets: FakeSocket[] = []
/** LID → device-qualified PN answers of the fake `lidMapping.getPNForLID`. */
const lidMapping = new Map<string, string>()

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  const fakeMakeWASocket = (): FakeSocket => {
    const sock: FakeSocket = {
      ev: { process: (handler) => { sock.handler = handler } },
      end: () => {},
      signalRepository: { lidMapping: { getPNForLID: vi.fn(async (lid: string) => lidMapping.get(lid) ?? null) } },
    }
    sockets.push(sock)
    return sock
  }
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

/** A BaileysProvider on a fake socket: push raw Baileys event maps through its real `ev.process`. */
async function connect() {
  const provider = new BaileysProvider({ session: 'call-identity', rateLimit: { enabled: false }, qr: { terminal: false } })
  const internals = provider as unknown as { authState: unknown; version: [number, number, number]; buildSocket(): Promise<void> }
  internals.authState = { state: { creds: { me: { id: '573000000000:12@s.whatsapp.net' }, registered: true }, keys: {} }, saveCreds: async () => {} }
  internals.version = [2, 3000, 1]
  await internals.buildSocket()
  const sock = sockets.at(-1)!
  const events: InboundEvent[] = []
  provider.onEvent((e) => { events.push(e) })
  return {
    emit: async (map: Record<string, unknown>) => { await sock.handler!(map) },
    calls: () => events.flatMap((e) => (e.kind === 'call' ? [e.event] : [])),
    messages: () => events.flatMap((e) => (e.kind === 'message' ? [e.message] : [])),
  }
}

describe('toCallEvent (unit)', () => {
  it('prefers the PN twin (callerPn) and learns the LID↔PN pairing from it', () => {
    const identity = new IdentityStore()
    const event = toCallEvent(call({ from: '300000000000001:7@lid', callerPn: '573003333333:7@s.whatsapp.net' }), identity, new Map())
    expect(event.from).toBe(PN)
    expect(identity.canonical(LID)).toBe(PN)
  })

  it('canonicalises a device-qualified LID caller with a learned mapping (same id as their messages)', () => {
    const identity = new IdentityStore()
    const message = toInbound(dm({ remoteJid: LID, remoteJidAlt: PN }), identity)
    const event = toCallEvent(call({ from: '300000000000001:3@lid', status: 'terminate' }), identity, new Map())
    expect(event.from).toBe(message.senderId)
    expect(event.from).toBe(PN)
  })

  it('normalises a device-qualified caller even when no PN is known', () => {
    expect(toCallEvent(call({ from: '300000000000001:3@lid' }), new IdentityStore(), new Map()).from).toBe(LID)
    expect(toCallEvent(call({ from: '573003333333:5@s.whatsapp.net' }), new IdentityStore(), new Map()).from).toBe(PN)
  })

  it('a 1:1 call is the DM with the caller; isVideo/offline pass through', () => {
    const event = toCallEvent(call({ callerPn: PN, isVideo: true, offline: true }), new IdentityStore(), new Map())
    expect(event).toEqual({ id: 'C1', from: PN, status: 'offer', chatId: PN, isGroup: false, isVideo: true, offline: true })
  })

  it('a group call belongs to the group, also on later updates that no longer carry groupJid', () => {
    const identity = new IdentityStore()
    const groups = new Map<string, string>()
    const offer = toCallEvent(call({ callerPn: PN, isGroup: true, groupJid: GROUP }), identity, groups)
    expect(offer).toMatchObject({ from: PN, chatId: GROUP, isGroup: true })
    // Baileys copies isGroup from its offer cache but not groupJid.
    const ended = toCallEvent(call({ status: 'terminate', isGroup: true }), identity, groups)
    expect(ended).toMatchObject({ from: PN, chatId: GROUP, isGroup: true })
    expect(groups.size).toBe(0) // forgotten once the call ended
  })

  it('a group call whose group is unknown falls back to the DM with the caller', () => {
    const event = toCallEvent(call({ callerPn: PN, isGroup: true, status: 'terminate' }), new IdentityStore(), new Map())
    expect(event).toMatchObject({ chatId: PN, isGroup: false })
  })
})

describe('BaileysProvider — call events', () => {
  it('emits the caller as the PN their messages carry (callerPn present)', async () => {
    const h = await connect()
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [dm({ remoteJid: PN })] } })
    await h.emit({ call: [call({ from: '300000000000001:2@lid', callerPn: PN })] })
    expect(h.calls()[0]?.from).toBe(h.messages()[0]?.senderId)
    expect(h.calls()[0]).toMatchObject({ id: 'C1', from: PN, chatId: PN, isGroup: false, status: 'offer' })
  })

  it('resolves a bare-LID caller through the LID mapping store (no callerPn, nothing learned yet)', async () => {
    lidMapping.set(LID, '573003333333:4@s.whatsapp.net')
    const h = await connect()
    await h.emit({ call: [call({ from: '300000000000001:4@lid' })] })
    expect(h.calls()[0]?.from).toBe(PN)
    // …and a later bare-LID message from the same person lands on the same id.
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [dm({ remoteJid: LID })] } })
    expect(h.messages()[0]?.chatId).toBe(PN)
    lidMapping.clear()
  })

  it('projects a group call into the group across its updates', async () => {
    const h = await connect()
    await h.emit({ call: [call({ id: 'G1', callerPn: PN, isGroup: true, groupJid: GROUP })] })
    await h.emit({ call: [call({ id: 'G1', status: 'terminate', isGroup: true })] })
    expect(h.calls().map((e) => [e.status, e.chatId, e.isGroup, e.from])).toEqual([
      ['offer', GROUP, true, PN],
      ['terminate', GROUP, true, PN],
    ])
  })
})
