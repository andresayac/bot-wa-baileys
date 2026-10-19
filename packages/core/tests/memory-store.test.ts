/**
 * MemoryStore file persistence — focused on the atomic/serialized persist path.
 * Regression: overlapping persist() calls (autosave timer + stop()) once shared
 * a single `.tmp` file and could corrupt the target; persists are now queued.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, unlinkSync, readFileSync } from 'fs'
import { MemoryStore } from '../src/store/MemoryStore.js'

const FILE = './test-memory-store.json'
function clean() {
  for (const f of [FILE, ...globAllTmp()]) if (existsSync(f)) unlinkSync(f)
}
// Unique temp names are `${FILE}.${pid}.${n}.tmp`; best-effort cleanup of a few.
function globAllTmp(): string[] {
  const out: string[] = []
  for (let i = 0; i <= 50; i++) out.push(`${FILE}.${process.pid}.${i}.tmp`)
  return out
}

afterEach(clean)

describe('MemoryStore persistence', () => {
  it('persists and reloads chats/contacts/checkpoints/cursors (messages excluded)', async () => {
    clean()
    const a = new MemoryStore({ file: FILE, autoSaveInterval: 0 })
    await a.start()
    await a.upsertChat({ id: 'c1', name: 'Chat 1' })
    await a.upsertContact({ id: 'u1', name: 'User 1' })
    await a.setCheckpoint('k', { flowId: 'f', step: 1, state: {}, updatedAt: 1 })
    await a.setCursor('cur', '99')
    await a.saveMessage({ ref: { id: 'm', chatId: 'c1' }, chatId: 'c1', timestamp: 1, type: 'text', body: 'hi', fromMe: false })
    await a.stop() // flushes

    const b = new MemoryStore({ file: FILE, autoSaveInterval: 0 })
    await b.start()
    expect((await b.getChat('c1'))?.name).toBe('Chat 1')
    expect((await b.getContact('u1'))?.name).toBe('User 1')
    expect((await b.getCheckpoint('k'))?.flowId).toBe('f')
    expect(await b.getCursor('cur')).toBe('99')
    expect(await b.getMessagesByChat('c1')).toEqual([]) // messages intentionally not persisted
    await b.stop()
  })

  it('serializes overlapping persists without corrupting the file', async () => {
    clean()
    const store = new MemoryStore({ file: FILE, autoSaveInterval: 0 })
    await store.start()
    const persist = () => (store as unknown as { persist(): Promise<void> }).persist()
    // Fire many persists concurrently while mutating state between them.
    const runs: Promise<void>[] = []
    for (let i = 0; i < 20; i++) {
      await store.upsertChat({ id: `c${i}`, name: `Chat ${i}` })
      runs.push(persist())
    }
    await Promise.all(runs)
    // The target file must be valid JSON reflecting the final state (never a
    // half-written interleave of two payloads).
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
    expect(Array.isArray(parsed.chats)).toBe(true)
    expect(parsed.chats).toHaveLength(20)
    await store.stop()
  })
})

describe('MemoryStore maxMessagesPerChat', () => {
  const msg = (i: number) => ({
    ref: { id: `m${i}`, chatId: 'c' }, chatId: 'c', timestamp: i, type: 'text' as const, body: `b${i}`, fromMe: false,
  })

  it('caps each chat at 1000 messages by default (RAM-only store, not opt-in like the persistent stores)', async () => {
    const store = new MemoryStore()
    for (let i = 0; i < 1005; i++) await store.saveMessage(msg(i))
    const all = await store.getMessagesByChat('c', Infinity)
    expect(all).toHaveLength(1000)
    expect(all[0]?.ref.id).toBe('m5')
  })

  it('Infinity disables the cap; an explicit number overrides the default', async () => {
    const unbounded = new MemoryStore({ maxMessagesPerChat: Infinity })
    for (let i = 0; i < 1005; i++) await unbounded.saveMessage(msg(i))
    expect(await unbounded.getMessagesByChat('c', Infinity)).toHaveLength(1005)
    const small = new MemoryStore({ maxMessagesPerChat: 2 })
    for (let i = 0; i < 5; i++) await small.saveMessage(msg(i))
    expect((await small.getMessagesByChat('c')).map((m) => m.ref.id)).toEqual(['m3', 'm4'])
  })

  it('rejects a negative, fractional or NaN cap with a RangeError, like the persistent stores', () => {
    for (const maxMessagesPerChat of [-1, 1.5, Number.NaN]) {
      expect(() => new MemoryStore({ maxMessagesPerChat })).toThrow(RangeError)
    }
  })
})
