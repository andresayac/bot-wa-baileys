/**
 * The bounded message cache answers WhatsApp retry requests (`getMessage`).
 * Like the poll cache, it must only hold messages from chats the provider
 * listens to (plus the bot's own), so a flood from ignored chats (status,
 * broadcasts, newsletters) cannot evict the messages a retry may ask for.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  const { fakeMakeWASocket } = await import('./support/harness.js')
  return { ...actual, default: fakeMakeWASocket, makeCacheableSignalKeyStore: (keys: unknown) => keys }
})

const { BaileysProvider } = await import('../src/BaileysProvider.js')
const { connect } = await import('./support/harness.js')
type Harness = Awaited<ReturnType<typeof connect>>

const GROUP = '120363000000000000@g.us'
const text = (key: Partial<WAMessageKey> & { remoteJid: string; id: string }): WAMessage => ({
  key: { fromMe: false, participant: '573001111111@s.whatsapp.net', ...key },
  message: { conversation: `hi ${key.id}` },
  messageTimestamp: 1,
} as unknown as WAMessage)
const upsert = (messages: WAMessage[], type: 'notify' | 'append' = 'notify') => ({ 'messages.upsert': { type, messages } })
const getMessage = (h: Harness, key: Partial<WAMessageKey>) =>
  (h.sock.config.getMessage as (k: Partial<WAMessageKey>) => Promise<unknown>)(key)
const cacheSize = (h: Harness) => (h.provider as unknown as { msgCache: Map<string, unknown> }).msgCache.size

describe('retry message cache', () => {
  it('answers getMessage for messages from chats the provider listens to', async () => {
    const h = await connect(BaileysProvider)
    await h.emit(upsert([text({ remoteJid: GROUP, id: 'G1' })]))
    expect(await getMessage(h, { remoteJid: GROUP, id: 'G1' })).toEqual({ conversation: 'hi G1' })
  })

  it('does not cache messages from ignored chats, so they cannot evict the others', async () => {
    const h = await connect(BaileysProvider)
    await h.emit(upsert([text({ remoteJid: GROUP, id: 'KEEP' })]))
    const ignored = ['status@broadcast', '120363111111111111@newsletter', '1700000000@broadcast']
    const flood = Array.from({ length: 2500 }, (_, i) => text({ remoteJid: ignored[i % ignored.length]!, id: `IGN-${i}` }))
    await h.emit(upsert(flood))

    expect(cacheSize(h)).toBe(1)
    expect(await getMessage(h, { remoteJid: 'status@broadcast', id: 'IGN-0' })).toBeUndefined()
    expect(await getMessage(h, { remoteJid: GROUP, id: 'KEEP' })).toEqual({ conversation: 'hi KEEP' })
  })

  it('caches ignored-chat messages again once that chat kind is enabled', async () => {
    const h = await connect(BaileysProvider, { ignoreNewsletters: false })
    await h.emit(upsert([text({ remoteJid: '120363111111111111@newsletter', id: 'N1' })]))
    expect(await getMessage(h, { remoteJid: '120363111111111111@newsletter', id: 'N1' })).toBeDefined()
  })

  it('still caches the bot\'s own messages in ignored chats (e.g. its status posts)', async () => {
    const h = await connect(BaileysProvider)
    await h.emit(upsert([text({ remoteJid: 'status@broadcast', id: 'MINE', fromMe: true })], 'append'))
    expect(await getMessage(h, { remoteJid: 'status@broadcast', id: 'MINE' })).toEqual({ conversation: 'hi MINE' })
  })
})
