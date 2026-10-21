/**
 * Durable media references (`serializeMediaRef` / `rehydrateMediaRef`): a replayed media
 * message (durable inbox) can download its media in another process. Only the media content
 * and the raw key are journaled; the stored value is validated when read back.
 */
import { describe, expect, it, vi } from 'vitest'
import { proto, type WAMessage } from '@whiskeysockets/baileys'
import type { MediaRef, SerializedMediaRef } from '@botmesh/core'

const download = vi.fn(async (message: WAMessage) => Buffer.from(`media:${message.key.id}`))

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  const { fakeMakeWASocket } = await import('./support/harness.js')
  return {
    ...actual,
    default: fakeMakeWASocket,
    makeCacheableSignalKeyStore: (keys: unknown) => keys,
    downloadMediaMessage: (...args: unknown[]) => download(...(args as [WAMessage])),
  }
})

const { BaileysProvider } = await import('../src/BaileysProvider.js')
const { connect } = await import('./support/harness.js')
const { Bot, IMAGE, MemoryDurability, MemoryStore, ProviderError, loadMediaOf } = await import('@botmesh/core')
const { crashable } = await import('@botmesh/core/testing')

const DM = '573001111111@s.whatsapp.net'
const GROUP = '120363000000000000@g.us'
const MEDIA_KEY = Buffer.from('0123456789abcdef0123456789abcdef')

function image(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://mmg.whatsapp.net/v/t62.7118-24/abc.enc',
    directPath: '/v/t62.7118-24/abc.enc',
    mediaKey: MEDIA_KEY,
    mediaKeyTimestamp: 1_760_000_000,
    fileEncSha256: Buffer.from('enc-sha'),
    fileSha256: Buffer.from('sha'),
    fileLength: 4321,
    mimetype: 'image/jpeg',
    caption: `private caption ${id}`,
    jpegThumbnail: Buffer.alloc(2_000, 7),
    contextInfo: { stanzaId: 'Q1', participant: DM, quotedMessage: { conversation: 'quoted secret' } },
    ...extra,
  }
}

const wa = (id: string, message: Record<string, unknown>, key: Record<string, unknown> = {}): WAMessage => ({
  key: { remoteJid: DM, fromMe: false, id, ...key },
  message,
  messageTimestamp: 1_760_000_123,
  pushName: 'Ana',
} as unknown as WAMessage)

const ref = (kind: MediaRef['kind'], token: unknown): MediaRef => ({ kind, mimetype: 'image/jpeg', token })
const throughJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as SerializedMediaRef

async function provider(config: ConstructorParameters<typeof BaileysProvider>[0] = {}) {
  const h = await connect(BaileysProvider, config)
  ;(h.sock as unknown as { updateMediaMessage: unknown }).updateMediaMessage = vi.fn()
  return h
}

describe('Baileys durable media references', () => {
  it('round-trips through JSON keeping what a download needs and dropping thumbnail, caption and context', async () => {
    const h = await provider()
    const s = h.provider.serializeMediaRef(ref('image', wa('IMG1', { imageMessage: image('IMG1') })))!
    expect(s.v).toBe(1)
    const text = JSON.stringify(s)
    expect(text).not.toContain('private caption')
    expect(text).not.toContain(Buffer.from('quoted secret').toString('base64'))
    expect(text.length).toBeLessThan(1_000)

    const h2 = await provider() // another process: empty message cache
    const out = await h2.provider.rehydrateMediaRef(throughJson(s), { kind: 'image', mimetype: 'image/jpeg' })
    const token = out.token as WAMessage
    expect(token.key).toEqual({ remoteJid: DM, id: 'IMG1', fromMe: false })
    expect(token.messageTimestamp).toBe(1_760_000_123)
    const img = token.message!.imageMessage!
    expect(Buffer.from(img.mediaKey!)).toEqual(MEDIA_KEY)
    expect(img.directPath).toBe('/v/t62.7118-24/abc.enc')
    expect(img.url).toBe('https://mmg.whatsapp.net/v/t62.7118-24/abc.enc')
    expect(Buffer.from(img.fileEncSha256!)).toEqual(Buffer.from('enc-sha'))
    expect(Number(img.fileLength)).toBe(4321)
    expect(img.jpegThumbnail?.length ?? 0).toBe(0)
    expect(img.caption ?? '').toBe('')
    expect(img.contextInfo ?? undefined).toBeUndefined()
    expect(out).toMatchObject({ kind: 'image', mimetype: 'image/jpeg' })
  })

  it('unwraps ephemeral and document-with-caption envelopes; keeps the group participant', async () => {
    const h = await provider()
    const eph = h.provider.serializeMediaRef(ref('image', wa('E1', { ephemeralMessage: { message: { imageMessage: image('E1') } } })))!
    const doc = h.provider.serializeMediaRef(ref('document', wa('D1', {
      documentWithCaptionMessage: { message: { documentMessage: { ...image('D1'), mimetype: 'application/pdf', fileName: 'factura.pdf' } } },
    })))!
    const grp = h.provider.serializeMediaRef(ref('voice', wa('G1', {
      audioMessage: { ...image('G1'), mimetype: 'audio/ogg', ptt: true, seconds: 3 },
    }, { remoteJid: GROUP, participant: '900000000000002@lid' })))!

    const back = async (s: SerializedMediaRef, kind: MediaRef['kind']) =>
      (await h.provider.rehydrateMediaRef(throughJson(s), { kind })).token as WAMessage
    expect(Buffer.from((await back(eph, 'image')).message!.imageMessage!.mediaKey!)).toEqual(MEDIA_KEY)
    const d = (await back(doc, 'document')).message!.documentMessage!
    expect(d.fileName).toBe('factura.pdf')
    const g = await back(grp, 'voice')
    expect(g.key).toEqual({ remoteJid: GROUP, id: 'G1', fromMe: false, participant: '900000000000002@lid' })
    expect(g.message!.audioMessage!.ptt).toBe(true)
  })

  it('view-once media is not journaled unless durableMedia.viewOnce is set', async () => {
    const msg = wa('V1', { viewOnceMessageV2: { message: { imageMessage: image('V1', { viewOnce: true }) } } })
    expect((await provider()).provider.serializeMediaRef(ref('image', msg))).toBeUndefined()
    const s = (await provider({ durableMedia: { viewOnce: true } })).provider.serializeMediaRef(ref('image', msg))
    expect(s?.v).toBe(1)
  })

  it('declines media without a key or a path, and tokens that are not a WAMessage', async () => {
    const h = await provider()
    expect(h.provider.serializeMediaRef(ref('image', wa('N1', { imageMessage: image('N1', { mediaKey: undefined }) })))).toBeUndefined()
    expect(h.provider.serializeMediaRef(ref('image', wa('N2', { imageMessage: image('N2', { directPath: undefined, url: undefined }) })))).toBeUndefined()
    expect(h.provider.serializeMediaRef(ref('image', 'not-a-message'))).toBeUndefined()
    expect(h.provider.serializeMediaRef(ref('location', wa('N3', { imageMessage: image('N3') })))).toBeUndefined()
  })

  it('returns the original message while it is still in the message cache', async () => {
    const h = await provider()
    const original = wa('C1', { imageMessage: image('C1') })
    await h.emit({ 'messages.upsert': { type: 'notify', messages: [original] } })
    const s = h.provider.serializeMediaRef(ref('image', original))!
    const out = await h.provider.rehydrateMediaRef(throughJson(s), { kind: 'image' })
    expect(out.token).toBe(original)
  })

  it('rejects tampered or unknown references with a ProviderError', async () => {
    const h = await provider()
    const good = throughJson(h.provider.serializeMediaRef(ref('image', wa('T1', { imageMessage: image('T1') })))!)
    const data = good.data as { key: Record<string, string>; m: string }
    const twoMedia = Buffer.from(proto.Message.encode(proto.Message.fromObject({
      imageMessage: { mediaKey: MEDIA_KEY, directPath: '/a' }, videoMessage: { mediaKey: MEDIA_KEY, directPath: '/b' },
    })).finish()).toString('base64')
    const bad: Array<[string, SerializedMediaRef, MediaRef['kind']]> = [
      ['version', { ...good, v: 2 }, 'image'],
      ['no data', { v: 1, data: null }, 'image'],
      ['bad base64', { v: 1, data: { ...data, m: '***' } }, 'image'],
      ['oversize', { v: 1, data: { ...data, m: 'A'.repeat(20_000) } }, 'image'],
      ['wrong kind', good, 'video'],
      ['two media', { v: 1, data: { ...data, m: twoMedia } }, 'image'],
      ['key without id', { v: 1, data: { ...data, key: { remoteJid: DM } } }, 'image'],
      ['bad jid', { v: 1, data: { ...data, key: { ...data.key, remoteJid: '../etc' } } }, 'image'],
      ['garbage', { v: 1, data: { ...data, m: Buffer.from('not a protobuf at all').toString('base64') } }, 'image'],
    ]
    for (const [name, stored, kind] of bad) {
      let error: unknown
      try { await h.provider.rehydrateMediaRef(stored, { kind }) } catch (e) { error = e }
      expect(error, name).toBeInstanceOf(ProviderError)
    }
  })

  it('downloads a rehydrated ref through Baileys with the re-upload request wired', async () => {
    const h = await provider()
    const s = h.provider.serializeMediaRef(ref('image', wa('DL1', { imageMessage: image('DL1') })))!
    const h2 = await provider()
    const out = await h2.provider.rehydrateMediaRef(throughJson(s), { kind: 'image' })
    download.mockClear()
    expect(String(await h2.provider.downloadMedia(out))).toBe('media:DL1')
    const [message, type, , ctx] = download.mock.calls[0] as unknown as [WAMessage, string, unknown, { reuploadRequest: unknown }]
    expect(type).toBe('buffer')
    expect(Buffer.from(message.message!.imageMessage!.mediaKey!)).toEqual(MEDIA_KEY)
    expect(ctx.reuploadRequest).toBe((h2.sock as unknown as { updateMediaMessage: unknown }).updateMediaMessage)
  })

  it('end to end: a bot that crashed mid-handler replays the image on a new provider and downloads it', async () => {
    const shared = new MemoryDurability()
    const store = new MemoryStore()
    const silent = { level: 'silent', debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {}, child() { return silent } }
    const durability = (journal: unknown) => ({ journal: journal as never, instanceId: 'r1', pollMs: 20 })

    const ha = await provider()
    ha.provider.start = async () => {}
    ha.provider.stop = async () => {}
    const a = crashable(shared)
    const botA = new Bot({ provider: ha.provider, store, logger: silent as never, durability: durability(a) })
    botA.when(IMAGE, async () => { a.crash(); await new Promise(() => {}) })
    await botA.start()
    await ha.emit({ 'messages.upsert': { type: 'notify', messages: [wa('E2E1', { imageMessage: image('E2E1') })] } })
    await a.whenCrashed

    const hb = await provider()
    hb.provider.start = async () => {}
    hb.provider.stop = async () => {}
    const got: string[] = []
    const botB = new Bot({ provider: hb.provider, store, logger: silent as never, durability: durability(shared) })
    botB.when(IMAGE, async (ctx) => {
      const media = await loadMediaOf(ctx, { throwOnError: true })
      got.push(String(media?.buffer))
    })
    download.mockClear()
    await botB.start()
    await vi.waitFor(() => expect(got).toEqual(['media:E2E1']), { timeout: 5_000 })
    const [message] = download.mock.calls[0] as unknown as [WAMessage]
    expect(message.message!.imageMessage!.jpegThumbnail?.length ?? 0).toBe(0) // the journaled copy, not a cached one
    await botB.stop()
  })
})
