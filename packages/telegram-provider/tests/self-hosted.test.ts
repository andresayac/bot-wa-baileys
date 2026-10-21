import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProviderError } from '@botmesh/core'
import { TelegramProvider } from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

function stub(filePath: string) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, result: { file_path: filePath } }),
    }
  }))
  return urls
}

describe('Telegram self-hosted Bot API', () => {
  it('calls the configured baseUrl (trailing slashes trimmed)', async () => {
    const urls = stub('photos/a.jpg')
    const p = new TelegramProvider({ token: 'TOK', baseUrl: 'http://127.0.0.1:8081/' })
    await p.downloadMedia({ kind: 'image', token: 'FILE' }).catch(() => undefined)
    expect(urls[0]).toBe('http://127.0.0.1:8081/botTOK/getFile')
  })

  it('a plain-HTTP / private-host file URL is refused (typed, token-free) unless mediaDownload allows it', async () => {
    stub('photos/a.jpg')
    const p = new TelegramProvider({ token: 'TOK', baseUrl: 'http://127.0.0.1:8081' })
    const err = await p.downloadMedia({ kind: 'image', token: 'FILE' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as Error).message).toMatch(/allowHttp|allowPrivateHosts/)
    expect((err as Error).message).not.toContain('TOK')
  })

  it('an absolute file_path (server started with --local) fails with an explanatory ProviderError', async () => {
    stub('/var/lib/telegram-bot-api/TOK/photos/a.jpg')
    const p = new TelegramProvider({ token: 'TOK', baseUrl: 'http://127.0.0.1:8081', mediaDownload: { allowHttp: true, allowPrivateHosts: true } })
    const err = await p.downloadMedia({ kind: 'image', token: 'FILE' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as Error).message).toMatch(/--local/)
    expect((err as Error).message).not.toContain('TOK')
  })
})
