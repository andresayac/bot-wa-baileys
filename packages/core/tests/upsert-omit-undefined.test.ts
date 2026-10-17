import { describe, it, expect } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import type { InboundEvent, InboundMessage, StoredChat, StoredContact } from '../src/core/provider.js'

/**
 * Stores treat an explicit `undefined` field in an upsert as "unset" (MemoryStore
 * spread, Mongo `$unset`, SQL key removal). The bot must therefore never send
 * undefined-valued fields, or a nameless message wipes a stored chat/contact name.
 */

function emit(provider: MockProvider, event: InboundEvent): void {
  (provider as unknown as { emitEvent(e: InboundEvent): void }).emitEvent(event)
}

let seq = 0
function message(opts: { chatName?: string; displayName?: string; username?: string; phone?: string; raw?: Record<string, unknown> }): InboundMessage {
  const chatId = 'group-1'
  const senderId = 'user-1'
  return {
    ref: { id: `m-${++seq}`, chatId },
    chat: {
      id: chatId, kind: 'group', isGroup: true, isBroadcast: false,
      ...(opts.chatName !== undefined ? { name: opts.chatName } : {}),
      ...(opts.raw ? { platformData: opts.raw } : {}),
    },
    senderInfo: {
      id: senderId,
      ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
      ...(opts.username !== undefined ? { username: opts.username } : {}),
      ...(opts.phone !== undefined || opts.raw ? { platformData: { ...opts.raw, ...(opts.phone ? { phoneNumber: opts.phone } : {}) } } : {}),
    },
    from: chatId, sender: senderId, chatId, senderId,
    isGroup: true, isBroadcast: false, fromMe: false,
    type: 'text', body: 'hola',
    timestamp: Math.floor(Date.now() / 1000),
    mentions: [],
    raw: {},
  }
}

/** Records every upsert payload that reaches the backing store. */
class RecordingStore extends MemoryStore {
  chatUpserts: StoredChat[] = []
  contactUpserts: StoredContact[] = []
  override async upsertChat(chat: StoredChat): Promise<void> {
    this.chatUpserts.push({ ...chat })
    await super.upsertChat(chat)
  }
  override async upsertContact(contact: StoredContact): Promise<void> {
    this.contactUpserts.push({ ...contact })
    await super.upsertContact(contact)
  }
}

const undefinedKeys = (record: object): string[] =>
  Object.entries(record).filter(([, value]) => value === undefined).map(([key]) => key)

async function settle(bot: Bot, chatId: string, predicate: (count: number) => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate((await bot.getStore().getMessagesByChat(chatId)).length)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('timed out waiting for persistence')
}

describe('Bot upserts never send undefined-valued fields', () => {
  it('a nameless inbound message keeps the stored chat and contact names', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider, store: new MemoryStore() })
    await bot.start()

    emit(provider, { kind: 'message', message: message({ chatName: 'Familia', displayName: 'Ana', username: 'ana', phone: '+573001112233' }) })
    await settle(bot, 'group-1', (n) => n >= 1)
    emit(provider, { kind: 'message', message: message({}) })
    await settle(bot, 'group-1', (n) => n >= 2)

    const chat = await bot.getStore().getChat('group-1')
    expect(chat?.name).toBe('Familia')
    expect(chat?.kind).toBe('group')
    const contact = await bot.getStore().getContact('user-1')
    expect(contact?.name).toBe('Ana')
    expect(contact?.username).toBe('ana')
    expect(contact?.phoneNumber).toBe('+573001112233')
    await bot.stop()
  })

  it('a later message without persistRaw keeps raw stored earlier', async () => {
    const store = new MemoryStore()
    const first = new MockProvider()
    const withRaw = new Bot({ provider: first, store, persistRaw: true })
    await withRaw.start()
    emit(first, { kind: 'message', message: message({ chatName: 'Familia', displayName: 'Ana', raw: { subject: 'Familia' } }) })
    await settle(withRaw, 'group-1', (n) => n >= 1)
    await withRaw.stop()

    const second = new MockProvider()
    const withoutRaw = new Bot({ provider: second, store })
    await withoutRaw.start()
    emit(second, { kind: 'message', message: message({}) })
    await settle(withoutRaw, 'group-1', (n) => n >= 2)

    expect((await withoutRaw.getStore().getChat('group-1'))?.raw).toEqual({ subject: 'Familia' })
    expect((await withoutRaw.getStore().getContact('user-1'))?.raw).toEqual({ subject: 'Familia' })
    expect((await withoutRaw.getStore().getChat('group-1'))?.name).toBe('Familia')
    await withoutRaw.stop()
  })

  it('no chat/contact upsert (inbound, outbound ledger) carries an undefined field', async () => {
    const store = new RecordingStore()
    const provider = new MockProvider()
    const bot = new Bot({ provider, store })
    bot.onMessage(async (ctx) => { await ctx.reply('ok') })
    await bot.start()

    emit(provider, { kind: 'message', message: message({ chatName: 'Familia', displayName: 'Ana' }) })
    await settle(bot, 'group-1', (n) => n >= 2)
    emit(provider, { kind: 'message', message: message({}) })
    await settle(bot, 'group-1', (n) => n >= 4)

    expect(store.chatUpserts.length).toBeGreaterThanOrEqual(4)
    expect(store.contactUpserts.length).toBeGreaterThanOrEqual(2)
    for (const upsert of [...store.chatUpserts, ...store.contactUpserts]) {
      expect(undefinedKeys(upsert)).toEqual([])
    }
    expect((await bot.getStore().getChat('group-1'))?.name).toBe('Familia')
    expect((await bot.getStore().getContact('user-1'))?.name).toBe('Ana')
    await bot.stop()
  })
})
