import { describe, expect, it, vi } from 'vitest'
import { SecureHttpError, assertSafeTarget, fetchBuffer, isPrivateAddress, secureFetch } from '../src/index.js'

const publicResolver = async () => ['93.184.216.34']

describe('@bot-wa/http', () => {
  it('rejects unsafe URL schemes, credentials and private networks', async () => {
    await expect(assertSafeTarget(new URL('http://example.com'), { resolver: publicResolver })).rejects.toMatchObject({ code: 'UNSAFE_URL' })
    await expect(assertSafeTarget(new URL('https://user:pass@example.com'), { resolver: publicResolver })).rejects.toMatchObject({ code: 'UNSAFE_URL' })
    await expect(assertSafeTarget(new URL('https://127.0.0.1'), { resolver: publicResolver })).rejects.toMatchObject({ code: 'UNSAFE_HOST' })
    await expect(assertSafeTarget(new URL('https://example.com'), { resolver: async () => ['10.0.0.8'] })).rejects.toMatchObject({ code: 'UNSAFE_HOST' })
  })

  it('recognizes loopback, RFC1918, link-local and IPv6 private ranges', () => {
    for (const address of ['localhost', '127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.1', '169.254.3.2', '::1', 'fc00::1', 'fe80::1']) {
      expect(isPrivateAddress(address)).toBe(true)
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
  })

  it('follows only validated redirects and returns a bounded buffer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.example/file' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const result = await secureFetch('https://example.com/start', { fetch, resolver: publicResolver })
    expect(result.url.href).toBe('https://cdn.example/file')
    expect(result.body.toString()).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects oversized responses before returning data', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('12345', { headers: { 'content-length': '5' } }))
    await expect(fetchBuffer('https://example.com', { fetch, resolver: publicResolver, maxBytes: 4 })).rejects.toEqual(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' } satisfies Partial<SecureHttpError>))
  })

  it('limits redirect loops', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://example.com/again' } }))
    await expect(secureFetch('https://example.com', { fetch, resolver: publicResolver, maxRedirects: 1 })).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' })
  })
})
