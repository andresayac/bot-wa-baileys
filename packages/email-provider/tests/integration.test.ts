/**
 * EmailProvider — integration tests against a REAL mail server (GreenMail).
 *
 * The hermetic suites drive the provider through in-memory IMAP/SMTP fakes.
 * This file loads the real optional peers (`imapflow`, `nodemailer`) and talks
 * IMAP IDLE + SMTP to a real server, so the fakes cannot hide protocol issues.
 *
 * Skipped unless BOTWA_TEST_EMAIL is set, so `pnpm test` stays hermetic:
 *
 *   docker run -d --name botwa-it-greenmail \
 *     -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
 *     -p 127.0.0.1:3025:3025 -p 127.0.0.1:3143:3143 greenmail/standalone:2.1.3
 *   BOTWA_TEST_EMAIL=1 pnpm --filter @botmesh/email test
 *
 * Host and ports: BOTWA_TEST_EMAIL_HOST (default 127.0.0.1),
 * BOTWA_TEST_EMAIL_SMTP_PORT (3025) and BOTWA_TEST_EMAIL_IMAP_PORT (3143),
 * both plain text (GreenMail's test ports). With `greenmail.auth.disabled`
 * every login is accepted and mailboxes are created on demand.
 *
 * Isolation: every test uses fresh addresses under a per-run tag
 * (`bot-<tag>-<n>@botwa.test`), so reruns against the same server never see
 * each other's mail.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Bot, flow, MemoryStore, type InboundEvent, type InboundMessage } from '@botmesh/core'
import { cursorThreadStore, EmailProvider, parseEmail, type EmailProviderConfig, type EmailRaw, type ParsedEmail } from '../src/index.js'

const ENABLED = !!process.env.BOTWA_TEST_EMAIL
const HOST = process.env.BOTWA_TEST_EMAIL_HOST ?? '127.0.0.1'
const SMTP_PORT = Number(process.env.BOTWA_TEST_EMAIL_SMTP_PORT ?? 3025)
const IMAP_PORT = Number(process.env.BOTWA_TEST_EMAIL_IMAP_PORT ?? 3143)
const RUN = randomUUID().slice(0, 8)
const silent = { debug() {}, info() {}, warn() {}, error() {} }
const T = 30_000

let seq = 0
const addr = (name: string): string => `${name}-${RUN}-${++seq}@botwa.test`
const mid = (): string => `${randomUUID()}@client.botwa.test`

/* ------------------------------------------------------------ real peers */

interface MailOptions {
  from: string
  to: string
  subject?: string
  text?: string
  html?: string
  messageId?: string
  inReplyTo?: string
  references?: string[]
  headers?: Record<string, string>
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>
}
interface Transport { sendMail(m: MailOptions): Promise<unknown>; close(): void }
interface ImapFlowLike {
  connect(): Promise<void>
  logout(): Promise<void>
  getMailboxLock(path: string): Promise<{ release(): void }>
  fetch(range: string, query: Record<string, unknown>, opts?: { uid?: boolean }): AsyncIterable<{ uid: number; source?: Buffer }>
  mailbox: { exists?: number } | false
}

// Specifiers through variables: nodemailer ships no types, and the provider types neither peer.
const peer = (name: string): Promise<unknown> => import(name)
const nodemailer = (await peer('nodemailer')) as unknown as { default: { createTransport(o: Record<string, unknown>): Transport } }
const { ImapFlow } = (await peer('imapflow')) as unknown as { ImapFlow: new (o: Record<string, unknown>) => ImapFlowLike }

const transports: Transport[] = []
/** A correspondent's mail client (SMTP submission). */
async function sendAs(mail: MailOptions): Promise<string> {
  let t = transports[0]
  if (!t) {
    t = nodemailer.default.createTransport({ host: HOST, port: SMTP_PORT, secure: false, ignoreTLS: true })
    transports.push(t)
  }
  const messageId = mail.messageId ?? mid()
  await t.sendMail({ ...mail, messageId: `<${messageId}>` })
  return messageId
}

/** Every message in `user`'s INBOX, parsed. */
async function mailboxOf(user: string): Promise<ParsedEmail[]> {
  const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user, pass: 'x' }, logger: false })
  await client.connect()
  const lock = await client.getMailboxLock('INBOX')
  const out: ParsedEmail[] = []
  try {
    if (client.mailbox && client.mailbox.exists) {
      for await (const m of client.fetch('1:*', { uid: true, source: true })) if (m.source) out.push(parseEmail(m.source))
    }
  } finally {
    lock.release()
    await client.logout()
  }
  return out
}

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Wait until `user` has a message matching `pred`. */
const awaitMail = (user: string, pred: (m: ParsedEmail) => boolean): Promise<ParsedEmail> =>
  waitFor(async () => (await mailboxOf(user)).find(pred))

/* ------------------------------------------------------------ bot side */

const providers: EmailProvider[] = []
const bots: Bot[] = []

function botConfig(address: string, extra: Partial<EmailProviderConfig> = {}): EmailProviderConfig {
  return {
    address,
    fromName: 'Bot IT',
    imap: { host: HOST, port: IMAP_PORT, secure: false, user: address, pass: 'x' },
    smtp: { host: HOST, port: SMTP_PORT, secure: false, options: { ignoreTLS: true } },
    reconnect: { baseMs: 200, maxMs: 1000 },
    logger: silent,
    ...extra,
  }
}

interface Harness { provider: EmailProvider; messages: InboundMessage<EmailRaw>[] }

async function startProvider(address: string, extra: Partial<EmailProviderConfig> = {}): Promise<Harness> {
  const provider = new EmailProvider(botConfig(address, extra))
  providers.push(provider)
  const messages: InboundMessage<EmailRaw>[] = []
  provider.onEvent((e: InboundEvent<EmailRaw>) => {
    if (e.kind === 'message') messages.push(e.message)
  })
  await provider.start()
  return { provider, messages }
}

afterEach(async () => {
  for (const b of bots.splice(0)) await b.stop().catch(() => undefined)
  for (const p of providers.splice(0)) await p.stop().catch(() => undefined)
  for (const t of transports.splice(0)) t.close()
})

const settle = (ms = 1500): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!ENABLED)('EmailProvider against a real IMAP/SMTP server (GreenMail)', () => {
  it('receives new mail over IMAP IDLE with a stable senderId and one chat per thread', async () => {
    const bot = addr('bot')
    const ana = addr('ana')
    const h = await startProvider(bot)

    const first = await sendAs({ from: `Ana Pérez <${ana.toUpperCase()}>`, to: bot, subject: 'Pedido', text: 'hola' })
    const m1 = await waitFor(() => h.messages[0])
    expect(m1).toMatchObject({
      chatId: `thread:${first}`,
      senderId: ana,
      type: 'text',
      body: 'hola',
      fromMe: false,
      isGroup: false,
      ref: { id: first, chatId: `thread:${first}` },
      senderInfo: { displayName: 'Ana Pérez' },
    })
    expect(m1.raw.uid).toBeGreaterThan(0)
    expect(m1.raw.mailbox).toBe('INBOX')

    const second = await sendAs({ from: ana, to: bot, subject: 'Otro tema', text: 'segundo' })
    const m2 = await waitFor(() => h.messages[1])
    expect(m2.senderId).toBe(ana)
    expect(m2.chatId).toBe(`thread:${second}`)
    expect(m2.chatId).not.toBe(m1.chatId)
  }, T)

  it('replies in-thread over SMTP and keeps the chat across the reply chain', async () => {
    const bot = addr('bot')
    const ana = addr('ana')
    const h = await startProvider(bot)

    const root = await sendAs({ from: ana, to: bot, subject: 'Factura 42', text: '¿Me envían la factura?' })
    const m1 = await waitFor(() => h.messages[0])

    const pdf = Buffer.from('%PDF-1.4\n% fake invoice\n')
    const { ref } = await h.provider.send(m1.chatId, { kind: 'text', text: 'Claro, aquí está.' })
    await h.provider.send(m1.chatId, { kind: 'document', media: pdf, filename: 'factura-42.pdf', mimetype: 'application/pdf' })

    const reply = await awaitMail(ana, (m) => m.messageId === ref.id)
    expect(reply.subject).toBe('Re: Factura 42')
    expect(reply.from).toMatchObject({ address: bot, name: 'Bot IT' })
    expect(reply.inReplyTo).toBe(root)
    expect(reply.references).toEqual([root])
    expect(reply.headers.get('auto-submitted')).toEqual(['auto-replied'])
    expect(reply.headers.get('x-auto-response-suppress')).toEqual(['All'])
    expect(reply.text?.trim()).toBe('Claro, aquí está.')

    const withPdf = await awaitMail(ana, (m) => m.attachments.length > 0)
    expect(withPdf.inReplyTo).toBe(ref.id)
    expect(withPdf.references).toEqual([root, ref.id])
    expect(withPdf.attachments[0]).toMatchObject({ filename: 'factura-42.pdf', mimetype: 'application/pdf' })
    expect(withPdf.attachments[0]!.content.equals(pdf)).toBe(true)

    // Ana answers the bot's mail from a client that sends only In-Reply-To.
    await sendAs({ from: ana, to: bot, subject: 'Re: Factura 42', text: 'Gracias\n\nOn Mon, Bot IT wrote:\n> Claro, aquí está.', inReplyTo: `<${ref.id}>` })
    const m2 = await waitFor(() => h.messages[1])
    expect(m2.chatId).toBe(m1.chatId)
    expect(m2.body).toBe('Gracias')
    expect(m2.quoted?.ref?.id).toBe(ref.id)

    // And a full References chain from another client lands in the same chat too.
    await sendAs({ from: ana, to: bot, subject: 'RE: Factura 42', text: 'Una cosa más', references: [`<${root}>`, `<${ref.id}>`], inReplyTo: `<${ref.id}>` })
    const m3 = await waitFor(() => h.messages[2])
    expect(m3.chatId).toBe(m1.chatId)
  }, T)

  it('turns attachments into media refs that downloadMedia serves (cache and IMAP refetch)', async () => {
    const bot = addr('bot')
    const ana = addr('ana')
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const csv = Buffer.from('sku,qty\nA1,3\n')
    const attachments = [
      { filename: 'foto.png', content: png, contentType: 'image/png' },
      { filename: 'pedido.csv', content: csv, contentType: 'text/csv' },
    ]

    const cached = await startProvider(bot)
    await sendAs({ from: ana, to: bot, subject: 'Adjuntos', text: 'van dos archivos', attachments })
    const m = await waitFor(() => cached.messages[0])
    expect(m.type).toBe('image')
    expect(m.body).toBe('van dos archivos')
    expect(m.media).toMatchObject({ kind: 'image', mimetype: 'image/png', filename: 'foto.png', size: png.length })
    expect(m.raw.attachments.map((a) => [a.kind, a.filename])).toEqual([['image', 'foto.png'], ['document', 'pedido.csv']])
    expect((await cached.provider.downloadMedia(m.media!)).equals(png)).toBe(true)
    expect((await cached.provider.downloadMedia(m.raw.attachments[1]!)).equals(csv)).toBe(true)
    await cached.provider.stop()

    // No cache at all: the bytes come back from the server by UID.
    const bot2 = addr('bot')
    const refetch = await startProvider(bot2, { attachmentCacheBytes: 0 })
    await sendAs({ from: ana, to: bot2, subject: 'Adjuntos', text: 'otra vez', attachments })
    const m2 = await waitFor(() => refetch.messages[0])
    expect((await refetch.provider.downloadMedia(m2.media!)).equals(png)).toBe(true)
    expect((await refetch.provider.downloadMedia(m2.raw.attachments[1]!)).equals(csv)).toBe(true)
  }, T)

  it('converts HTML-only mail to text', async () => {
    const bot = addr('bot')
    const h = await startProvider(bot)
    await sendAs({ from: addr('ana'), to: bot, subject: 'HTML', html: '<p>Hola <b>mundo</b></p><p>segunda&nbsp;línea</p><script>alert(1)</script>' })
    const m = await waitFor(() => h.messages[0])
    expect(m.body).toBe('Hola mundo\nsegunda línea')
    expect(m.body).not.toContain('alert')
    expect(m.raw.html).toContain('<b>mundo</b>')
  }, T)

  it('drops auto-replies and mailing-list mail before handlers (loop protection)', async () => {
    const bot = addr('bot')
    const robot = addr('robot')
    const h = await startProvider(bot)
    await sendAs({ from: robot, to: bot, subject: 'Out of office', text: 'estoy de vacaciones', headers: { 'Auto-Submitted': 'auto-replied' } })
    await sendAs({ from: robot, to: bot, subject: 'Newsletter', text: 'novedades', headers: { 'List-Id': '<news.botwa.test>' } })
    await sendAs({ from: robot, to: bot, subject: 'Bulk', text: 'promo', headers: { Precedence: 'bulk' } })
    await sendAs({ from: robot, to: bot, subject: 'Humano', text: 'esto sí' })
    await waitFor(() => h.messages[0])
    await settle(500)
    expect(h.messages.map((m) => m.body)).toEqual(['esto sí'])

    // A human writing to the bot never gets an auto-reply loop back: the bot's mail is marked automated.
    const ana = addr('ana')
    await sendAs({ from: ana, to: bot, subject: 'Hola', text: 'hola' })
    const m = await waitFor(() => h.messages[1])
    const { ref } = await h.provider.send(m.chatId, { kind: 'text', text: 'respuesta' })
    const out = await awaitMail(ana, (x) => x.messageId === ref.id)
    // Fed back to the bot (e.g. a forwarding rule), its own mail is ignored.
    const other = await startProvider(addr('bot'), { address: bot, imap: { host: HOST, port: IMAP_PORT, secure: false, user: ana, pass: 'x' } })
    await settle()
    expect(out.headers.get('auto-submitted')).toEqual(['auto-replied'])
    expect(other.messages).toEqual([])
  }, T)

  it('does not redeliver processed mail after a restart (markSeen, default)', async () => {
    const bot = addr('bot')
    const ana = addr('ana')
    const a = await startProvider(bot)
    await sendAs({ from: ana, to: bot, subject: 'uno', text: 'uno' })
    await waitFor(() => a.messages[0])
    await settle(500) // let the \Seen flag land
    await a.provider.stop()

    await sendAs({ from: ana, to: bot, subject: 'dos', text: 'dos' }) // arrives while the bot is down
    const b = await startProvider(bot)
    await waitFor(() => b.messages[0])
    await sendAs({ from: ana, to: bot, subject: 'tres', text: 'tres' })
    await waitFor(() => b.messages[1])
    await settle(500)
    expect(b.messages.map((m) => m.body)).toEqual(['dos', 'tres'])
  }, T)

  it('does not redeliver mail after stop()/start() of the same provider with markSeen: false', async () => {
    const bot = addr('bot')
    const ana = addr('ana')
    const h = await startProvider(bot, { markSeen: false })
    await sendAs({ from: ana, to: bot, subject: 'uno', text: 'uno' })
    await waitFor(() => h.messages[0])
    await h.provider.stop()

    await sendAs({ from: ana, to: bot, subject: 'dos', text: 'dos' })
    await h.provider.start()
    await waitFor(() => h.messages[1])
    await settle()
    expect(h.messages.map((m) => m.body)).toEqual(['uno', 'dos'])
  }, T)

  it('does not redeliver a backlog cut short by stop() with markSeen: false', async () => {
    const bot = addr('bot')
    const ana = addr('ana')
    const store = new MemoryStore()
    for (const n of ['uno', 'dos', 'tres']) await sendAs({ from: ana, to: bot, subject: n, text: n })
    await settle(500) // delivered and still UNSEEN (reading it here would flag it \Seen)

    const provider = new EmailProvider(botConfig(bot, { markSeen: false, threadStore: cursorThreadStore(store) }))
    providers.push(provider)
    const first: string[] = []
    let stopping: Promise<void> | undefined
    provider.onEvent((e: InboundEvent<EmailRaw>) => {
      if (e.kind !== 'message') return
      first.push(e.message.body ?? '')
      stopping ??= provider.stop() // stop while the first message of the batch is being handled
    })
    await provider.start()
    await waitFor(() => stopping !== undefined)
    await stopping
    expect(first).toEqual(['uno'])

    const b = await startProvider(bot, { markSeen: false, threadStore: cursorThreadStore(store) })
    await waitFor(() => b.messages[1])
    await settle()
    expect(b.messages.map((m) => m.body)).toEqual(['dos', 'tres'])
  }, T)

  it('resumes from the persisted UID cursor in a new process with markSeen: false', async () => {
    const bot = addr('bot')
    const ana = addr('ana')
    const store = new MemoryStore() // stands in for a persistent store (sqlite, redis, ...)
    const a = await startProvider(bot, { markSeen: false, threadStore: cursorThreadStore(store) })
    const root = await sendAs({ from: ana, to: bot, subject: 'uno', text: 'uno' })
    await waitFor(() => a.messages[0])
    await a.provider.stop()

    await sendAs({ from: ana, to: bot, subject: 'dos', text: 'dos' })
    const b = await startProvider(bot, { markSeen: false, threadStore: cursorThreadStore(store) })
    await waitFor(() => b.messages[0])
    await settle()
    expect(b.messages.map((m) => m.body)).toEqual(['dos'])
    // Thread state survived too: the new process can still answer the first thread.
    const { ref } = await b.provider.send(`thread:${root}`, { kind: 'text', text: 'seguimos' })
    const out = await awaitMail(ana, (m) => m.messageId === ref.id)
    expect(out.inReplyTo).toBe(root)
  }, T)

  it('runs a Bot flow over email: ask by mail, answer by mail', async () => {
    const botAddr = addr('bot')
    const ana = addr('ana')
    const provider = new EmailProvider(botConfig(botAddr))
    providers.push(provider)
    const bot = new Bot({ provider })
    bots.push(bot)
    bot.use(flow('cotizar').ask('¿Cuántas unidades necesitas?', 'qty').say((_ctx, c) => `Perfecto: ${String(c.state.qty)} unidades.`))
    await bot.start()

    const root = await sendAs({ from: `Ana <${ana}>`, to: botAddr, subject: 'Cotización', text: 'cotizar' })
    const question = await awaitMail(ana, (m) => m.text?.includes('¿Cuántas unidades necesitas?') === true)
    expect(question.subject).toBe('Re: Cotización')
    expect(question.inReplyTo).toBe(root)

    await sendAs({
      from: ana, to: botAddr, subject: 'Re: Cotización',
      text: `12\n\nEl lun, 13 oct 2025, Bot IT <${botAddr}> escribió:\n> ¿Cuántas unidades necesitas?`,
      inReplyTo: `<${question.messageId}>`, references: [`<${root}>`, `<${question.messageId}>`],
    })
    const done = await awaitMail(ana, (m) => m.text?.includes('Perfecto: 12 unidades.') === true)
    expect(done.inReplyTo).not.toBe(root)
    expect(done.references[0]).toBe(root)
  }, T)
})
