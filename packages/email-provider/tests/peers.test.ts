import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderError } from '@botmesh/core'
import { EmailProvider } from '../src/index.js'
import { loadModule } from '../src/loadModule.js'
import { email, FakeImapServer, FakeSmtp, waitFor } from './support/fakes.js'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

afterEach(() => {
  vi.doUnmock('imapflow')
  vi.doUnmock('nodemailer')
})

describe('optional peers (lazy)', () => {
  it('builds an ImapFlow client from the imap config on start', async () => {
    const server = new FakeImapServer()
    const ctorOpts: Array<Record<string, unknown>> = []
    vi.doMock('imapflow', () => ({
      ImapFlow: function ImapFlow(this: unknown, opts: Record<string, unknown>) {
        ctorOpts.push(opts)
        return server.createClient()
      },
    }))
    const provider = new EmailProvider({
      imap: { host: 'imap.example.com', user: 'bot@acme.test', pass: 'secret', options: { tls: { rejectUnauthorized: true } } },
      smtpTransport: new FakeSmtp(),
      logger: silent,
    })
    const seen: string[] = []
    provider.onEvent((e) => { if (e.kind === 'message') seen.push(e.message.body) })
    server.add(email(['From: a@example.com', 'Message-ID: <p1@example.com>'], 'hola'))
    await provider.start()
    await waitFor(() => seen.length === 1)
    expect(ctorOpts[0]).toEqual({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'bot@acme.test', pass: 'secret' },
      logger: false,
      // imapflow waits this long after the last command before it IDLEs again (its default, 15 s, delays new mail).
      autoIdleDelay: 1000,
      tls: { rejectUnauthorized: true },
    })
    expect(provider.selfId).toBe('bot@acme.test') // derived from imap.user
    await provider.stop()
  })

  it('builds a nodemailer transport lazily on first send (OAuth2 + STARTTLS port)', async () => {
    const smtp = new FakeSmtp()
    const createTransport = vi.fn(() => smtp)
    vi.doMock('nodemailer', () => ({ default: { createTransport } }))
    const provider = new EmailProvider({
      address: 'bot@acme.test',
      smtp: { host: 'smtp.example.com', port: 587, user: 'bot@acme.test', accessToken: 'tok' },
      logger: silent,
    })
    await provider.start()
    expect(createTransport).not.toHaveBeenCalled()
    await provider.send('a@example.com', { kind: 'text', text: 'x' })
    await provider.send('a@example.com', { kind: 'text', text: 'y' })
    expect(createTransport).toHaveBeenCalledTimes(1)
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com', port: 587, secure: false, auth: { type: 'OAuth2', user: 'bot@acme.test', accessToken: 'tok' },
    })
    expect(smtp.sent).toHaveLength(2)
    await provider.stop()
  })

  it('explains how to install a missing peer', async () => {
    vi.doMock('imapflow', () => { throw new Error('Cannot find package imapflow') })
    vi.doMock('nodemailer', () => { throw new Error('Cannot find package nodemailer') })
    await expect(loadModule('imapflow', 'IMAP inbound')).rejects.toThrow(/pnpm add imapflow/)

    const imapOnly = new EmailProvider({ address: 'bot@acme.test', imap: { host: 'imap.example.com', user: 'bot', pass: 'x' }, logger: silent })
    await expect(imapOnly.start()).rejects.toThrow(/imapflow/)

    const smtpOnly = new EmailProvider({ address: 'bot@acme.test', smtp: { host: 'smtp.example.com', user: 'bot', pass: 'x' }, logger: silent })
    await smtpOnly.start()
    const err = await smtpOnly.send('a@example.com', { kind: 'text', text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as Error).message).toMatch(/nodemailer/)
    await smtpOnly.stop()

    const none = new EmailProvider({ address: 'bot@acme.test', logger: silent })
    await none.start()
    await expect(none.send('a@example.com', { kind: 'text', text: 'x' })).rejects.toThrow(/smtp/i)
  })
})
