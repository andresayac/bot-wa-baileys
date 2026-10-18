/**
 * The identity stability contract (`@bot-wa/core/testing`) against the real
 * Evolution ingest path, with recorded webhooks whose identity flips PN → LID.
 */
import { describe, it, expect } from 'vitest'
import { assertStableIdentity, checkIdentityContract, recordEvents } from '@bot-wa/core/testing'
import { EvolutionProvider } from '../src/EvolutionProvider.js'
import { parseWebhook } from '../src/parseInbound.js'
import { WaIdentityStore } from '../src/identity.js'
import { fixture } from './support/fake.js'

const PN = '573001112233@s.whatsapp.net'
const GROUP = '120363041234567890@g.us'
const SECRET = 's3cret'

const provider = () => new EvolutionProvider({ baseUrl: 'http://localhost:8080', apiKey: 'k', instance: 'my-instance', webhookSecret: SECRET })
const H = { 'x-webhook-secret': SECRET }

describe('Evolution ingest — identity stability contract', () => {
  it('a DM arriving as PN, then LID+senderPn, then LID-only stays one human', () => {
    const p = provider()
    const rec = recordEvents(p)
    for (const f of ['messages-upsert-text-dm', 'messages-upsert-lid-senderpn', 'messages-upsert-lid-only']) {
      expect(p.ingest(JSON.stringify(fixture(f)), H)).toBe(200)
    }
    assertStableIdentity(rec.messages(), { andres: { events: [0, 1, 2], senderId: PN, chatId: PN, kind: 'dm' } })
  })

  it('a group participant flipping LID+alt → LID-only keeps one senderId, the same as in the DM', () => {
    const p = provider()
    const rec = recordEvents(p)
    for (const f of ['messages-upsert-group-image', 'messages-upsert-group-lid-only', 'messages-upsert-lid-only']) p.ingest(fixture(f), H)
    const msgs = rec.messages()
    expect(msgs).toHaveLength(3)
    assertStableIdentity(msgs.slice(0, 2), { andres: { events: [0, 1], senderId: PN, chatId: GROUP, kind: 'group' } })
    assertStableIdentity(msgs, { andres: { events: [0, 1, 2], senderId: PN } })
  })

  it('the helper catches the split when aliases are never linked', () => {
    const events = [
      ...parseWebhook(fixture('messages-upsert-text-dm'), { identity: new WaIdentityStore() }),
      ...parseWebhook(fixture('messages-upsert-lid-only'), { identity: new WaIdentityStore() }),
    ]
    const rules = checkIdentityContract(events, { andres: [0, 1] }).map((v) => v.rule)
    expect(rules).toEqual(expect.arrayContaining(['unstable-sender', 'unstable-chat']))
  })
})
