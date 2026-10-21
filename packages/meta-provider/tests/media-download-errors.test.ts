/**
 * GraphClient.downloadMedia: the CDN step (secureFetch) must reject with typed
 * provider errors like the Graph step does — never a raw SecureHttpError.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PayloadTooLargeError, ProviderError } from '@botmesh/core'
import { SecureHttpError } from '@botmesh/http'
import { GraphClient } from '../src/graphClient.js'

const cfg = { accessToken: 'TOK', phoneNumberId: 'PNID', apiVersion: 'v21.0', graphUrl: 'https://graph.facebook.com' }

function stubGraphMeta(url: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ url, mime_type: 'image/jpeg' }),
  })))
}

let server: Server | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = undefined
})

describe('GraphClient.downloadMedia transport errors', () => {
  it('an SSRF refusal on the media URL rejects with a ProviderError carrying the cause', async () => {
    stubGraphMeta('https://cdn.example.test/media?token=SECRET')
    const client = new GraphClient({ ...cfg, mediaDownload: { resolver: async () => ['10.0.0.1'] } })

    const err = await client.downloadMedia('MID').then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderError)
    expect(err).not.toBeInstanceOf(SecureHttpError)
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(SecureHttpError)
    expect((err as Error).message).not.toContain('SECRET')
  })

  it('an oversized media body rejects with PayloadTooLargeError', async () => {
    server = createServer((_req, res) => { res.end(Buffer.alloc(2048)) })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    stubGraphMeta(`http://127.0.0.1:${port}/media`)
    const client = new GraphClient({ ...cfg, mediaDownload: { allowHttp: true, allowPrivateHosts: true, maxBytes: 100 } })

    await expect(client.downloadMedia('MID')).rejects.toBeInstanceOf(PayloadTooLargeError)
  })
})
