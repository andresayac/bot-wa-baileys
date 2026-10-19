/**
 * BaileysProvider.send must reject with a TYPED ProviderError (contract §8),
 * like the other transports — not leak a raw Boom/Baileys internal. mapSendError
 * is the pure classifier used on the send() catch path.
 */
import { describe, it, expect, vi } from 'vitest'
import { Boom } from '@hapi/boom'
import { BaileysProvider, mapSendError } from '../src/BaileysProvider.js'
import { RateLimiterTimeout, type RateLimitConfig } from '../src/RateLimiter.js'
import {
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  PayloadTooLargeError,
} from '@bot-wa/core'

describe('mapSendError', () => {
  it('maps 429 to RateLimitedError honoring retry-after', () => {
    const boom = new Boom('slow down', { statusCode: 429 })
    boom.output.headers = { 'retry-after': '5' }
    const e = mapSendError(boom, 'c@s.whatsapp.net')
    expect(e).toBeInstanceOf(RateLimitedError)
    expect((e as RateLimitedError).retryAfterMs).toBe(5000)
  })

  it('maps 429 without retry-after to a default delay', () => {
    const e = mapSendError(new Boom('slow', { statusCode: 429 }), 'c')
    expect(e).toBeInstanceOf(RateLimitedError)
    expect((e as RateLimitedError).retryAfterMs).toBe(1000)
  })

  it('maps 413 / "too large" to PayloadTooLargeError', () => {
    expect(mapSendError(new Boom('x', { statusCode: 413 }), 'c')).toBeInstanceOf(PayloadTooLargeError)
    expect(mapSendError(new Error('media too large'), 'c')).toBeInstanceOf(PayloadTooLargeError)
  })

  it('maps 403/forbidden to RecipientUnreachableError with the chatId', () => {
    const e = mapSendError(new Boom('nope', { statusCode: 403 }), 'victim@s.whatsapp.net')
    expect(e).toBeInstanceOf(RecipientUnreachableError)
    expect((e as RecipientUnreachableError).chatId).toBe('victim@s.whatsapp.net')
    expect(mapSendError(new Error('recipient blocked you'), 'c')).toBeInstanceOf(RecipientUnreachableError)
  })

  it('wraps an unknown error in a generic ProviderError, preserving cause', () => {
    const original = new Error('socket exploded')
    const e = mapSendError(original, 'c')
    expect(e).toBeInstanceOf(ProviderError)
    expect(e.constructor).toBe(ProviderError) // not a subclass
    expect(e.message).toBe('socket exploded')
    expect((e as { cause?: unknown }).cause).toBe(original)
  })

  it('passes an already-typed ProviderError through unchanged', () => {
    const typed = new RateLimitedError(2000)
    expect(mapSendError(typed, 'c')).toBe(typed)
  })
})

describe('BaileysProvider.send rejects only with ProviderError subclasses', () => {
  type Internals = { sock: unknown }
  const CHAT = '573001112233@s.whatsapp.net'

  function provider(rateLimit: RateLimitConfig) {
    const p = new BaileysProvider({ session: 'send-errors', rateLimit })
    const sock = { sendMessage: vi.fn(async (jid: string) => ({ key: { id: 'OUT', remoteJid: jid } })) }
    ;(p as unknown as Internals).sock = sock
    return { p, sock }
  }

  it('a rate-limiter maxWait timeout rejects as RateLimiterTimeout, a RateLimitedError', async () => {
    const { p, sock } = provider({ perChat: { max: 1, window: '1000s' }, maxWait: 50 })
    await p.send(CHAT, { kind: 'text', text: 'one' })

    const err = await p.send(CHAT, { kind: 'text', text: 'two' }).then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(RateLimiterTimeout)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimiterTimeout).chatId).toBe(CHAT)
    expect(sock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('a send still queued when stop() runs rejects with a ProviderError', async () => {
    const { p } = provider({ perChat: { max: 1, window: '1000s' } })
    await p.send(CHAT, { kind: 'text', text: 'one' })
    const queued = p.send(CHAT, { kind: 'text', text: 'two' })
    await new Promise((r) => setTimeout(r, 10))

    await p.stop()

    await expect(queued).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('BaileysProvider actions while disconnected', () => {
  it('downloadMedia rejects with a ProviderError instead of a TypeError', async () => {
    const p = new BaileysProvider({ session: 'test' })
    await expect(p.downloadMedia({ kind: 'image', token: { key: { id: 'x' }, message: {} } })).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('BaileysProvider message actions', () => {
  type Internals = { sock: unknown }
  const CHAT = '573001112233@s.whatsapp.net'

  function connected() {
    const p = new BaileysProvider({ session: 'actions' })
    const sock = {
      sendMessage: vi.fn(async () => undefined),
      readMessages: vi.fn(async () => undefined),
      updateMediaMessage: vi.fn(),
    }
    ;(p as unknown as Internals).sock = sock
    return { p, sock }
  }

  it('deleteMessage rejects with a ProviderError when disconnected', async () => {
    const p = new BaileysProvider({ session: 'actions' })
    await expect(p.deleteMessage({ id: 'M1', chatId: CHAT })).rejects.toBeInstanceOf(ProviderError)
  })

  it('deleteMessage uses the native key when the ref carries one', async () => {
    const { p, sock } = connected()
    const key = { remoteJid: '111@lid', id: 'M1', fromMe: true }
    await p.deleteMessage({ id: 'M1', chatId: CHAT, native: { key } })
    expect(sock.sendMessage).toHaveBeenCalledWith('111@lid', { delete: key })
  })

  it('deleteMessage rebuilds an own-message key from a ref without native (e.g. read from a store)', async () => {
    const { p, sock } = connected()
    await p.deleteMessage({ id: 'M1', chatId: CHAT })
    expect(sock.sendMessage).toHaveBeenCalledWith(CHAT, { delete: { remoteJid: CHAT, id: 'M1', fromMe: true } })
  })

  it('markRead uses native keys, rebuilds missing ones, and skips an empty batch', async () => {
    const { p, sock } = connected()
    const key = { remoteJid: CHAT, id: 'A', fromMe: false, participant: 'x@s.whatsapp.net' }
    await p.markRead([{ id: 'A', chatId: CHAT, native: { key } }, { id: 'B', chatId: CHAT }])
    expect(sock.readMessages).toHaveBeenCalledWith([key, { remoteJid: CHAT, id: 'B', fromMe: false }])

    await p.markRead([])
    expect(sock.readMessages).toHaveBeenCalledTimes(1)
  })

  it('downloadMedia rejects when the token is not a WAMessage', async () => {
    const { p } = connected()
    await expect(p.downloadMedia({ kind: 'image', token: 'nope' })).rejects.toBeInstanceOf(ProviderError)
  })

  it('downloadMedia wraps a download failure in a ProviderError with the cause', async () => {
    const { p } = connected()
    // A media message with no downloadable content makes Baileys throw.
    const token = { key: { id: 'x', remoteJid: CHAT }, message: { conversation: 'not media' } }
    const err = await p.downloadMedia({ kind: 'image', token }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error)
    expect((err as { cause?: unknown }).cause).not.toBeInstanceOf(ProviderError)
  })
})
