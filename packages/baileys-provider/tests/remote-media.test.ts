/**
 * Outbound `{ url }` media: Baileys downloads it with plain `fetch`, which
 * follows redirects without checking where they land. The provider must fetch
 * remote media itself through `@bot-wa/http` (every hop vetted, size-capped)
 * and hand Baileys a Buffer, so a public URL that redirects to an internal
 * address (cloud metadata, admin panels) cannot turn a send into SSRF.
 */
import { describe, it, expect, vi } from 'vitest'
import { ProviderError, PayloadTooLargeError } from '@bot-wa/core'
import { BaileysProvider, type BaileysProviderConfig } from '../src/BaileysProvider.js'

const CHAT = '573001112233@s.whatsapp.net'
const PUBLIC = async () => ['93.184.216.34']

function provider(remoteMedia: BaileysProviderConfig['remoteMedia']) {
  const p = new BaileysProvider({ session: 'remote-media', remoteMedia })
  const sock = { sendMessage: vi.fn(async (jid: string, _content: unknown) => ({ key: { id: 'OUT', remoteJid: jid } })) }
  ;(p as unknown as { sock: unknown }).sock = sock
  return { p, sock }
}

describe('BaileysProvider remote media', () => {
  it('downloads a public URL itself and sends a Buffer, not the URL', async () => {
    const fetch = vi.fn(async () => new Response(Buffer.from('PNGDATA'), { status: 200 }))
    const { p, sock } = provider({ resolver: PUBLIC, fetch })
    await p.send(CHAT, { kind: 'image', media: { url: 'https://cdn.example/a.png' }, caption: 'c' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const sent = sock.sendMessage.mock.calls[0]![1] as { image: unknown; caption: string }
    expect(Buffer.isBuffer(sent.image)).toBe(true)
    expect((sent.image as Buffer).toString()).toBe('PNGDATA')
    expect(sent.caption).toBe('c')
  })

  it('refuses a public URL that redirects to an internal address', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://attacker.example')
      ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
      : new Response('SECRET', { status: 200 }))
    const { p, sock } = provider({ resolver: PUBLIC, fetch })
    for (const media of [{ url: 'https://attacker.example/x' }, 'https://attacker.example/x']) {
      const err = await p.send(CHAT, { kind: 'document', media, filename: 'x' }).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(ProviderError)
    }
    expect(fetch).toHaveBeenCalledTimes(2) // only the public first hops; the internal target is never fetched
    expect(sock.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses a literal internal URL and caps the download size', async () => {
    const fetch = vi.fn(async () => new Response(Buffer.alloc(32), { status: 200 }))
    const { p, sock } = provider({ resolver: PUBLIC, fetch, maxBytes: 16 })
    await expect(p.send(CHAT, { kind: 'video', media: { url: 'http://127.0.0.1/v.mp4' } })).rejects.toBeInstanceOf(ProviderError)
    expect(fetch).not.toHaveBeenCalled()
    await expect(p.send(CHAT, { kind: 'audio', media: { url: 'https://cdn.example/a.ogg' } })).rejects.toBeInstanceOf(PayloadTooLargeError)
    expect(sock.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses a non-2xx response instead of sending an error page', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 404 }))
    const { p, sock } = provider({ resolver: PUBLIC, fetch })
    await expect(p.send(CHAT, { kind: 'image', media: { url: 'https://cdn.example/missing.png' } })).rejects.toBeInstanceOf(ProviderError)
    expect(sock.sendMessage).not.toHaveBeenCalled()
  })

  it('allowPrivateHosts keeps the legacy pass-through (Baileys streams the URL)', async () => {
    const fetch = vi.fn()
    const { p, sock } = provider({ allowPrivateHosts: true, fetch })
    await p.send(CHAT, { kind: 'image', media: { url: 'http://10.0.0.5/a.png' } })
    expect(fetch).not.toHaveBeenCalled()
    expect((sock.sendMessage.mock.calls[0]![1] as { image: unknown }).image).toEqual({ url: 'http://10.0.0.5/a.png' })
  })
})
