import { describe, expect, it, vi } from 'vitest'
import { SecureHttpError, fetchBuffer, secureFetch } from '../src/index.js'

const publicResolver = async () => ['93.184.216.34']

describe('@bot-wa/http error codes', () => {
  it('reports invalid options as INVALID_OPTIONS, not INVALID_URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    for (const options of [{ timeoutMs: 0 }, { timeoutMs: Number.NaN }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxRedirects: -1 }]) {
      await expect(secureFetch('https://example.com', { fetch, resolver: publicResolver, ...options }))
        .rejects.toMatchObject({ name: 'SecureHttpError', code: 'INVALID_OPTIONS' })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps INVALID_URL for unparseable URLs and redirect locations', async () => {
    await expect(secureFetch('not a url', { resolver: publicResolver })).rejects.toMatchObject({ code: 'INVALID_URL' })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://[bad' } }))
    await expect(secureFetch('https://example.com', { fetch, resolver: publicResolver })).rejects.toMatchObject({ code: 'INVALID_URL' })
  })

  it('reports a non-2xx response from fetchBuffer as HTTP_STATUS with the status', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('missing', { status: 404 }))
    const error = await fetchBuffer('https://example.com/x', { fetch, resolver: publicResolver }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SecureHttpError)
    expect(error).toMatchObject({ code: 'HTTP_STATUS', status: 404 })
    expect((error as Error).message).toContain('404')
  })

  it('leaves status undefined for errors that are not about a response status', async () => {
    const error = await secureFetch('not a url', { resolver: publicResolver }).catch((e: unknown) => e)
    expect((error as SecureHttpError).status).toBeUndefined()
  })
})
