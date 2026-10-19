/**
 * Durable media references: the journaled attachment CDN URL round-trips (only for Discord CDN
 * hosts or `mediaRefHosts`), and a replayed message (crash + restart) downloads its media.
 */
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Bot, IMAGE, MemoryDurability, ProviderError, loadMediaOf, type SerializedMediaRef } from '@bot-wa/core'
import { crashable } from '@bot-wa/core/testing'
import { crashAndReplayMedia, type MediaReplayDeps } from '../../../test-utils/media-replay.js'
import { DiscordProvider } from '../src/DiscordProvider.js'
import { fakeSocketFactory, type FakeSocket } from './_fakeSocket.js'

const CDN = 'https://cdn.discordapp.com/attachments/111/222/photo.png?ex=6700&is=6600&hm=abcdef'
const throughJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as SerializedMediaRef

const live: DiscordProvider[] = []
function provider(over: Record<string, unknown> = {}): DiscordProvider & { sockets: FakeSocket[] } {
  const { sockets, factory } = fakeSocketFactory()
  const p = new DiscordProvider({ token: 'BOT-TOKEN-SECRET', socketFactory: factory, reconnectDelayMs: 0, ...over } as never)
  live.push(p)
  return Object.assign(p, { sockets })
}
afterEach(async () => { while (live.length) await live.pop()!.stop() })

describe('Discord durable media references', () => {
  it('round-trips a Discord CDN URL and never stores the bot token', () => {
    const p = provider()
    for (const url of [CDN, 'https://media.discordapp.net/attachments/1/2/v.mp4']) {
      const s = p.serializeMediaRef({ kind: 'image', mimetype: 'image/png', filename: 'photo.png', token: url })!
      expect(s).toEqual({ v: 1, data: { url } })
      expect(JSON.stringify(s)).not.toContain('BOT-TOKEN-SECRET')
      expect(p.rehydrateMediaRef(throughJson(s), { kind: 'image', mimetype: 'image/png', filename: 'photo.png' }))
        .toEqual({ kind: 'image', mimetype: 'image/png', filename: 'photo.png', token: url })
    }
  })

  it('declines tokens that are not an allowed CDN URL and rejects invalid stored values', () => {
    const p = provider()
    for (const token of [undefined, 'https://evil.example/a.png', 'http://cdn.discordapp.com/a.png', 'https://discordapp.com.evil.example/a']) {
      expect(p.serializeMediaRef({ kind: 'image', token })).toBeUndefined()
    }
    for (const stored of [
      { v: 2, data: { url: CDN } }, { v: 1, data: CDN }, { v: 1, data: null }, { v: 1, data: { url: 'https://169.254.169.254/x' } },
      { v: 1, data: { url: 'https://discord.com/api/v10/users/@me' } },
    ] as SerializedMediaRef[]) {
      expect(() => p.rehydrateMediaRef(stored, { kind: 'image' }), JSON.stringify(stored)).toThrow(ProviderError)
    }
  })

  it('mediaRefHosts replaces the allowed hosts and is validated', () => {
    const p = provider({ mediaRefHosts: ['files.example.com'] })
    expect(p.serializeMediaRef({ kind: 'image', token: 'https://files.example.com/a.png' })).toEqual({ v: 1, data: { url: 'https://files.example.com/a.png' } })
    expect(p.serializeMediaRef({ kind: 'image', token: CDN })).toBeUndefined()
    expect(() => provider({ mediaRefHosts: [''] })).toThrow(/mediaRefHosts/)
  })

  describe('replay after a crash', () => {
    let server: Server
    let port = 0
    beforeAll(async () => {
      server = createServer((_req, res) => { res.statusCode = 200; res.end('PNG-BYTES') })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      port = (server.address() as { port: number }).port
    })
    afterAll(() => new Promise<void>((r) => server.close(() => r())))

    it('a restarted bot rehydrates the journaled URL and downloads the attachment', async () => {
      const deps = { Bot, MemoryDurability, crashable, loadMediaOf, trigger: IMAGE } as unknown as MediaReplayDeps
      const { replay, journaled } = await crashAndReplayMedia(deps, {
        makeProvider: () => provider({
          selfId: 'BOT1', mediaRefHosts: ['127.0.0.1'],
          mediaDownload: { allowHttp: true, allowPrivateHosts: true, resolver: async () => ['127.0.0.1'] },
        }),
        boot: (p) => { p.sockets[0].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } }) },
        deliver: (p) => {
          p.sockets[0].serverSend({
            op: 0, t: 'MESSAGE_CREATE', s: 1,
            d: {
              id: '1300000000000000001', channel_id: 'C1', author: { id: 'U1', username: 'ana' },
              content: '', timestamp: '2026-01-01T00:00:00.000Z', mentions: [],
              attachments: [{ id: 'A1', filename: 'photo.png', content_type: 'image/png', size: 9, url: `http://127.0.0.1:${port}/attachments/1/2/photo.png?hm=x` }],
            },
          })
        },
      })
      expect(replay).toBe('bytes:PNG-BYTES')
      expect(journaled).toContain('"provider":"discord"')
      expect(journaled).not.toContain('BOT-TOKEN-SECRET')
    })
  })
})
