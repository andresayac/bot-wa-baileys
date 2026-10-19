/**
 * The identity stability contract (`@bot-wa/core/testing`) against the real
 * WPPConnect ingest path: recorded webhooks whose sender flips PN → LID, with
 * the `contact/pn-lid` lookup served by a fake fetch.
 */
import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { assertStableIdentity, checkIdentityContract, recordEvents } from '@bot-wa/core/testing'
import { WPPConnectProvider } from '../src/WPPConnectProvider.js'
import { parseWebhook } from '../src/parseInbound.js'
import { WaIdentityStore } from '@bot-wa/wa-gateway-kit'
import { fakeFetch, fixture, resolver } from './support/fake.js'

const PN = '573001112233@c.us'
const GROUP = '120363041234567890@g.us'

function provider(opts: { resolveLid?: boolean } = {}) {
  const { fetch, calls } = fakeFetch((c) => c.url.includes('/contact/pn-lid/184523390222111')
    ? { body: fixture('pn-lid-response') }
    : { status: 500, body: { status: 'error', message: 'Error on get contact by PN-LID' } })
  const p = new WPPConnectProvider({
    session: 'my-bot', token: 'T', webhookToken: 'wh', http: { fetch, resolver }, logger: pino({ level: 'silent' }), ...opts,
  })
  return { p, calls }
}
const H = { 'x-webhook-token': 'wh' }

describe('WPPConnect ingest — identity stability contract', () => {
  it('a DM arriving as PN, then as a bare LID, stays one human (LID resolved via contact/pn-lid)', async () => {
    const { p, calls } = provider()
    const rec = recordEvents(p)
    expect(await p.ingest(fixture('onmessage-text-dm'), H)).toBe(200)
    expect(await p.ingest(JSON.stringify(fixture('onmessage-lid-dm')), H)).toBe(200)
    assertStableIdentity(rec.messages(), { andres: { events: [0, 1], senderId: PN, chatId: PN, kind: 'dm' } })
    expect(calls.filter((c) => c.url.includes('pn-lid'))).toHaveLength(1)
  })

  it('a LID-first contact keeps one id across group and DM', async () => {
    const { p } = provider()
    const rec = recordEvents(p)
    await p.ingest(fixture('onmessage-group-image'), H)
    await p.ingest(fixture('onmessage-lid-dm'), H)
    await p.ingest(fixture('onmessage-lid-dm-with-pn'), H)
    const msgs = rec.messages()
    assertStableIdentity([msgs[0]], { andres: { events: [0], senderId: PN, chatId: GROUP, kind: 'group' } })
    assertStableIdentity(msgs, { andres: { events: [0, 1, 2], senderId: PN } })
  })

  it('without pn-lid resolution, sender.phoneNumber still links the LID (first-seen id kept)', async () => {
    const { p } = provider({ resolveLid: false })
    const rec = recordEvents(p)
    await p.ingest(fixture('onmessage-lid-dm-with-pn'), H)
    await p.ingest(fixture('onmessage-lid-dm'), H)
    await p.ingest(fixture('onmessage-text-dm'), H)
    assertStableIdentity(rec.messages(), { andres: { events: [0, 1, 2], senderId: PN, chatId: PN } })
  })

  it('the helper catches the split when aliases are never linked', () => {
    const events = [
      ...parseWebhook(fixture('onmessage-text-dm'), { identity: new WaIdentityStore() }),
      ...parseWebhook(fixture('onmessage-lid-dm'), { identity: new WaIdentityStore() }),
    ]
    const rules = checkIdentityContract(events, { andres: [0, 1] }).map((v) => v.rule)
    expect(rules).toEqual(expect.arrayContaining(['unstable-sender', 'unstable-chat']))
  })
})
