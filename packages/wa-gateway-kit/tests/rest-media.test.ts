import { describe, it, expect } from 'vitest'
import { ProviderError } from '@botmesh/core'
import {
  describeErrorBody,
  guessMimetype,
  parseRetryAfter,
  resolveHttpPolicy,
  resolveMedia,
  restCall,
  toDataUri,
} from '../src/index.js'

const fakeFetch = (status: number, text: string, headers: Record<string, string> = {}) =>
  (async () => new Response(text, { status, headers })) as typeof fetch

describe('rest helpers', () => {
  it('parseRetryAfter reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('nope')).toBeUndefined()
    expect(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(0)
  })

  it('resolveHttpPolicy allows plain HTTP only for an http:// base URL, private hosts by default', () => {
    expect(resolveHttpPolicy('http://localhost:8080')).toMatchObject({ allowHttp: true, allowPrivateHosts: true, timeoutMs: 30_000 })
    expect(resolveHttpPolicy('https://gw.example.com').allowHttp).toBe(false)
  })

  it('describeErrorBody flattens the common gateway error shapes', () => {
    expect(describeErrorBody({ response: { message: 'bad number' } })).toBe('bad number')
    expect(describeErrorBody({ error: 'boom' })).toBe('boom')
    expect(describeErrorBody('x'.repeat(400))).toHaveLength(300)
  })

  it('restCall parses JSON, keeps non-JSON text, reports Retry-After', async () => {
    const http = { ...resolveHttpPolicy('http://127.0.0.1:1'), fetch: fakeFetch(429, '{"error":"slow"}', { 'retry-after': '2' }) }
    const res = await restCall('http://127.0.0.1:1/x', { method: 'GET' }, http)
    expect(res).toMatchObject({ status: 429, ok: false, body: { error: 'slow' }, retryAfterMs: 2000 })
    const text = await restCall('http://127.0.0.1:1/x', { method: 'GET' }, { ...http, fetch: fakeFetch(200, 'pong') })
    expect(text).toMatchObject({ ok: true, body: 'pong' })
  })

  it('restCall wraps transport failures in a ProviderError that shows the label, not the URL', async () => {
    const http = { ...resolveHttpPolicy('http://127.0.0.1:1'), fetch: (async () => { throw new TypeError('reset') }) as typeof fetch }
    const err = await restCall('http://127.0.0.1:1/secret-token/x', { method: 'POST', label: 'send' }, http).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as Error).message).toContain('send')
    expect((err as Error).message).not.toContain('secret-token')
  })
})

describe('media helpers', () => {
  it('passes public URLs through and inlines buffers as base64', async () => {
    expect(await resolveMedia('image', 'https://x.dev/a.png')).toEqual({ url: 'https://x.dev/a.png', filename: undefined, mimetype: undefined })
    const inline = await resolveMedia('document', Buffer.from('hi'), { filename: 'a.pdf' })
    expect(inline).toEqual({ base64: Buffer.from('hi').toString('base64'), filename: 'a.pdf', mimetype: 'application/pdf' })
    expect(toDataUri(inline)).toBe(`data:application/pdf;base64,${Buffer.from('hi').toString('base64')}`)
  })

  it('guessMimetype: explicit, then extension, then per-kind default', () => {
    expect(guessMimetype('image', 'a.png', 'image/x')).toBe('image/x')
    expect(guessMimetype('image', 'a.png')).toBe('image/png')
    expect(guessMimetype('voice')).toBe('audio/ogg; codecs=opus')
  })
})
