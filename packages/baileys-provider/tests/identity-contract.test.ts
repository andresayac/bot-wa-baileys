/**
 * The identity stability contract, checked with the reusable helper from
 * `@bot-wa/core/testing` against this provider's real normalization path.
 */
import { describe, it, expect } from 'vitest'
import { assertStableIdentity, checkIdentityContract } from '@bot-wa/core/testing'
import type { WAMessage } from '@whiskeysockets/baileys'
import { IdentityStore } from '../src/identity.js'
import { toInbound } from '../src/toInbound.js'

const PN = '573002782284@s.whatsapp.net'
const LID = '111111111111111@lid'
const GROUP = '120363000000000000@g.us'

const dm = (o: { remoteJid: string; remoteJidAlt?: string; id: string }): WAMessage =>
  ({
    key: { remoteJid: o.remoteJid, remoteJidAlt: o.remoteJidAlt, fromMe: false, id: o.id },
    message: { conversation: 'hola' },
    messageTimestamp: 1,
  } as unknown as WAMessage)

const groupMsg = (o: { participant: string; participantAlt?: string; id: string }): WAMessage =>
  ({
    key: { remoteJid: GROUP, participant: o.participant, participantAlt: o.participantAlt, fromMe: false, id: o.id },
    message: { conversation: 'hola' },
    messageTimestamp: 1,
  } as unknown as WAMessage)

describe('Baileys toInbound — identity stability contract', () => {
  it('a DM whose wire identity flips LID → LID-only → PN stays one human', () => {
    const identity = new IdentityStore()
    const events = [
      toInbound(dm({ remoteJid: LID, remoteJidAlt: PN, id: 'm1' }), identity),
      toInbound(dm({ remoteJid: LID, id: 'm2' }), identity), // PN twin missing on the wire
      toInbound(dm({ remoteJid: PN, id: 'm3' }), identity),
    ]
    assertStableIdentity(events, { andres: { events: [0, 1, 2], senderId: PN, chatId: PN, kind: 'dm' } })
  })

  it('a group participant flipping LID/PN keeps one senderId inside one group chat', () => {
    const identity = new IdentityStore()
    const events = [
      toInbound(groupMsg({ participant: LID, participantAlt: PN, id: 'g1' }), identity),
      toInbound(groupMsg({ participant: LID, id: 'g2' }), identity),
      toInbound(groupMsg({ participant: PN, id: 'g3' }), identity),
    ]
    assertStableIdentity(events, { andres: { events: [0, 1, 2], senderId: PN, chatId: GROUP, kind: 'group' } })
  })

  it('the helper does catch the historical bug when the alias is never learned', () => {
    // A fresh store per message = no LID↔PN memory: exactly the "flujos tienen líos" bug.
    const events = [
      toInbound(dm({ remoteJid: PN, id: 'm1' }), new IdentityStore()),
      toInbound(dm({ remoteJid: LID, id: 'm2' }), new IdentityStore()),
    ]
    const rules = checkIdentityContract(events, { andres: [0, 1] }).map((v) => v.rule)
    expect(rules).toEqual(expect.arrayContaining(['unstable-sender', 'unstable-chat']))
  })
})
