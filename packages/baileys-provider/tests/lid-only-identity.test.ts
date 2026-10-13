/**
 * WhatsApp usernames (2026): a contact who chats through a username may only
 * ever reach us as an opaque `@lid`, with no phone-number (PN) twin and no
 * LID->PN mapping in the signal store. The identity contract still holds: the
 * same person must produce the same `chatId`/`senderId` on every message, and
 * outbound sends must reach them on the LID.
 *
 * Residual behaviour (documented in the README): if a PN mapping is learned
 * LATER (a message arrives with `remoteJidAlt`, or a `lid-mapping.update`),
 * canonicalisation switches that person to the PN from then on. A conversation
 * that started under the LID is keyed by the LID and will not see later
 * messages, which are keyed by the PN.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WAMessage } from '@whiskeysockets/baileys'
import { BaileysProvider } from '../src/BaileysProvider.js'
import { IdentityStore } from '../src/identity.js'
import { toInbound } from '../src/toInbound.js'

const LID = '123456789012345@lid'
const PN = '573001112233@s.whatsapp.net'
const GROUP = '120363000000000000@g.us'

const msg = (key: Record<string, unknown>, id: string, body = 'hola'): WAMessage =>
  ({ key: { fromMe: false, id, ...key }, message: { conversation: body }, messageTimestamp: 1 } as unknown as WAMessage)

type Internals = { sock: unknown }

function providerWithMapping(getPNForLID: (lid: string) => Promise<string | null>) {
  const p = new BaileysProvider({ session: 'lid-only', rateLimit: { enabled: false } })
  const sock = {
    signalRepository: { lidMapping: { getPNForLID: vi.fn(getPNForLID) } },
    sendMessage: vi.fn(async (jid: string) => ({ key: { id: 'out-1', remoteJid: jid } })),
  }
  ;(p as unknown as Internals).sock = sock
  return { p, sock }
}

describe('LID-only contacts (no PN mapping)', () => {
  it('DM: chatId and senderId stay on the same LID across messages', () => {
    const identity = new IdentityStore()
    const events = [
      toInbound(msg({ remoteJid: LID }, 'm1'), identity),
      toInbound(msg({ remoteJid: LID }, 'm2'), identity),
      toInbound(msg({ remoteJid: '123456789012345:7@lid' }, 'm3'), identity), // other device of the same user
    ]
    for (const e of events) {
      expect(e.chatId).toBe(LID)
      expect(e.senderId).toBe(LID)
      expect(e.chat.kind).toBe('dm')
      expect(e.senderInfo.platformData).toEqual({ phoneNumber: undefined, lid: expect.stringMatching(/@lid$/) })
    }
  })

  it('group: senderId stays on the participant LID; chatId is the group', () => {
    const identity = new IdentityStore()
    const a = toInbound(msg({ remoteJid: GROUP, participant: LID }, 'g1'), identity)
    const b = toInbound(msg({ remoteJid: GROUP, participant: LID }, 'g2'), identity)
    expect([a.chatId, b.chatId]).toEqual([GROUP, GROUP])
    expect([a.senderId, b.senderId]).toEqual([LID, LID])
  })

  it('provider: an unmapped LID resolves to nothing and is sent to as-is', async () => {
    const { p, sock } = providerWithMapping(async () => null)
    expect(await p.getPNForLID(LID)).toBeUndefined()

    const res = await p.send(LID, { kind: 'text', text: 'hola' })

    expect(sock.sendMessage).toHaveBeenCalledWith(LID, { text: 'hola' }, {})
    expect(res.ref.chatId).toBe(LID)
  })

  it('provider: a lookup failure is treated as "no mapping", not as a send failure', async () => {
    const { p, sock } = providerWithMapping(async () => { throw new Error('store unavailable') })
    await p.send(LID, { kind: 'text', text: 'hola' })
    expect(sock.sendMessage).toHaveBeenCalledWith(LID, { text: 'hola' }, {})
  })

  it('provider: a device-qualified PN from the mapping store is normalised to the user JID', async () => {
    // Baileys 7 lidMapping.getPNForLID returns `<user>:<device>@s.whatsapp.net`.
    const { p, sock } = providerWithMapping(async () => '573001112233:0@s.whatsapp.net')
    expect(await p.getPNForLID(LID)).toBe(PN)
    await p.send(LID, { kind: 'text', text: 'hola' })
    expect(sock.sendMessage).toHaveBeenCalledWith(PN, { text: 'hola' }, {})
  })
})

describe('residual behaviour: a PN mapping learned mid-conversation', () => {
  it('switches the canonical id from the LID to the PN once the twin is seen', () => {
    const identity = new IdentityStore()
    const before = toInbound(msg({ remoteJid: LID }, 'm1'), identity)
    const reveal = toInbound(msg({ remoteJid: LID, remoteJidAlt: PN }, 'm2'), identity)
    const after = toInbound(msg({ remoteJid: LID }, 'm3'), identity)

    expect(before.chatId).toBe(LID) // conversation started here is keyed by the LID
    expect(reveal.chatId).toBe(PN) // ...and from now on the same person is keyed by the PN
    expect(after.chatId).toBe(PN)
  })
})
