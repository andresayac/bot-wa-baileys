/**
 * Durable media references: the journaled attachment URL round-trips (only for Meta CDN hosts or
 * `mediaRefHosts`), and a replayed message (crash + restart) downloads its media like a live one.
 */
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bot, IMAGE, MemoryDurability, ProviderError, loadMediaOf, type SerializedMediaRef } from '@botmesh/core'
import { crashable } from '@botmesh/core/testing'
import { crashAndReplayMedia, type MediaReplayDeps } from '../../../test-utils/media-replay.js'
import { MessengerProvider } from '../src/MessengerProvider.js'

const CDN = 'https://scontent.xx.fbcdn.net/v/t1.15752-9/123_n.jpg?_nc_cat=1&_nc_sid=abc&oh=00_sig&oe=670000'
const baseCfg = { accessToken: 'PAGE-TOKEN-SECRET', verifyToken: 'vt', allowUnsignedWebhooks: true }
const throughJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as SerializedMediaRef

describe('Messenger durable media references', () => {
  const p = new MessengerProvider(baseCfg)

  it('round-trips a Meta CDN attachment URL and never stores the access token', () => {
    for (const url of [CDN, 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x']) {
      const s = p.serializeMediaRef({ kind: 'image', mimetype: 'image/jpeg', token: url })!
      expect(s).toEqual({ v: 1, data: { url } })
      expect(JSON.stringify(s)).not.toContain('PAGE-TOKEN-SECRET')
      expect(p.rehydrateMediaRef(throughJson(s), { kind: 'image', mimetype: 'image/jpeg' }))
        .toEqual({ kind: 'image', mimetype: 'image/jpeg', token: url })
    }
  })

  it('declines tokens that are not an allowed attachment URL (the media is then not durable)', () => {
    for (const token of [undefined, 42, 'https://evil.example/a.jpg', 'http://scontent.xx.fbcdn.net/a.jpg', 'https://u:p@fbcdn.net/a']) {
      expect(p.serializeMediaRef({ kind: 'image', token })).toBeUndefined()
    }
  })

  it('rejects invalid, foreign, tampered or unknown-version references', () => {
    for (const stored of [
      { v: 2, data: { url: CDN } }, { v: 1, data: CDN }, { v: 1, data: null }, { v: 1, data: { url: 42 } },
      { v: 1, data: { url: 'https://169.254.169.254/latest/meta-data' } }, { v: 1, data: { url: 'https://fbcdn.net.evil.example/a' } },
      { v: 1, data: { url: 'file:///etc/passwd' } }, { v: 1, data: { url: `https://fbcdn.net/${'x'.repeat(5000)}` } },
    ] as SerializedMediaRef[]) {
      expect(() => p.rehydrateMediaRef(stored, { kind: 'image' }), JSON.stringify(stored).slice(0, 80)).toThrow(ProviderError)
    }
  })

  it('mediaRefHosts replaces the allowed hosts', () => {
    const custom = new MessengerProvider({ ...baseCfg, mediaRefHosts: ['media.example.com'] })
    expect(custom.serializeMediaRef({ kind: 'image', token: 'https://media.example.com/a.jpg' })).toEqual({ v: 1, data: { url: 'https://media.example.com/a.jpg' } })
    expect(custom.serializeMediaRef({ kind: 'image', token: CDN })).toBeUndefined()
    expect(() => new MessengerProvider({ ...baseCfg, mediaRefHosts: 'x' as never })).toThrow(/mediaRefHosts/)
  })

  describe('replay after a crash', () => {
    let server: Server
    let port = 0
    beforeAll(async () => {
      server = createServer((_req, res) => { res.statusCode = 200; res.end('JPEG-BYTES') })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      port = (server.address() as { port: number }).port
    })
    afterAll(() => new Promise<void>((r) => server.close(() => r())))

    const deps = { Bot, MemoryDurability, crashable, loadMediaOf, trigger: IMAGE } as unknown as MediaReplayDeps

    it('a restarted bot rehydrates the journaled URL and downloads the attachment', async () => {
      const url = () => `http://127.0.0.1:${port}/v/a.jpg?sig=1`
      const { replay, journaled } = await crashAndReplayMedia(deps, {
        makeProvider: () => new MessengerProvider({
          ...baseCfg, mediaRefHosts: ['127.0.0.1'],
          mediaDownload: { allowHttp: true, allowPrivateHosts: true, resolver: async () => ['127.0.0.1'] },
        }),
        deliver: (pr) => {
          pr.ingest({
            object: 'page',
            entry: [{ messaging: [{ sender: { id: 'U1' }, recipient: { id: 'PG' }, timestamp: 1, message: { mid: 'mid.1', attachments: [{ type: 'image', payload: { url: url() } }] } }] }],
          })
        },
      })
      expect(replay).toBe('bytes:JPEG-BYTES')
      expect(journaled).toContain('"$botwaMedia":1')
      expect(journaled).toContain('"provider":"messenger"')
      expect(journaled).not.toContain('PAGE-TOKEN-SECRET')
    })

    it('an attachment on a host that is not allowed replays as not durable', async () => {
      const { replay } = await crashAndReplayMedia(deps, {
        makeProvider: () => new MessengerProvider({ ...baseCfg, mediaDownload: { allowHttp: true, allowPrivateHosts: true, resolver: async () => ['127.0.0.1'] } }),
        deliver: (pr) => {
          pr.ingest({
            object: 'page',
            entry: [{ messaging: [{ sender: { id: 'U1' }, recipient: { id: 'PG' }, timestamp: 1, message: { mid: 'mid.2', attachments: [{ type: 'image', payload: { url: `http://127.0.0.1:${port}/a.jpg` } }] } }] }],
          })
        },
      })
      expect(replay).toBe('err:MediaUnavailableError:not-durable')
    })
  })
})
