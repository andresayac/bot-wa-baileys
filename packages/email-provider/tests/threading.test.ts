import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@bot-wa/core'
import { parseEmail } from '../src/mime.js'
import { baseSubject, cursorThreadStore, MemoryThreadStore, ThreadTracker } from '../src/threading.js'

const msg = (lines: string[]): ReturnType<typeof parseEmail> => parseEmail([...lines, '', 'x'].join('\r\n'))

describe('baseSubject', () => {
  it('strips reply/forward prefixes in several languages', () => {
    expect(baseSubject('Re: RE: Fwd: Pedido 42')).toBe('Pedido 42')
    expect(baseSubject('RV: Re[2]: AW: Factura')).toBe('Factura')
    expect(baseSubject('  ')).toBe('')
  })
})

describe('ThreadTracker (thread mode)', () => {
  it('keeps a whole reply chain on one chatId keyed by the root Message-ID', async () => {
    const t = new ThreadTracker({ store: new MemoryThreadStore(), mode: 'thread' })
    const first = await t.resolveInbound(msg(['From: Ana <ana@x.test>', 'Message-ID: <m1@x.test>', 'Subject: Pedido']), 'ana@x.test')
    expect(first).toBe('thread:m1@x.test')
    const second = await t.resolveInbound(msg(['From: ana@x.test', 'Message-ID: <m3@x.test>', 'In-Reply-To: <m2@acme.test>', 'References: <m1@x.test> <m2@acme.test>', 'Subject: Re: Pedido']), 'ana@x.test')
    expect(second).toBe(first)
    const state = await t.store.getThread(first)
    expect(state).toMatchObject({ chatId: first, subject: 'Pedido', lastMessageId: 'm3@x.test', counterpart: { address: 'ana@x.test' } })
    expect(state!.references).toEqual(['m1@x.test', 'm2@acme.test', 'm3@x.test'])
  })

  it('follows In-Reply-To through the message index when References is missing', async () => {
    const t = new ThreadTracker({ store: new MemoryThreadStore(), mode: 'thread' })
    const chat = await t.resolveInbound(msg(['From: a@x.test', 'Message-ID: <r1@x.test>']), 'a@x.test')
    await t.recordOutbound(chat, 'bot-1@acme.test')
    const reply = await t.resolveInbound(msg(['From: a@x.test', 'Message-ID: <r2@x.test>', 'In-Reply-To: <bot-1@acme.test>']), 'a@x.test')
    expect(reply).toBe(chat)
  })

  it('uses Reply-To as the counterpart and caps references', async () => {
    const t = new ThreadTracker({ store: new MemoryThreadStore(), mode: 'thread', maxReferences: 3 })
    const refs = ['<a@x>', '<b@x>', '<c@x>', '<d@x>'].join(' ')
    const chat = await t.resolveInbound(msg(['From: a@x.test', 'Reply-To: Help <help@x.test>', 'Message-ID: <e@x>', `References: ${refs}`]), 'a@x.test')
    const state = await t.store.getThread(chat)
    expect(state!.counterpart).toEqual({ name: 'Help', address: 'help@x.test' })
    // First reference (thread root) is kept; the tail is the most recent.
    expect(state!.references).toEqual(['a@x', 'd@x', 'e@x'])
  })
})

describe('ThreadTracker (sender mode)', () => {
  it('uses the normalized sender address as the chatId', async () => {
    const t = new ThreadTracker({ store: new MemoryThreadStore(), mode: 'sender' })
    const a = await t.resolveInbound(msg(['From: Ana@X.test', 'Message-ID: <1@x>', 'Subject: uno']), 'ana@x.test')
    const b = await t.resolveInbound(msg(['From: ana@x.test', 'Message-ID: <2@x>', 'Subject: otro tema']), 'ana@x.test')
    expect(a).toBe('ana@x.test')
    expect(b).toBe('ana@x.test')
    expect((await t.store.getThread(a))!.subject).toBe('otro tema')
  })
})

describe('thread stores', () => {
  it('MemoryThreadStore evicts the oldest entries past its bound', async () => {
    const s = new MemoryThreadStore({ maxEntries: 2 })
    await s.setChatIdForMessage('1', 'a')
    await s.setChatIdForMessage('2', 'b')
    await s.setChatIdForMessage('3', 'c')
    expect(await s.getChatIdForMessage('1')).toBeUndefined()
    expect(await s.getChatIdForMessage('3')).toBe('c')
  })

  it('cursorThreadStore persists through any IStore with cursors', async () => {
    const store = new MemoryStore()
    const s = cursorThreadStore(store)
    await s.setThread('thread:x', { chatId: 'thread:x', subject: 's', counterpart: { address: 'a@x.test' }, references: ['x'], lastMessageId: 'x', updatedAt: 1 })
    await s.setChatIdForMessage('x', 'thread:x')
    const again = cursorThreadStore(store)
    expect(await again.getThread('thread:x')).toMatchObject({ subject: 's', lastMessageId: 'x' })
    expect(await again.getChatIdForMessage('x')).toBe('thread:x')
    expect(await again.getThread('nope')).toBeUndefined()
  })
})
