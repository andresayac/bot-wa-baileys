/** Durable media references: the journaled `file_id` round-trips and downloads like a live one. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { ProviderError, type SerializedMediaRef } from '@botmesh/core'
import { TelegramProvider } from '../src/TelegramProvider.js'

afterEach(() => vi.unstubAllGlobals())

const throughJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as SerializedMediaRef

describe('Telegram durable media references', () => {
  const p = new TelegramProvider({ token: 'TOK' })

  it('round-trips the file_id (and never the bot token)', () => {
    const file = 'AgACAgIAAxkBAAIBY2Zx_a-1'
    const s = p.serializeMediaRef({ kind: 'image', mimetype: 'image/jpeg', size: 10, token: file })!
    expect(s).toEqual({ v: 1, data: file })
    expect(JSON.stringify(s)).not.toContain('TOK')
    expect(p.rehydrateMediaRef(throughJson(s), { kind: 'image', mimetype: 'image/jpeg', size: 10 }))
      .toEqual({ kind: 'image', mimetype: 'image/jpeg', size: 10, token: file })
  })

  it('declines tokens that are not a file_id', () => {
    expect(p.serializeMediaRef({ kind: 'image', token: undefined })).toBeUndefined()
    expect(p.serializeMediaRef({ kind: 'image', token: '../../etc/passwd' })).toBeUndefined()
  })

  it('rejects invalid, tampered or unknown-version references', () => {
    for (const stored of [
      { v: 2, data: 'abc' }, { v: 1, data: 42 }, { v: 1, data: '../x' }, { v: 1, data: 'a/b' },
      { v: 1, data: 'x'.repeat(600) }, { v: 1, data: null },
    ] as SerializedMediaRef[]) {
      expect(() => p.rehydrateMediaRef(stored, { kind: 'document' })).toThrow(ProviderError)
    }
  })

  it('a rehydrated ref downloads through getFile like the live one', async () => {
    const filePaths: string[] = []
    const server = createServer((req, res) => { filePaths.push(req.url ?? ''); res.end('BYTES') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const bodies: unknown[] = []
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, result: { file_path: 'photos/1.jpg' } }) }
      }))
      const live = new TelegramProvider({
        token: 'TOK', baseUrl: `http://127.0.0.1:${port}`,
        mediaDownload: { allowHttp: true, allowPrivateHosts: true, resolver: async () => ['127.0.0.1'] },
      })
      const ref = live.rehydrateMediaRef(throughJson(live.serializeMediaRef({ kind: 'image', token: 'f1' })), { kind: 'image' })
      expect(String(await live.downloadMedia(ref))).toBe('BYTES')
      expect(bodies).toEqual([{ file_id: 'f1' }])
      expect(filePaths).toEqual(['/file/botTOK/photos/1.jpg'])
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
