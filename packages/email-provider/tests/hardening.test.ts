import { afterEach, describe, expect, it } from 'vitest'
import { PayloadTooLargeError, UnsupportedContentError, type InboundEvent, type InboundMessage } from '@botmesh/core'
import { EmailProvider, type EmailProviderConfig, type EmailRaw } from '../src/index.js'
import { email, FakeImapServer, FakeSmtp, waitFor } from './support/fakes.js'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(overrides: Partial<EmailProviderConfig> = {}) {
  const server = new FakeImapServer()
  const smtp = new FakeSmtp()
  const provider = new EmailProvider({
    address: 'bot@acme.test',
    createImapClient: server.createClient,
    smtpTransport: smtp,
    logger: silent,
    reconnect: { baseMs: 1, maxMs: 5 },
    ...overrides,
  })
  const events: InboundEvent[] = []
  provider.onEvent((e) => { events.push(e) })
  const messages = (): InboundMessage<EmailRaw>[] =>
    events.filter((e): e is Extract<InboundEvent, { kind: 'message' }> => e.kind === 'message').map((e) => e.message as InboundMessage<EmailRaw>)
  const statuses = () => events.filter((e) => e.kind === 'status')
  return { server, smtp, provider, events, messages, statuses }
}

const mail = (from: string, id: string, extra: string[] = [], body = 'Hola') =>
  email([`From: ${from}`, 'To: bot@acme.test', 'Subject: Consulta', `Message-ID: <${id}>`, ...extra], body)

const withAttachment = (id: string, content: Buffer, from = 'ana@example.com') => email([
  `From: ${from}`, `Message-ID: <${id}>`, 'Content-Type: multipart/mixed; boundary=B',
], ['--B', 'Content-Type: application/octet-stream; name=a.bin', 'Content-Disposition: attachment; filename=a.bin',
  'Content-Transfer-Encoding: base64', '', content.toString('base64'), '--B--'].join('\r\n'))

let current: EmailProvider | undefined
afterEach(async () => {
  await current?.stop()
  current = undefined
})

describe('IMAP backlog scan', () => {
  it('does not replay already-read mail when the first unseen scan fails', async () => {
    const t = setup({ markSeen: false })
    current = t.provider
    for (let i = 0; i < 5; i++) t.server.add(mail('ana@example.com', `old${i}@x`), true)
    t.server.add(mail('ana@example.com', 'new@x'))
    t.server.searchError = new Error('connection reset')
    await t.provider.start()
    await waitFor(() => t.messages().length >= 1)
    await new Promise((r) => setTimeout(r, 30))
    expect(t.messages().map((m) => m.ref.id)).toEqual(['new@x'])
    t.server.deliver(mail('ana@example.com', 'later@x'))
    await waitFor(() => t.messages().length === 2)
    expect(t.messages().map((m) => m.ref.id)).toEqual(['new@x', 'later@x'])
  })

  it('fetches large backlogs in bounded batches', async () => {
    const t = setup()
    current = t.provider
    for (let i = 0; i < 45; i++) t.server.add(mail(`u${i}@example.com`, `b${i}@x`))
    await t.provider.start()
    await waitFor(() => t.messages().length === 45)
    expect(t.server.sourceFetches.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...t.server.sourceFetches.map((r) => r.length))).toBeLessThanOrEqual(20)
    expect(new Set(t.messages().map((m) => m.ref.id)).size).toBe(45)
  })

  it('skips inbound mail larger than maxInboundBytes without downloading it', async () => {
    const t = setup({ maxInboundBytes: 2000 })
    current = t.provider
    const big = t.server.add(mail('ana@example.com', 'big@x', [], 'x'.repeat(5000)))
    t.server.add(mail('ana@example.com', 'small@x'))
    await t.provider.start()
    await waitFor(() => t.messages().length === 1)
    expect(t.messages()[0]!.ref.id).toBe('small@x')
    expect(t.server.sourceFetches.flat()).not.toContain(big)
    expect(t.server.messages.find((m) => m.uid === big)!.seen).toBe(true) // never rescanned
  })

  it('rejects oversized ingest() payloads with 413', async () => {
    const t = setup({ maxInboundBytes: 2000, createImapClient: undefined })
    current = t.provider
    await t.provider.start()
    await expect(t.provider.ingest(mail('ana@example.com', 'big@x', [], 'x'.repeat(5000))))
      .resolves.toEqual({ status: 413, accepted: false, reason: 'too-large' })
    expect(t.messages()).toHaveLength(0)
  })
})

describe('bounce forgery', () => {
  const dsn = (originalId: string, rcpt: string, from = 'MAILER-DAEMON@mx.example.com') => email([
    `From: ${from}`, 'Message-ID: <dsn@mx.example.com>', 'Subject: Undelivered Mail',
    'Content-Type: multipart/report; report-type=delivery-status; boundary=R',
  ], ['--R', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.example.com', '',
    `Final-Recipient: rfc822; ${rcpt}`, 'Action: failed', 'Status: 5.1.1', '--R',
    'Content-Type: text/rfc822-headers', '', `Message-ID: <${originalId}>`, '--R--'].join('\r\n'))

  it('ignores X-Failed-Recipients from an ordinary sender', async () => {
    const t = setup({ createImapClient: undefined })
    current = t.provider
    await t.provider.start()
    const res = await t.provider.ingest(mail('attacker@evil.test', 'f@evil.test', ['X-Failed-Recipients: ceo@acme-customer.test']))
    expect(res.accepted).toBe(false)
    expect(t.provider.suppressedAddresses()).toEqual([])
    expect(t.statuses()).toHaveLength(0)
    await expect(t.provider.send('ceo@acme-customer.test', { kind: 'text', text: 'hola' })).resolves.toBeDefined()
  })

  it('ignores a DSN for a Message-ID the bot never sent', async () => {
    const t = setup({ createImapClient: undefined })
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(mail('ana@example.com', 'in1@example.com'))
    // in1 is an inbound id (known to the index), not one the bot sent.
    await t.provider.ingest(dsn('in1@example.com', 'ana@example.com'))
    await t.provider.ingest(dsn('random@acme.test', 'ceo@acme-customer.test'))
    expect(t.provider.suppressedAddresses()).toEqual([])
    expect(t.statuses()).toHaveLength(0)
  })

  it('ignores a DSN whose recipient is not the counterpart of the bounced thread', async () => {
    const t = setup({ createImapClient: undefined })
    current = t.provider
    await t.provider.start()
    const sent = await t.provider.send('ana@example.com', { kind: 'text', text: 'hola' })
    await t.provider.ingest(dsn(sent.ref.id, 'ceo@acme-customer.test'))
    expect(t.provider.suppressedAddresses()).toEqual([])
    expect(t.statuses()).toHaveLength(0)
    await t.provider.ingest(dsn(sent.ref.id, 'Ana@Example.com'))
    expect(t.provider.suppressedAddresses()).toEqual(['ana@example.com'])
    expect(t.statuses()).toHaveLength(1)
  })

  it('accepts a legacy bounce only from a system sender for a message the bot sent', async () => {
    const t = setup({ createImapClient: undefined })
    current = t.provider
    await t.provider.start()
    const sent = await t.provider.send('ana@example.com', { kind: 'text', text: 'hola' })
    const legacy = (from: string) => email([`From: ${from}`, 'Subject: Mail delivery failed', 'X-Failed-Recipients: ana@example.com', 'Message-ID: <l@mx>'],
      `This message could not be delivered.\r\n\r\nMessage-ID: <${sent.ref.id}>`)
    await t.provider.ingest(legacy('ana@example.com'))
    expect(t.provider.suppressedAddresses()).toEqual([])
    await t.provider.ingest(legacy('Mail Delivery System <MAILER-DAEMON@mx.example.com>'))
    expect(t.provider.suppressedAddresses()).toEqual(['ana@example.com'])
  })
})

describe('thread ownership', () => {
  it('keeps a third party who replies into a thread out of the original chat', async () => {
    const t = setup({ createImapClient: undefined })
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(mail('ana@example.com', 'root@x'))
    await t.provider.ingest(mail('mallory@evil.test', 'm1@evil.test', ['In-Reply-To: <root@x>', 'References: <root@x>']))
    const [a, m] = t.messages()
    expect(a!.chatId).toBe('thread:root@x')
    expect(m!.chatId).not.toBe(a!.chatId)
    await t.provider.send(a!.chatId, { kind: 'text', text: 'datos de Ana' })
    expect(t.smtp.sent[0]!.to).toMatchObject({ address: 'ana@example.com' })
    await t.provider.send(m!.chatId, { kind: 'text', text: 'hola' })
    expect(t.smtp.sent[1]!.to).toMatchObject({ address: 'mallory@evil.test' })
    expect(t.smtp.sent[1]!.inReplyTo).toBe('<m1@evil.test>')

    // Mallory keeps her own chat; Ana replying to Mallory's message stays in hers.
    await t.provider.ingest(mail('mallory@evil.test', 'm2@evil.test', ['In-Reply-To: <m1@evil.test>']))
    await t.provider.ingest(mail('ana@example.com', 'a2@x', ['In-Reply-To: <m1@evil.test>']))
    expect(t.messages()[2]!.chatId).toBe(m!.chatId)
    expect(t.messages()[3]!.chatId).toBe(a!.chatId)
  })

  it('ignores a cross-domain Reply-To by default and honours it with replyTo: "always"', async () => {
    const t = setup({ createImapClient: undefined })
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(mail('ana@example.com', 'r1@x', ['Reply-To: thief@evil.test']))
    await t.provider.send(t.messages()[0]!.chatId, { kind: 'text', text: 'x' })
    expect(t.smtp.sent[0]!.to).toMatchObject({ address: 'ana@example.com' })

    const s = setup({ createImapClient: undefined, threading: 'sender' })
    await s.provider.start()
    await s.provider.ingest(mail('ana@example.com', 'r2@x', ['Reply-To: thief@evil.test']))
    await s.provider.send('ana@example.com', { kind: 'text', text: 'x' })
    expect(s.smtp.sent[0]!.to).toMatchObject({ address: 'ana@example.com' })
    await s.provider.stop()

    const always = setup({ createImapClient: undefined, replyTo: 'always' })
    await always.provider.start()
    await always.provider.ingest(mail('ana@example.com', 'r3@x', ['Reply-To: desk@other.test']))
    await always.provider.send(always.messages()[0]!.chatId, { kind: 'text', text: 'x' })
    expect(always.smtp.sent[0]!.to).toMatchObject({ address: 'desk@other.test' })
    await always.provider.stop()
  })

  it('can require a passing Authentication-Results from the trusted MTA', async () => {
    const t = setup({ createImapClient: undefined, requireAuthentication: { authservId: 'mx.acme.test' } })
    current = t.provider
    await t.provider.start()
    await expect(t.provider.ingest(mail('ana@example.com', 'u1@x'))).resolves.toMatchObject({ accepted: false, reason: 'unauthenticated' })
    await expect(t.provider.ingest(mail('ana@example.com', 'u2@x', ['Authentication-Results: evil.test; dmarc=pass header.from=example.com'])))
      .resolves.toMatchObject({ accepted: false, reason: 'unauthenticated' })
    await expect(t.provider.ingest(mail('ana@example.com', 'u3@x', ['Authentication-Results: mx.acme.test; dkim=pass header.d=other.test; dmarc=fail'])))
      .resolves.toMatchObject({ accepted: false, reason: 'unauthenticated' })
    await expect(t.provider.ingest(mail('ana@example.com', 'u4@x', ['Authentication-Results: mx.acme.test; dmarc=pass (p=reject) header.from=example.com'])))
      .resolves.toEqual({ status: 200, accepted: true })
    await expect(t.provider.ingest(mail('ana@example.com', 'u5@x', ['Authentication-Results: MX.acme.test; spf=fail; dkim=pass header.d=mail.example.com'])))
      .resolves.toEqual({ status: 200, accepted: true })
  })
})

describe('attachment cache and refetch', () => {
  it('keeps byte accounting correct when the same attachment is cached twice', async () => {
    const t = setup({ createImapClient: undefined, attachmentCacheBytes: 100, loopProtection: { maxPerSender: false } })
    current = t.provider
    await t.provider.start()
    const raw = withAttachment('dup@x', Buffer.alloc(60, 1))
    await t.provider.ingest(raw)
    await t.provider.ingest(raw)
    await t.provider.ingest(withAttachment('other@x', Buffer.alloc(30, 2)))
    const [first, , other] = t.messages()
    expect((await t.provider.downloadMedia(first!.media!)).length).toBe(60)
    expect((await t.provider.downloadMedia(other!.media!)).length).toBe(30)
  })

  it('refuses to return an attachment when the UID now holds another message', async () => {
    const t = setup({ attachmentCacheBytes: 0 })
    current = t.provider
    const uid = t.server.add(withAttachment('mine@x', Buffer.from('ANA-SECRET')))
    await t.provider.start()
    await waitFor(() => t.messages().length === 1)
    const ref = t.messages()[0]!.media!
    t.server.messages.find((m) => m.uid === uid)!.source = Buffer.from(withAttachment('theirs@x', Buffer.from('OTHER')))
    await expect(t.provider.downloadMedia(ref)).rejects.toThrow(/no longer available/)
  })

  it('refuses to refetch by UID after UIDVALIDITY changed', async () => {
    const t = setup({ attachmentCacheBytes: 0 })
    current = t.provider
    t.server.add(withAttachment('v@x', Buffer.from('DATA')))
    await t.provider.start()
    await waitFor(() => t.messages().length === 1)
    const ref = t.messages()[0]!.media!
    expect((ref.token as { uidValidity?: string }).uidValidity).toBe('7')
    t.server.uidValidity = 8n
    t.server.current!.drop()
    await waitFor(() => t.server.clients.length === 2 && !!t.server.current)
    await expect(t.provider.downloadMedia(ref)).rejects.toThrow(/no longer available/)
  })
})


describe('native payload validation', () => {
  it('rejects native attachments given by path or URL with UnsupportedContentError', async () => {
    const t = setup({ createImapClient: undefined })
    current = t.provider
    await t.provider.start()
    for (const att of [{ path: 'https://169.254.169.254/latest' }, { path: '/etc/passwd', content: Buffer.from('x') }, { href: 'http://x.test/a' }, 'nope']) {
      await expect(t.provider.send('a@x.com', { kind: 'native', provider: 'email', payload: { text: 'x', attachments: [att] } }))
        .rejects.toBeInstanceOf(UnsupportedContentError)
    }
    expect(t.smtp.sent).toHaveLength(0)
  })

  it('accepts in-memory native attachments and keeps loop-protection headers', async () => {
    const t = setup({ createImapClient: undefined })
    current = t.provider
    await t.provider.start()
    await t.provider.send('a@x.com', { kind: 'native', provider: 'email', payload: {
      text: 'x',
      attachments: [{ filename: 'a.txt', content: new Uint8Array([104, 105]), contentType: 'text/plain', cid: 'c1' }],
      headers: { 'auto-submitted': 'no', 'X-Auto-Response-Suppress': 'None', 'Message-ID': '<forged@x>', 'X-Ticket': '42' },
    } })
    const sent = t.smtp.sent[0]!
    expect(Buffer.isBuffer(sent.attachments![0]!.content)).toBe(true)
    expect(sent.attachments![0]).toMatchObject({ filename: 'a.txt', contentType: 'text/plain', cid: 'c1' })
    expect(sent.headers).toEqual({ 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', 'X-Ticket': '42' })
  })

  it('counts native attachments against maxAttachmentBytes', async () => {
    const t = setup({ createImapClient: undefined, maxAttachmentBytes: 10 })
    current = t.provider
    await t.provider.start()
    await expect(t.provider.send('a@x.com', { kind: 'native', provider: 'email', payload: { attachments: [{ content: Buffer.alloc(11) }] } }))
      .rejects.toBeInstanceOf(PayloadTooLargeError)
  })
})
