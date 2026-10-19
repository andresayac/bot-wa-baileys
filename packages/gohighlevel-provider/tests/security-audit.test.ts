import { describe, expect, it } from 'vitest'
import type { InboundEvent } from '@bot-wa/core'
import { GoHighLevelProvider } from '../src/GoHighLevelProvider.js'
import { fakeHttp } from './support.js'
import { keys, LOCATION, SMS_INBOUND } from './fixtures.js'

const K = keys()

describe('GoHighLevelProvider — cross-location replay', () => {
  it('ignores a validly signed InboundMessage that carries no locationId', () => {
    // HighLevel signs every app's webhooks with ONE platform key, so a body
    // signed for somebody else's location verifies here too: only the
    // locationId binds it to this bot.
    const { http } = fakeHttp(() => ({ json: {} }))
    const provider = new GoHighLevelProvider({ accessToken: 't', locationId: LOCATION, publicKey: K.publicKey, http })
    const events: InboundEvent[] = []
    provider.onEvent((e) => { events.push(e) })
    const { locationId: _drop, ...noLocation } = SMS_INBOUND
    const raw = JSON.stringify(noLocation)
    expect(provider.ingest(Buffer.from(raw), { 'x-ghl-signature': K.signEd(raw) })).toBe(200)
    expect(events.filter((e) => e.kind === 'message')).toHaveLength(0)
  })
})
