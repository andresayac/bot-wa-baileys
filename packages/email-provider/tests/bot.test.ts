import { describe, expect, it } from 'vitest'
import { Bot, flow } from '@botmesh/core'
import { EmailProvider } from '../src/index.js'
import { email, FakeImapServer, FakeSmtp, waitFor } from './support/fakes.js'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

describe('EmailProvider + Bot', () => {
  it('runs a multi-step flow across an email thread, replying in-thread', async () => {
    const server = new FakeImapServer()
    const smtp = new FakeSmtp()
    const provider = new EmailProvider({ address: 'bot@acme.test', createImapClient: server.createClient, smtpTransport: smtp, logger: silent })
    const bot = new Bot({ provider })
    bot.use(flow('cotizar').ask('¿Cuántas unidades?', 'qty').say((_ctx, c) => `Listo: ${String(c.state.qty)} unidades`))
    await bot.start()

    server.deliver(email(['From: Ana <ana@example.com>', 'Subject: Cotización', 'Message-ID: <c1@example.com>'], 'cotizar'))
    await waitFor(() => smtp.sent.length === 1)
    const question = smtp.sent[0]!
    expect(question).toMatchObject({ text: '¿Cuántas unidades?', subject: 'Re: Cotización', inReplyTo: '<c1@example.com>' })

    // Ana answers the question from her mail client (quoted history included).
    server.deliver(email([
      'From: ana@example.com', 'Subject: Re: Cotización', 'Message-ID: <c2@example.com>',
      `In-Reply-To: ${question.messageId}`, `References: <c1@example.com> ${question.messageId}`,
    ], `12\r\n\r\nOn Tue, Oct 14, 2025 at 10:00 AM <bot@acme.test> wrote:\r\n> ¿Cuántas unidades?`))
    await waitFor(() => smtp.sent.length === 2)
    expect(smtp.sent[1]).toMatchObject({ text: 'Listo: 12 unidades', inReplyTo: '<c2@example.com>' })
    await bot.stop()
  })

  it('does not run handlers twice for a redelivered Message-ID (core dedupe)', async () => {
    const smtp = new FakeSmtp()
    const provider = new EmailProvider({ address: 'bot@acme.test', smtpTransport: smtp, logger: silent })
    const bot = new Bot({ provider })
    const bodies: string[] = []
    bot.onMessage((ctx) => { bodies.push(ctx.body) })
    await bot.start()
    const raw = email(['From: a@example.com', 'Message-ID: <dup@example.com>'], 'hola')
    await provider.ingest(raw)
    await provider.ingest(raw)
    await waitFor(() => bodies.length >= 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(bodies).toEqual(['hola'])
    await bot.stop()
  })
})
