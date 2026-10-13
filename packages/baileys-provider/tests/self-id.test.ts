/**
 * `provider.selfId` and inbound `mentions`. @bot-wa/core uses `selfId` for two
 * things: the `senderId` of the outbound messages it stores, and the group
 * filter `groupMode: 'mentions'`, which runs `ctx.mentions.includes(selfId)`.
 * Baileys keeps the bot's id device-qualified in `creds.me.id`
 * (`573000000000:12@s.whatsapp.net`) while a mention never carries a device, so
 * both must use the canonical form the provider emits everywhere else: the
 * normalised PN, with LID mentions (LID-addressed groups) mapped to their PN.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WAMessage } from '@whiskeysockets/baileys'
import { Bot } from '@bot-wa/core'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  const { fakeMakeWASocket } = await import('./support/harness.js')
  return { ...actual, default: fakeMakeWASocket, makeCacheableSignalKeyStore: (keys: unknown) => keys }
})

const { BaileysProvider } = await import('../src/BaileysProvider.js')
const { connect, ME, ME_LID, ME_PN } = await import('./support/harness.js')

const GROUP = '120363000000000000@g.us'
const MEMBER_LID = '500000000000001@lid'
const MEMBER_PN = '573006666666@s.whatsapp.net'
const STRANGER_LID = '500000000000009@lid'

let seq = 0
const groupText = (body: string, mentionedJid: string[]): WAMessage => ({
  key: { remoteJid: GROUP, fromMe: false, id: `G-${++seq}`, participant: MEMBER_LID, participantAlt: MEMBER_PN },
  message: { extendedTextMessage: { text: body, contextInfo: { mentionedJid } } },
  messageTimestamp: 1,
} as unknown as WAMessage)

const upsert = (messages: WAMessage[]) => ({ 'messages.upsert': { type: 'notify', messages } })

describe('selfId', () => {
  it('is the normalised PN, the same id the bot\'s own reactions carry', async () => {
    const h = await connect(BaileysProvider)
    expect(ME.id).toBe('573000000000:12@s.whatsapp.net') // what creds.me.id holds
    expect(h.provider.selfId).toBe(ME_PN)

    await h.emit({
      'messages.reaction': [{
        key: { remoteJid: GROUP, fromMe: false, id: 'TARGET', participant: MEMBER_LID },
        reaction: { key: { remoteJid: GROUP, fromMe: true, id: 'R1', participant: ME_LID }, text: '👍' },
      }],
    })
    expect(h.ofKind('reaction')[0]?.reaction.senderId).toBe(h.provider.selfId)
  })

  it('is null before the provider has credentials', () => {
    expect(new BaileysProvider({ session: 'self-id' }).selfId).toBeNull()
  })
})

describe('mentions', () => {
  it('are canonical: the bot\'s LID and a known member\'s LID become their PN, unknown LIDs stay', async () => {
    const h = await connect(BaileysProvider)
    await h.emit(upsert([groupText('hi', [ME_LID, MEMBER_LID, STRANGER_LID, ME_PN])]))
    expect(h.ofKind('message')[0]?.message.mentions).toEqual([ME_PN, MEMBER_PN, STRANGER_LID, ME_PN])
  })

  it('let a core Bot in groupMode "mentions" answer when mentioned by PN or by LID, and only then', async () => {
    const h = await connect(BaileysProvider)
    // Keep the fake socket: the real start() loads the auth state from disk and fetches the WA version.
    h.provider.start = async () => {}
    const bot = new Bot({ provider: h.provider, groupMode: 'mentions' })
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })
    await bot.start()
    try {
      await h.emit(upsert([
        groupText('by PN', [ME_PN]),
        groupText('by LID', [ME_LID]),
        groupText('someone else', [MEMBER_PN]),
        groupText('nobody', []),
      ]))
      await vi.waitFor(() => expect([...seen].sort()).toEqual(['by LID', 'by PN']))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect([...seen].sort()).toEqual(['by LID', 'by PN'])
    } finally {
      await bot.stop()
    }
  })
})
