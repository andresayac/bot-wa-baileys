import { describe, expect, it, vi } from 'vitest'
import { assertSafeTarget, isPrivateAddress, secureFetch } from '../src/index.js'

const publicResolver = async () => ['93.184.216.34']

describe('@botmesh/http — IPv6 forms that embed a private IPv4', () => {
  it.each([
    '::7f00:1', // IPv4-compatible ::127.0.0.1
    '::ffff:7f00:1', // IPv4-mapped, hex form (what URL normalizes to)
    '::ffff:a9fe:a9fe', // 169.254.169.254 mapped
    '0:0:0:0:0:ffff:7f00:1',
    '64:ff9b::7f00:1', // NAT64 well-known prefix → 127.0.0.1
    '64:ff9b::a00:1', // NAT64 → 10.0.0.1
    '64:ff9b:1::a00:1', // local-use NAT64 prefix
    '2002:7f00:1::', // 6to4 of 127.0.0.1
    '2002:a9fe:a9fe::1', // 6to4 of 169.254.169.254
    '2001:0:4136:e378::1', // Teredo
    'fec0::1', // deprecated site-local
    '100::1', // discard-only
    '[::1]',
    '0000:0000:0000:0000:0000:0000:0000:0001',
  ])('treats %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it('keeps ordinary public IPv6 addresses public', () => {
    for (const address of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '64:ff9b::808:808', '2002:808:808::1']) {
      expect(isPrivateAddress(address)).toBe(false)
    }
  })

  it('blocks IPv6 literals that embed a loopback address in a URL', async () => {
    for (const url of ['https://[::127.0.0.1]/', 'https://[64:ff9b::127.0.0.1]/', 'https://[2002:7f00:1::]/']) {
      await expect(assertSafeTarget(new URL(url), { resolver: async (h) => [h.replace(/^\[|\]$/g, '')] })).rejects.toMatchObject({ code: 'UNSAFE_HOST' })
    }
  })
})

describe('@botmesh/http — redirects', () => {
  it('strips API-key style headers on a cross-origin redirect', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other.example/file' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    await secureFetch('https://api.example/start', {
      fetch,
      resolver: publicResolver,
      headers: { apikey: 'k1', 'x-api-key': 'k2', 'xi-api-key': 'k3', 'x-goog-api-key': 'k4', 'x-auth-token': 'k5', accept: 'application/json' },
    })
    const second = new Headers(fetch.mock.calls[1]![1]!.headers)
    for (const name of ['apikey', 'x-api-key', 'xi-api-key', 'x-goog-api-key', 'x-auth-token']) expect(second.has(name)).toBe(false)
    expect(second.get('accept')).toBe('application/json')
  })

  it('keeps API-key headers on a same-origin redirect', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    await secureFetch('https://api.example/start', { fetch, resolver: publicResolver, headers: { apikey: 'k1' } })
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).get('apikey')).toBe('k1')
  })

  it('turns a POST into a body-less GET on 303 (and on a 301/302 after POST)', async () => {
    for (const status of [301, 302, 303]) {
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(null, { status, headers: { location: 'https://api.example/result' } }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      await secureFetch('https://api.example/submit', {
        fetch,
        resolver: publicResolver,
        method: 'POST',
        body: '{"secret":"payload"}',
        headers: { 'content-type': 'application/json' },
      })
      const init = fetch.mock.calls[1]![1]!
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
      expect(new Headers(init.headers).has('content-type')).toBe(false)
    }
  })

  it('re-sends the body on a 307/308 to the same origin', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/v2/submit' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    await secureFetch('https://api.example/submit', { fetch, resolver: publicResolver, method: 'POST', body: 'x' })
    const init = fetch.mock.calls[1]![1]!
    expect(init.method).toBe('POST')
    expect(init.body).toBe('x')
  })
})
