import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type InboundEvent,
  type InboundMessage,
} from '@bot-wa/core'
import { EmailProvider, type EmailProviderConfig, type EmailRaw } from '../src/index.js'
import { email, FakeImapServer, FakeSmtp, waitFor } from './support/fakes.js'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(overrides: Partial<EmailProviderConfig> = {}) {
  const server = new FakeImapServer()
  const smtp = new FakeSmtp()
  const provider = new EmailProvider({
    address: 'Bot@Acme.test',
    fromName: 'Acme Bot',
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
  return { server, smtp, provider, events, messages }
}

const ana = (id: string, extra: string[] = [], body = 'Hola, ¿tienen stock?') =>
  email(['From: "Ana Pérez" <Ana@Example.COM>', 'To: bot@acme.test', 'Subject: Consulta de stock', `Message-ID: <${id}>`, 'Date: Tue, 14 Oct 2025 10:00:00 +0000', ...extra], body)

let current: EmailProvider | undefined
afterEach(async () => {
  await current?.stop()
  current = undefined
})

describe('EmailProvider inbound (IMAP)', () => {
  it('processes unseen mail on start, normalizes it and marks it seen', async () => {
    const t = setup()
    current = t.provider
    t.server.add(ana('old@example.com'), true) // already read: ignored
    t.server.add(ana('m1@example.com'))
    await t.provider.start()
    await waitFor(() => t.messages().length === 1)
    const m = t.messages()[0]!
    expect(m).toMatchObject({
      chatId: 'thread:m1@example.com',
      from: 'thread:m1@example.com',
      senderId: 'ana@example.com',
      sender: 'ana@example.com',
      type: 'text',
      body: 'Hola, ¿tienen stock?',
      isGroup: false,
      fromMe: false,
      ref: { id: 'm1@example.com', chatId: 'thread:m1@example.com' },
      chat: { kind: 'dm', name: 'Consulta de stock', isGroup: false, isBroadcast: false },
      senderInfo: { id: 'ana@example.com', displayName: 'Ana Pérez', username: 'Ana@Example.COM' },
      timestamp: Date.parse('2025-10-14T10:00:00Z'),
    })
    expect(m.raw.subject).toBe('Consulta de stock')
    expect(m.raw.uid).toBe(2)
    expect(t.server.messages.every((x) => x.seen)).toBe(true)
    expect(t.events.some((e) => e.kind === 'connection' && e.update.state === 'ready')).toBe(true)
    expect(t.provider.selfId).toBe('bot@acme.test')
  })

  it('picks up new mail announced while idling, without replaying old mail', async () => {
    const t = setup({ processExisting: 'none' })
    current = t.provider
    t.server.add(ana('before@example.com'))
    await t.provider.start()
    t.server.deliver(ana('after@example.com'))
    await waitFor(() => t.messages().length === 1)
    expect(t.messages()[0]!.ref.id).toBe('after@example.com')
    t.server.deliver(ana('after2@example.com'))
    await waitFor(() => t.messages().length === 2)
    expect(t.messages().map((m) => m.ref.id)).toEqual(['after@example.com', 'after2@example.com'])
  })

  it('leaves messages unseen when markSeen is false but still processes each once', async () => {
    const t = setup({ markSeen: false })
    current = t.provider
    t.server.add(ana('a@example.com'))
    await t.provider.start()
    t.server.deliver(ana('b@example.com'))
    await waitFor(() => t.messages().length === 2)
    t.server.deliver(ana('c@example.com'))
    await waitFor(() => t.messages().length === 3)
    expect(t.messages().map((m) => m.ref.id)).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
    expect(t.server.messages.some((x) => x.seen)).toBe(false)
  })

  it('strips quoted history and falls back to the subject for empty bodies', async () => {
    const t = setup()
    current = t.provider
    t.server.add(ana('q@example.com', [], 'Sí, por favor\r\n\r\nEl mar, 14 oct 2025, Bot <bot@acme.test> escribió:\r\n> ¿Lo reservo?'))
    t.server.add(email(['From: x@example.com', 'Subject: Precio del plan Pro', 'Message-ID: <s@example.com>'], ''))
    await t.provider.start()
    await waitFor(() => t.messages().length === 2)
    expect(t.messages()[0]!.body).toBe('Sí, por favor')
    expect(t.messages()[0]!.raw.text).toContain('escribió')
    expect(t.messages()[1]!.body).toBe('Precio del plan Pro')
  })

  it('converts HTML-only bodies to text', async () => {
    const t = setup()
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(email(['From: h@example.com', 'Message-ID: <h@example.com>', 'Content-Type: text/html; charset=utf-8'], '<div>Quiero <b>3</b> unidades</div><div>Gracias</div>'))
    expect(t.messages()[0]!.body).toBe('Quiero 3 unidades\nGracias')
  })

  it('exposes attachments as media refs and downloads them (cache, then IMAP refetch)', async () => {
    const t = setup({ attachmentCacheBytes: 0 })
    current = t.provider
    const pdf = Buffer.from('%PDF-1.7 factura')
    t.server.add(email([
      'From: ana@example.com', 'Message-ID: <att@example.com>', 'Subject: Factura',
      'Content-Type: multipart/mixed; boundary=XX',
    ], ['--XX', 'Content-Type: text/plain', '', 'Adjunto factura', '--XX',
      'Content-Type: application/pdf; name=factura.pdf', 'Content-Disposition: attachment; filename=factura.pdf',
      'Content-Transfer-Encoding: base64', '', pdf.toString('base64'), '--XX--'].join('\r\n')))
    await t.provider.start()
    await waitFor(() => t.messages().length === 1)
    const m = t.messages()[0]!
    expect(m.type).toBe('document')
    expect(m.body).toBe('Adjunto factura')
    expect(m.media).toMatchObject({ kind: 'document', mimetype: 'application/pdf', filename: 'factura.pdf', size: pdf.length })
    expect(m.raw.attachments).toHaveLength(1)
    const fetchesBefore = t.server.fetchCalls
    const bytes = await t.provider.downloadMedia(m.media!)
    expect(Buffer.from(bytes as Buffer).toString()).toBe('%PDF-1.7 factura')
    expect(t.server.fetchCalls).toBe(fetchesBefore + 1) // cache disabled -> refetched by UID
  })

  it('serves attachments from the in-memory cache when it fits', async () => {
    const t = setup()
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(email([
      'From: ana@example.com', 'Message-ID: <img@example.com>', 'Content-Type: multipart/mixed; boundary=B',
    ], ['--B', 'Content-Type: image/png; name=a.png', 'Content-Transfer-Encoding: base64', '', Buffer.from('PNGDATA').toString('base64'), '--B--'].join('\r\n')))
    const m = t.messages()[0]!
    expect(m.type).toBe('image')
    expect(m.body).toBe('')
    expect(String(await t.provider.downloadMedia(m.media!))).toBe('PNGDATA')
  })

  it('synthesizes a stable id for mail without Message-ID', async () => {
    const t = setup()
    current = t.provider
    await t.provider.start()
    const raw = email(['From: n@example.com', 'Subject: sin id'], 'x')
    await t.provider.ingest(raw)
    await t.provider.ingest(Buffer.from(raw))
    const [a, b] = t.messages()
    expect(a!.ref.id).toMatch(/^synthetic-[0-9a-f]{32}$/)
    expect(b!.ref.id).toBe(a!.ref.id)
  })

  it('keys chats by sender address in sender mode', async () => {
    const t = setup({ threading: 'sender' })
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(ana('s1@example.com'))
    await t.provider.ingest(email(['From: ana@example.com', 'Subject: Otro tema', 'Message-ID: <s2@example.com>'], 'x'))
    expect(t.messages().map((m) => m.chatId)).toEqual(['ana@example.com', 'ana@example.com'])
  })
})

describe('EmailProvider loop protection', () => {
  it('drops automated mail, mailing lists and its own messages', async () => {
    const t = setup()
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(ana('ooo@example.com', ['Auto-Submitted: auto-replied']))
    await t.provider.ingest(ana('list@example.com', ['List-Id: <promo.example.com>']))
    await t.provider.ingest(email(['From: Acme Bot <BOT@acme.test>', 'Message-ID: <self@acme.test>'], 'x'))
    await t.provider.ingest(ana('ok@example.com'))
    expect(t.messages().map((m) => m.ref.id)).toEqual(['ok@example.com'])
  })

  it('can ignore selected reasons or be disabled', async () => {
    const t = setup({ loopProtection: { ignore: ['mailing-list'] } })
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(ana('list@example.com', ['List-Id: <promo.example.com>']))
    await t.provider.ingest(ana('ooo@example.com', ['Auto-Submitted: auto-replied']))
    expect(t.messages().map((m) => m.ref.id)).toEqual(['list@example.com'])

    const off = setup({ loopProtection: false })
    await off.provider.start()
    await off.provider.ingest(ana('ooo@example.com', ['Auto-Submitted: auto-replied']))
    expect(off.messages()).toHaveLength(1)
    await off.provider.stop()
  })

  it('caps messages per sender to break loops with header-less robots', async () => {
    const t = setup({ loopProtection: { maxPerSender: { max: 2, windowMs: 60_000 } } })
    current = t.provider
    await t.provider.start()
    for (let i = 0; i < 4; i++) await t.provider.ingest(ana(`f${i}@example.com`))
    expect(t.messages()).toHaveLength(2)
  })
})

describe('EmailProvider outbound (SMTP)', () => {
  it('replies in-thread with RFC 5322 threading and RFC 3834 headers', async () => {
    const t = setup()
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(ana('m1@example.com', ['References: <root@example.com>', 'In-Reply-To: <root@example.com>']))
    const chatId = t.messages()[0]!.chatId
    expect(chatId).toBe('thread:root@example.com')
    const res = await t.provider.send(chatId, { kind: 'text', text: 'Sí, hay 3 en stock.' })
    const mail = t.smtp.sent[0]!
    expect(mail).toMatchObject({
      from: { name: 'Acme Bot', address: 'Bot@Acme.test' },
      to: { name: 'Ana Pérez', address: 'Ana@Example.COM' },
      subject: 'Re: Consulta de stock',
      text: 'Sí, hay 3 en stock.',
      inReplyTo: '<m1@example.com>',
      references: ['<root@example.com>', '<m1@example.com>'],
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
    })
    expect(mail.messageId).toMatch(/^<[0-9a-f-]{36}@acme\.test>$/)
    expect(res.ref).toEqual({ id: mail.messageId.slice(1, -1), chatId })

    // The human answers the bot's email: same chat, even if their client drops References.
    await t.provider.ingest(email(['From: ana@example.com', 'Message-ID: <m2@example.com>', `In-Reply-To: ${mail.messageId}`], 'gracias'))
    expect(t.messages()[1]!.chatId).toBe(chatId)
    expect(t.messages()[1]!.quoted?.ref).toEqual({ id: res.ref.id, chatId })

    await t.provider.send(chatId, { kind: 'text', text: 'De nada' })
    expect(t.smtp.sent[1]).toMatchObject({ inReplyTo: '<m2@example.com>', subject: 'Re: Consulta de stock' })
    expect(t.smtp.sent[1]!.references).toEqual(['<root@example.com>', '<m1@example.com>', `${mail.messageId}`, '<m2@example.com>'])
  })

  it('replies to Reply-To and honours subject/html overrides and disabled Auto-Submitted', async () => {
    const t = setup({ autoSubmitted: false })
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(ana('r@example.com', ['Reply-To: soporte@example.com']))
    await t.provider.send(t.messages()[0]!.chatId, { kind: 'text', text: 'hola' }, { platformData: { subject: 'Ticket #9', html: '<p>hola</p>' } })
    expect(t.smtp.sent[0]).toMatchObject({ to: { address: 'soporte@example.com' }, subject: 'Ticket #9', html: '<p>hola</p>' })
    expect(t.smtp.sent[0]!.headers).toEqual({})
  })

  it('starts a new conversation when sending to a bare address, and threads the answer into it', async () => {
    const t = setup()
    current = t.provider
    await t.provider.start()
    const res = await t.provider.send('Nuevo@Example.com', { kind: 'text', text: 'Tu pedido salió' }, { platformData: { subject: 'Pedido enviado' } })
    expect(t.smtp.sent[0]).toMatchObject({ to: { address: 'Nuevo@Example.com' }, subject: 'Pedido enviado' })
    expect(t.smtp.sent[0]!.inReplyTo).toBeUndefined()
    await t.provider.ingest(email(['From: nuevo@example.com', 'Message-ID: <n2@example.com>', `In-Reply-To: <${res.ref.id}>`, 'Subject: Re: Pedido enviado'], 'ok'))
    expect(t.messages()[0]!.chatId).toBe('Nuevo@Example.com')
    await t.provider.send('Nuevo@Example.com', { kind: 'text', text: 'genial' })
    expect(t.smtp.sent[1]).toMatchObject({ subject: 'Re: Pedido enviado', inReplyTo: '<n2@example.com>' })
  })

  it('uses the default subject for a fresh address without a subject', async () => {
    const t = setup({ defaultSubject: 'Mensaje de Acme' })
    current = t.provider
    await t.provider.start()
    await t.provider.send('x@example.com', { kind: 'text', text: 'hola' })
    expect(t.smtp.sent[0]!.subject).toBe('Mensaje de Acme')
  })

  it('rejects unknown thread chatIds with RecipientUnreachableError', async () => {
    const t = setup()
    current = t.provider
    await t.provider.start()
    await expect(t.provider.send('thread:nope@x', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(RecipientUnreachableError)
  })

  it('sends media as attachments and degrades buttons/lists/location to text', async () => {
    const fakeFetch = vi.fn(async () => new Response(Buffer.from('JPEGDATA'), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    const t = setup({ http: { fetch: fakeFetch as unknown as typeof fetch, resolver: async () => ['93.184.216.34'] } })
    current = t.provider
    await t.provider.start()
    await t.provider.send('a@example.com', { kind: 'image', media: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]), caption: 'Mirá' })
    expect(t.smtp.sent[0]).toMatchObject({ text: 'Mirá', attachments: [{ filename: 'image.png', contentType: 'image/png' }] })
    await t.provider.send('a@example.com', { kind: 'document', media: { buffer: Buffer.from('x') }, filename: 'f.txt', mimetype: 'text/plain' })
    expect(t.smtp.sent[1]!.attachments).toEqual([{ filename: 'f.txt', content: Buffer.from('x'), contentType: 'text/plain' }])
    await t.provider.send('a@example.com', { kind: 'image', media: 'https://cdn.example.com/p/foto.jpg' })
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    expect(t.smtp.sent[2]!.attachments).toEqual([{ filename: 'foto.jpg', content: Buffer.from('JPEGDATA'), contentType: 'image/jpeg' }])

    await t.provider.send('a@example.com', { kind: 'buttons', text: '¿Qué querés?', buttons: [{ id: 'a', title: 'Ventas' }, { id: 'b', title: 'Soporte' }], footer: 'Respondé con el número' })
    expect(t.smtp.sent[3]!.text).toBe('¿Qué querés?\n\n1. Ventas\n2. Soporte\n\nRespondé con el número')
    await t.provider.send('a@example.com', { kind: 'list', text: 'Menú', buttonText: 'Ver', sections: [{ title: 'Planes', rows: [{ id: 'p', title: 'Pro', description: '10 USD' }] }] })
    expect(t.smtp.sent[4]!.text).toBe('Menú\n\nPlanes\n1. Pro — 10 USD')
    await t.provider.send('a@example.com', { kind: 'location', lat: 4.6, lng: -74.08, name: 'Oficina' })
    expect(t.smtp.sent[5]!.text).toBe('Oficina\nhttps://www.google.com/maps?q=4.6,-74.08')
    await t.provider.send('a@example.com', { kind: 'native', provider: 'email', payload: { subject: 'Nativo', html: '<b>x</b>', cc: 'c@example.com' } })
    expect(t.smtp.sent[6]).toMatchObject({ subject: 'Nativo', html: '<b>x</b>', cc: 'c@example.com' })
  })

  it('rejects content email cannot express and oversized attachments', async () => {
    const t = setup({ maxAttachmentBytes: 4 })
    current = t.provider
    await t.provider.start()
    await expect(t.provider.send('a@example.com', { kind: 'poll', question: 'q', options: ['a', 'b'] })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(t.provider.send('a@example.com', { kind: 'reaction', emoji: '👍', target: { id: 'x', chatId: 'a@example.com' } })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(t.provider.send('a@example.com', { kind: 'native', provider: 'telegram', payload: {} })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(t.provider.send('a@example.com', { kind: 'document', media: Buffer.from('too big') })).rejects.toBeInstanceOf(PayloadTooLargeError)
    expect(t.smtp.sent).toHaveLength(0)
  })

  it('maps SMTP failures to typed errors', async () => {
    const t = setup()
    current = t.provider
    await t.provider.start()
    t.smtp.failWith = Object.assign(new Error('421 busy'), { responseCode: 421 })
    await expect(t.provider.send('a@example.com', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(RateLimitedError)
    t.smtp.failWith = undefined
    t.smtp.rejectAll = true
    await expect(t.provider.send('a@example.com', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(RecipientUnreachableError)
  })
})

describe('EmailProvider bounces', () => {
  const bounce = (originalId: string, rcpt: string) => email([
    'From: MAILER-DAEMON@mx.example.com', 'Message-ID: <dsn-1@mx.example.com>', 'Subject: Undelivered Mail Returned to Sender',
    'Content-Type: multipart/report; report-type=delivery-status; boundary=R',
  ], ['--R', 'Content-Type: text/plain', '', 'failed', '--R', 'Content-Type: message/delivery-status', '',
    'Reporting-MTA: dns; mx.example.com', '', `Final-Recipient: rfc822; ${rcpt}`, 'Action: failed', 'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 no such user', '--R', 'Content-Type: text/rfc822-headers', '', `Message-ID: <${originalId}>`, '--R--'].join('\r\n'))

  it('emits a failed status for the original message and suppresses the address', async () => {
    const t = setup()
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(ana('m1@example.com'))
    const chatId = t.messages()[0]!.chatId
    const sent = await t.provider.send(chatId, { kind: 'text', text: 'hola' })
    await t.provider.ingest(bounce(sent.ref.id, 'ANA@example.com'))
    const statuses = t.events.filter((e) => e.kind === 'status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({
      kind: 'status',
      status: { ref: { id: sent.ref.id, chatId }, status: 'failed', recipient: 'ana@example.com', error: { code: '5.1.1', message: '550 no such user' } },
    })
    expect(t.messages()).toHaveLength(1) // the bounce itself never reaches handlers
    expect(t.provider.isSuppressed('Ana@Example.com')).toBe(true)
    await expect(t.provider.send(chatId, { kind: 'text', text: 'otra' })).rejects.toBeInstanceOf(RecipientUnreachableError)
    t.provider.unsuppress('ana@example.com')
    await expect(t.provider.send(chatId, { kind: 'text', text: 'otra' })).resolves.toBeDefined()
  })

  it('can keep sending to bounced addresses when suppression is off', async () => {
    const t = setup({ suppressBounced: false })
    current = t.provider
    await t.provider.start()
    await t.provider.ingest(bounce('unknown@acme.test', 'x@example.com'))
    expect(t.events.filter((e) => e.kind === 'status')[0]).toMatchObject({ status: { ref: { id: 'unknown@acme.test', chatId: 'x@example.com' } } })
    expect(t.provider.isSuppressed('x@example.com')).toBe(false)
  })
})

describe('EmailProvider lifecycle', () => {
  it('reconnects after the IMAP connection drops and keeps the UID cursor', async () => {
    const t = setup()
    current = t.provider
    t.server.add(ana('a@example.com'))
    await t.provider.start()
    await waitFor(() => t.messages().length === 1)
    t.server.current!.drop()
    await waitFor(() => t.server.clients.length === 2 && !!t.server.current)
    t.server.deliver(ana('b@example.com'))
    await waitFor(() => t.messages().length === 2)
    expect(t.messages().map((m) => m.ref.id)).toEqual(['a@example.com', 'b@example.com'])
    const states = t.events.filter((e) => e.kind === 'connection').map((e) => (e as Extract<InboundEvent, { kind: 'connection' }>).update.state)
    expect(states).toEqual(['connecting', 'ready', 'closed', 'connecting', 'ready'])
  })

  it('rejects start on IMAP auth failure and reports sessionInvalid', async () => {
    const t = setup()
    t.server.connectError = Object.assign(new Error('Command failed'), { authenticationFailed: true })
    await expect(t.provider.start()).rejects.toThrow(ProviderError)
    expect(t.events.at(-1)).toMatchObject({ kind: 'connection', update: { state: 'closed', reason: 'sessionInvalid' } })
  })

  it('runs SMTP verify on start when asked and closes the transport on stop', async () => {
    const t = setup({ smtp: { host: 'smtp.example.com', verify: true } })
    await t.provider.start()
    expect(t.smtp.verified).toBe(1)
    await t.provider.stop()
    expect(t.smtp.closed).toBe(true)
  })

  it('works as an ingest-only provider (no IMAP)', async () => {
    const smtp = new FakeSmtp()
    const provider = new EmailProvider({ address: 'bot@acme.test', smtpTransport: smtp, logger: silent })
    const events: InboundEvent[] = []
    provider.onEvent((e) => { events.push(e) })
    await provider.start()
    expect(events).toEqual([{ kind: 'connection', update: { state: 'connecting' } }, { kind: 'connection', update: { state: 'ready' } }])
    await expect(provider.ingest(ana('w@example.com'))).resolves.toEqual({ status: 200, accepted: true })
    await expect(provider.ingest(ana('l@example.com', ['List-Id: x']))).resolves.toEqual({ status: 200, accepted: false, reason: 'mailing-list' })
    await expect(provider.ingest(42)).resolves.toEqual({ status: 400, accepted: false, reason: 'invalid' })
    expect(events.filter((e) => e.kind === 'message')).toHaveLength(1)
    await provider.stop()
  })

  it('requires an address', () => {
    expect(() => new EmailProvider({ logger: silent })).toThrow(/address/)
  })
})
