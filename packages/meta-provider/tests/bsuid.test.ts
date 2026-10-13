/**
 * WhatsApp usernames / business-scoped user IDs (BSUID).
 *
 * Since April 2026 Cloud API webhooks carry the BSUID (`from_user_id`,
 * `contacts[].user_id`, `recipient_user_id`). When a user enables a username,
 * the phone number (`from` / `wa_id`) is omitted unless the business interacted
 * with them in the last 30 days or has them in its contact book. These tests pin
 * the identity contract: the same human keeps the same chatId/senderId.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { InboundEvent } from '@bot-wa/core'
import type { Logger } from 'pino'
import { parseInbound, type GraphWebhookBody } from '../src/parseInbound.js'
import { CloudAPIProvider } from '../src/CloudAPIProvider.js'
import { MemoryIdentityMap, isBsuid, type IdentityMap } from '../src/identity.js'

const PHONE = '16505551234'
const BSUID = 'US.13491208655302741918'
const PARENT = 'US.ENT.11815799212886844830'
const USERNAME = 'sheena_nelson'

/* --- Realistic webhook fixtures (shape from the Meta webhook reference) --- */

function webhook(value: Record<string, unknown>, field = 'messages'): GraphWebhookBody {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '102290129340398',
      changes: [{
        field,
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
          ...value,
        },
      }],
    }],
  } as GraphWebhookBody
}

interface Who { phone?: string; bsuid?: string; parent?: string; username?: string; name?: string }

function contactOf(who: Who): Record<string, unknown> {
  return {
    profile: { name: who.name ?? 'Sheena Nelson', ...(who.username ? { username: who.username } : {}) },
    ...(who.phone ? { wa_id: who.phone } : {}),
    ...(who.bsuid ? { user_id: who.bsuid } : {}),
    ...(who.parent ? { parent_user_id: who.parent } : {}),
  }
}

function senderFields(who: Who): Record<string, unknown> {
  return {
    ...(who.phone ? { from: who.phone } : {}),
    ...(who.bsuid ? { from_user_id: who.bsuid } : {}),
    ...(who.parent ? { from_parent_user_id: who.parent } : {}),
  }
}

function textWebhook(who: Who, id: string, body: string): GraphWebhookBody {
  return webhook({
    contacts: [contactOf(who)],
    messages: [{ ...senderFields(who), id, timestamp: '1749416383', type: 'text', text: { body } }],
  })
}

function statusWebhook(status: Record<string, unknown>, contacts?: Who[]): GraphWebhookBody {
  return webhook({
    ...(contacts ? { contacts: contacts.map(contactOf) } : {}),
    statuses: [{ timestamp: '1749416400', conversation: { id: 'c1' }, pricing: { billable: true }, ...status }],
  })
}

const fakeLogger = () => ({
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}) as unknown as Logger & Record<'warn' | 'error' | 'debug', ReturnType<typeof vi.fn>>

function messages(events: InboundEvent[]) {
  return events.flatMap((e) => (e.kind === 'message' ? [e.message] : []))
}

/** Every identity field an event exposes must be a non-empty string. */
function assertNoEmptyIds(events: InboundEvent[]): void {
  for (const e of events) {
    const ids: unknown[] =
      e.kind === 'message' ? [e.message.chatId, e.message.senderId, e.message.from, e.message.sender, e.message.chat.id, e.message.senderInfo.id, e.message.ref.chatId, e.message.ref.id]
      : e.kind === 'interaction' ? [e.interaction.chatId, e.interaction.senderId, e.interaction.chat.id, e.interaction.senderInfo.id, e.interaction.ref.chatId]
      : e.kind === 'reaction' ? [e.reaction.senderId, e.reaction.ref.chatId, e.reaction.ref.id]
      : e.kind === 'status' ? [e.status.ref.chatId, e.status.ref.id, e.status.recipient]
      : []
    for (const id of ids) {
      expect(typeof id).toBe('string')
      expect((id as string).length).toBeGreaterThan(0)
    }
  }
}

/* --- Graph fetch mock (no network) --------------------------------------- */

interface Call { url: string; init?: RequestInit }
function mockFetch(body: unknown = { messages: [{ id: 'wamid.OUT' }] }): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
  }))
  return calls
}

const baseCfg = {
  accessToken: 'TOK', phoneNumberId: 'PNID', verifyToken: 'vt', allowUnsignedWebhooks: true,
}

function collect(p: CloudAPIProvider): InboundEvent[] {
  const seen: InboundEvent[] = []
  p.onEvent((e) => { if (e.kind !== 'connection') seen.push(e) })
  return seen
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

/* ========================================================================== */

describe('isBsuid', () => {
  it('recognizes BSUIDs and parent BSUIDs, not phone numbers', () => {
    expect(isBsuid(BSUID)).toBe(true)
    expect(isBsuid(PARENT)).toBe(true)
    expect(isBsuid(PHONE)).toBe(false)
    expect(isBsuid('+16505551234')).toBe(false)
    expect(isBsuid('')).toBe(false)
    expect(isBsuid('US.')).toBe(false)
    expect(isBsuid('US.has space')).toBe(false)
  })
})

describe('MemoryIdentityMap', () => {
  it('is bounded (evicts the least recently used entry)', () => {
    const map = new MemoryIdentityMap({ maxEntries: 2 })
    map.set('US.1', '1')
    map.set('US.2', '2')
    expect(map.get('US.1')).toBe('1') // touch → US.2 becomes the oldest
    map.set('US.3', '3')
    expect(map.get('US.2')).toBeUndefined()
    expect(map.get('US.1')).toBe('1')
    expect(map.get('US.3')).toBe('3')
    expect(map.size).toBe(2)
  })
})

describe('parseInbound — BSUID fields', () => {
  it('phone + BSUID: canonical id is the phone; BSUID data exposed in platformData', () => {
    const events = parseInbound(textWebhook({ phone: PHONE, bsuid: BSUID, parent: PARENT, username: USERNAME }, 'wamid.A', 'hola'))
    assertNoEmptyIds(events)
    const [m] = messages(events)
    expect(m.chatId).toBe(PHONE)
    expect(m.senderId).toBe(PHONE)
    expect(m.chat.id).toBe(PHONE)
    expect(m.senderInfo.displayName).toBe('Sheena Nelson')
    expect(m.senderInfo.username).toBe(USERNAME)
    expect(m.senderInfo.platformData).toEqual({
      phoneNumber: PHONE, bsuid: BSUID, parentBsuid: PARENT, username: USERNAME,
    })
  })

  it('BSUID-only (username user, phone omitted): canonical id is the BSUID', () => {
    const events = parseInbound(textWebhook({ bsuid: BSUID, username: USERNAME }, 'wamid.B', 'hola'))
    assertNoEmptyIds(events)
    const [m] = messages(events)
    expect(m.chatId).toBe(BSUID)
    expect(m.senderId).toBe(BSUID)
    expect(m.from).toBe(BSUID)
    expect(m.ref).toMatchObject({ id: 'wamid.B', chatId: BSUID })
    expect(m.senderInfo.displayName).toBe('Sheena Nelson')
    expect(m.senderInfo.platformData).toEqual({ bsuid: BSUID, username: USERNAME })
    expect(m.senderInfo.platformData).not.toHaveProperty('phoneNumber')
  })

  it('uses the phone from contacts[].wa_id when the message omits `from`', () => {
    const events = parseInbound(webhook({
      contacts: [contactOf({ phone: PHONE, bsuid: BSUID })],
      messages: [{ from_user_id: BSUID, id: 'wamid.C', timestamp: '1', type: 'text', text: { body: 'x' } }],
    }))
    expect(messages(events)[0].chatId).toBe(PHONE)
  })

  it('never merges a lone contact whose ids contradict the message sender', () => {
    const identityMap = new MemoryIdentityMap()
    const p = new CloudAPIProvider({ ...baseCfg, identityMap })
    const seen = collect(p)
    p.ingest(webhook({
      contacts: [contactOf({ phone: '573009998877', bsuid: 'CO.4444' })],
      messages: [{ from_user_id: BSUID, id: 'wamid.D', timestamp: '1', type: 'text', text: { body: 'x' } }],
    }))
    expect(messages(seen)[0].chatId).toBe(BSUID)
    expect(identityMap.get(BSUID)).toBeUndefined()
  })

  it('maps interactive replies and reactions from a BSUID-only user', () => {
    const who: Who = { bsuid: BSUID, username: USERNAME }
    const events = parseInbound(webhook({
      contacts: [contactOf(who)],
      messages: [
        { ...senderFields(who), id: 'wamid.I', timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Sí' } } },
        { ...senderFields(who), id: 'wamid.R', timestamp: '2', type: 'reaction', reaction: { message_id: 'wamid.OUT', emoji: '👍' } },
      ],
    }))
    assertNoEmptyIds(events)
    expect(events).toHaveLength(2)
    const [i, r] = events
    expect(i.kind).toBe('interaction')
    if (i.kind === 'interaction') {
      expect(i.interaction.chatId).toBe(BSUID)
      expect(i.interaction.senderId).toBe(BSUID)
      expect(i.interaction.senderInfo.platformData).toMatchObject({ bsuid: BSUID, username: USERNAME })
    }
    expect(r.kind).toBe('reaction')
    if (r.kind === 'reaction') {
      expect(r.reaction.senderId).toBe(BSUID)
      expect(r.reaction.ref).toMatchObject({ id: 'wamid.OUT', chatId: BSUID })
    }
  })

  it('statuses: recipient_user_id only → BSUID; recipient_id + recipient_user_id → phone', () => {
    const onlyBsuid = parseInbound(statusWebhook({ id: 'wamid.S1', status: 'delivered', recipient_user_id: BSUID, recipient_parent_user_id: PARENT }, [{ bsuid: BSUID, username: USERNAME }]))
    assertNoEmptyIds(onlyBsuid)
    expect(onlyBsuid[0]).toMatchObject({ kind: 'status', status: { ref: { id: 'wamid.S1', chatId: BSUID }, recipient: BSUID, status: 'delivered' } })

    const both = parseInbound(statusWebhook({ id: 'wamid.S2', status: 'read', recipient_id: PHONE, recipient_user_id: BSUID }, [{ phone: PHONE, bsuid: BSUID }]))
    expect(both[0]).toMatchObject({ kind: 'status', status: { ref: { chatId: PHONE }, recipient: PHONE, status: 'read' } })
  })

  it('drops (and logs) items without a usable id instead of emitting undefined ids', () => {
    const logger = fakeLogger()
    const events = parseInbound(webhook({
      messages: [
        // no from / from_user_id / contacts at all
        { id: 'wamid.X1', timestamp: '1', type: 'text', text: { body: 'a' } },
        // wrong types / empty strings
        { from: 573001234567, from_user_id: '', id: 'wamid.X2', timestamp: '1', type: 'text', text: { body: 'b' } },
        // malformed BSUID and no phone
        { from_user_id: 'not a bsuid', id: 'wamid.X3', timestamp: '1', type: 'text', text: { body: 'c' } },
        // valid sender but no message id
        { from_user_id: BSUID, timestamp: '1', type: 'text', text: { body: 'd' } },
        // reaction without a target message id
        { from_user_id: BSUID, id: 'wamid.X5', timestamp: '1', type: 'reaction', reaction: { emoji: '👍' } },
      ],
      statuses: [
        { id: 'wamid.S', status: 'failed', errors: [{ code: 131026 }] }, // no recipient at all
        { recipient_user_id: BSUID, status: 'sent' },                    // no message id
      ],
    }), { logger })
    expect(events).toEqual([])
    expect(logger.warn).toHaveBeenCalled()
    // Logs never carry the user's identifiers (personal data).
    const logged = JSON.stringify(logger.warn.mock.calls)
    expect(logged).not.toContain(BSUID)
    expect(logged).not.toContain('573001234567')
  })

  it('still emits a valid sibling when another item in the batch is malformed', () => {
    const events = parseInbound(webhook({
      messages: [
        { id: 'wamid.bad', timestamp: '1', type: 'text', text: { body: 'a' } },
        { from: PHONE, from_user_id: BSUID, id: 'wamid.ok', timestamp: '1', type: 'text', text: { body: 'b' } },
      ],
    }))
    expect(messages(events).map((m) => m.ref.id)).toEqual(['wamid.ok'])
  })
})

describe('CloudAPIProvider — stable identity with BSUIDs', () => {
  it('a user first seen with phone keeps the phone id when later only the BSUID arrives', () => {
    const p = new CloudAPIProvider(baseCfg)
    const seen = collect(p)
    p.ingest(textWebhook({ phone: PHONE, bsuid: BSUID, username: USERNAME }, 'wamid.1', 'hola'))
    p.ingest(textWebhook({ bsuid: BSUID, username: USERNAME }, 'wamid.2', 'sigo aquí'))
    const [m1, m2] = messages(seen)
    expect(m1.chatId).toBe(PHONE)
    expect(m2.chatId).toBe(PHONE)
    expect(m2.senderId).toBe(PHONE)
    expect(m2.senderInfo.platformData).toMatchObject({ phoneNumber: PHONE, bsuid: BSUID })
  })

  it('statuses carrying only recipient_user_id resolve to the learned phone id', () => {
    const p = new CloudAPIProvider(baseCfg)
    const seen = collect(p)
    p.ingest(textWebhook({ phone: PHONE, bsuid: BSUID }, 'wamid.1', 'hola'))
    p.ingest(statusWebhook({ id: 'wamid.OUT', status: 'read', recipient_user_id: BSUID }))
    // failed statuses for a phone send omit recipient_user_id and contacts
    p.ingest(statusWebhook({ id: 'wamid.OUT2', status: 'failed', recipient_id: PHONE, errors: [{ code: 131026, title: 'undeliverable' }] }))
    const statuses = seen.flatMap((e) => (e.kind === 'status' ? [e.status] : []))
    expect(statuses.map((s) => s.ref.chatId)).toEqual([PHONE, PHONE])
    expect(statuses.map((s) => s.recipient)).toEqual([PHONE, PHONE])
  })

  it('learns the phone ↔ BSUID pair from status webhooks too', () => {
    const p = new CloudAPIProvider(baseCfg)
    const seen = collect(p)
    p.ingest(statusWebhook({ id: 'wamid.OUT', status: 'delivered', recipient_id: PHONE, recipient_user_id: BSUID }, [{ phone: PHONE, bsuid: BSUID }]))
    p.ingest(textWebhook({ bsuid: BSUID }, 'wamid.1', 'hola'))
    expect(messages(seen)[0].chatId).toBe(PHONE)
  })

  it('persists learned pairs in the pluggable identity map (restart continuity)', () => {
    const store = new Map<string, string>()
    const identityMap: IdentityMap = {
      get: (bsuid) => store.get(bsuid),
      set: (bsuid, phone) => { store.set(bsuid, phone) },
    }
    const first = new CloudAPIProvider({ ...baseCfg, identityMap })
    first.ingest(textWebhook({ phone: PHONE, bsuid: BSUID }, 'wamid.1', 'hola'))
    expect(store.get(BSUID)).toBe(PHONE)

    // "Restart": a fresh provider sharing only the persisted map.
    const second = new CloudAPIProvider({ ...baseCfg, identityMap })
    const seen = collect(second)
    second.ingest(textWebhook({ bsuid: BSUID }, 'wamid.2', 'volví'))
    expect(messages(seen)[0].chatId).toBe(PHONE)
    expect(messages(seen)[0].senderInfo.platformData).toMatchObject({ phoneNumber: PHONE })
  })

  it('writes each pair to the identity map once per session, not on every webhook', () => {
    const set = vi.fn()
    const p = new CloudAPIProvider({ ...baseCfg, identityMap: { get: () => undefined, set } })
    for (let i = 0; i < 3; i++) p.ingest(textWebhook({ phone: PHONE, bsuid: BSUID }, `wamid.${i}`, 'x'))
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(BSUID, PHONE)
  })

  it('a user first seen BSUID-only keeps the BSUID id for the session when the phone is learned later', () => {
    const identityMap = new MemoryIdentityMap()
    const p = new CloudAPIProvider({ ...baseCfg, identityMap })
    const seen = collect(p)
    p.ingest(textWebhook({ bsuid: BSUID, username: USERNAME }, 'wamid.1', '¿me ayudas?'))
    p.ingest(textWebhook({ phone: PHONE, bsuid: BSUID, username: USERNAME }, 'wamid.2', 'te comparto mi número'))
    p.ingest(statusWebhook({ id: 'wamid.OUT', status: 'failed', recipient_id: PHONE }))
    expect(messages(seen).map((m) => m.chatId)).toEqual([BSUID, BSUID])
    expect(messages(seen)[1].senderInfo.platformData).toMatchObject({ phoneNumber: PHONE, bsuid: BSUID })
    const status = seen.find((e) => e.kind === 'status')
    expect(status?.kind === 'status' && status.status.ref.chatId).toBe(BSUID)
    // ...but the pair is learned, so the next session converges on the phone.
    expect(identityMap.get(BSUID)).toBe(PHONE)
  })

  it('supports an async identity map without reordering events', async () => {
    const identityMap: IdentityMap = {
      get: async (bsuid) => { await new Promise((r) => setTimeout(r, 5)); return bsuid === BSUID ? PHONE : undefined },
      set: async () => {},
    }
    const p = new CloudAPIProvider({ ...baseCfg, identityMap })
    const seen = collect(p)
    expect(p.ingest(textWebhook({ bsuid: BSUID }, 'wamid.1', 'uno'))).toBe(200)
    expect(p.ingest(textWebhook({ phone: '573001112233', bsuid: 'CO.998877' }, 'wamid.2', 'dos'))).toBe(200)
    expect(seen).toHaveLength(0) // waiting on the async lookup; order must be kept
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(messages(seen).map((m) => [m.ref.id, m.chatId])).toEqual([['wamid.1', PHONE], ['wamid.2', '573001112233']])
  })

  it('falls back to the BSUID (and logs) when the identity map lookup fails', async () => {
    const logger = fakeLogger()
    const p = new CloudAPIProvider({
      ...baseCfg, logger,
      identityMap: { get: async () => { throw new Error('redis down') }, set: async () => {} },
    })
    const seen = collect(p)
    p.ingest(textWebhook({ bsuid: BSUID }, 'wamid.1', 'hola'))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(messages(seen)[0].chatId).toBe(BSUID)
    expect(logger.error).toHaveBeenCalled()
  })

  it('stop() waits for in-flight identity lookups before closing', async () => {
    const p = new CloudAPIProvider({
      ...baseCfg,
      identityMap: { get: async () => { await new Promise((r) => setTimeout(r, 5)); return undefined }, set: () => {} },
    })
    const order: string[] = []
    p.onEvent((e) => { order.push(e.kind === 'connection' ? e.update.state : e.kind) })
    p.ingest(textWebhook({ bsuid: BSUID }, 'wamid.1', 'hola'))
    await p.stop()
    expect(order).toEqual(['message', 'closed'])
  })

  it('a BSUID change (user_id_update webhook) keeps the session id', () => {
    const p = new CloudAPIProvider(baseCfg)
    const seen = collect(p)
    const NEW_BSUID = 'US.55554444333322221111'
    p.ingest(textWebhook({ bsuid: BSUID }, 'wamid.1', 'hola'))
    p.ingest(webhook({
      user_id_update: [{
        user_id: { previous: BSUID, current: NEW_BSUID },
        parent_user_id: { previous: PARENT, current: 'US.ENT.99990000' },
      }],
    }, 'user_id_update'))
    p.ingest(textWebhook({ bsuid: NEW_BSUID }, 'wamid.2', 'sigo siendo yo'))
    expect(messages(seen).map((m) => m.chatId)).toEqual([BSUID, BSUID])
  })

  it('a phone-number change system message links the new phone/BSUID to the session id', () => {
    const p = new CloudAPIProvider(baseCfg)
    const seen = collect(p)
    const NEW_PHONE = '16505559999'
    const NEW_BSUID = 'US.70000000000000000001'
    p.ingest(textWebhook({ phone: PHONE, bsuid: BSUID }, 'wamid.1', 'hola'))
    p.ingest(webhook({
      messages: [{
        from: PHONE, from_user_id: BSUID, id: 'wamid.sys', timestamp: '2', type: 'system',
        system: { body: 'User Sheena Nelson changed from 16505551234 to 16505559999', wa_id: NEW_PHONE, user_id: NEW_BSUID, type: 'user_changed_number' },
      }],
    }))
    p.ingest(textWebhook({ phone: NEW_PHONE, bsuid: NEW_BSUID }, 'wamid.3', 'número nuevo'))
    expect(messages(seen).filter((m) => m.ref.id !== 'wamid.sys').map((m) => m.chatId)).toEqual([PHONE, PHONE])
  })
})

describe('CloudAPIProvider — outbound to a BSUID', () => {
  it('sends with `recipient` (not `to`) when the chat id is a BSUID', async () => {
    const calls = mockFetch({ messages: [{ id: 'wamid.OUT' }], contacts: [{ input: BSUID, user_id: BSUID }] })
    const p = new CloudAPIProvider(baseCfg)
    const res = await p.send(BSUID, { kind: 'text', text: 'hola' })
    expect(res.ref).toEqual({ id: 'wamid.OUT', chatId: BSUID })
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.recipient).toBe(BSUID)
    expect(body).not.toHaveProperty('to')
    expect(body.messaging_product).toBe('whatsapp')
    expect(body.type).toBe('text')
  })

  it('sends to a parent BSUID with `recipient` too', async () => {
    const calls = mockFetch()
    const p = new CloudAPIProvider(baseCfg)
    await p.send(PARENT, { kind: 'text', text: 'hola' })
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.recipient).toBe(PARENT)
    expect(body).not.toHaveProperty('to')
  })

  it('keeps `to` for phone-number chat ids', async () => {
    const calls = mockFetch()
    const p = new CloudAPIProvider(baseCfg)
    await p.send(PHONE, { kind: 'text', text: 'hola' })
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.to).toBe(PHONE)
    expect(body).not.toHaveProperty('recipient')
  })

  it('receipts and replies for a message sent to a BSUID resolve to that same chat id', async () => {
    mockFetch()
    const p = new CloudAPIProvider(baseCfg)
    const seen = collect(p)
    const sent = await p.send(BSUID, { kind: 'text', text: 'hola' })
    // Meta may reveal the phone in later webhooks; the chat must not split.
    p.ingest(statusWebhook({ id: sent.ref.id, status: 'delivered', recipient_id: PHONE, recipient_user_id: BSUID }, [{ phone: PHONE, bsuid: BSUID }]))
    p.ingest(textWebhook({ phone: PHONE, bsuid: BSUID }, 'wamid.reply', 'gracias'))
    const status = seen.find((e) => e.kind === 'status')
    expect(status?.kind === 'status' && status.status.ref).toEqual({ id: 'wamid.OUT', chatId: sent.ref.chatId })
    expect(messages(seen)[0].chatId).toBe(sent.ref.chatId)
  })

  it('replying to a BSUID-only inbound message goes out with `recipient`', async () => {
    const calls = mockFetch()
    const p = new CloudAPIProvider(baseCfg)
    const seen = collect(p)
    p.ingest(textWebhook({ bsuid: BSUID, username: USERNAME }, 'wamid.1', 'hola'))
    const [m] = messages(seen)
    await p.send(m.chatId, { kind: 'text', text: 'hola 👋' }, { quoted: m.ref })
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.recipient).toBe(BSUID)
    expect(body.context).toEqual({ message_id: 'wamid.1' })
  })
})
