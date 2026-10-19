import { afterEach, describe, expect, it } from 'vitest'
import { UnsupportedContentError, type InboundEvent, type InboundMessage } from '@bot-wa/core'
import { EmailProvider, type EmailRaw } from '../src/index.js'
import { email, FakeSmtp } from './support/fakes.js'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const b64word = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`

let current: EmailProvider | undefined
afterEach(async () => { await current?.stop(); current = undefined })

async function setup() {
  const smtp = new FakeSmtp()
  const provider = new EmailProvider({ address: 'bot@acme.test', smtpTransport: smtp, logger: silent })
  current = provider
  const events: InboundEvent[] = []
  provider.onEvent((e) => { events.push(e) })
  await provider.start()
  const messages = () => events.filter((e): e is Extract<InboundEvent, { kind: 'message' }> => e.kind === 'message').map((e) => e.message as InboundMessage<EmailRaw>)
  return { smtp, provider, messages }
}

const CTL = /[\r\n\0]/

describe('email header injection', () => {
  it('strips CR/LF smuggled through RFC 2047 encoded subjects and display names', async () => {
    const t = await setup()
    await t.provider.ingest(email([
      `From: ${b64word('Ana\r\nBcc: victim@evil.test')} <ana@example.com>`,
      'To: bot@acme.test',
      `Subject: ${b64word('Hola\r\nBcc: victim@evil.test')}`,
      'Message-ID: <root@x>',
    ], 'hola'))
    const [m] = t.messages()
    await t.provider.send(m!.chatId, { kind: 'text', text: 'respuesta' })
    const sent = t.smtp.sent[0]!
    expect(sent.subject).not.toMatch(CTL)
    const to = sent.to as { name?: string; address: string }
    expect(to.address).toBe('ana@example.com')
    expect(to.name ?? '').not.toMatch(CTL)
  })

  it('strips CR/LF from a subject given in platformData or a native payload', async () => {
    const t = await setup()
    await t.provider.send('a@x.com', { kind: 'text', text: 'x' }, { platformData: { subject: 'Hi\r\nBcc: v@evil.test' } })
    await t.provider.send('a@x.com', { kind: 'native', provider: 'email', payload: { text: 'x', subject: 'Hi\nBcc: v@evil.test' } })
    for (const sent of t.smtp.sent) expect(sent.subject).not.toMatch(CTL)
  })

  it('rejects native cc/bcc entries that are not single plain addresses', async () => {
    const t = await setup()
    for (const cc of ['a@x.com\r\nBcc: v@evil.test', ['ok@x.com', 'b@x.com\nX-Evil: 1'], 'not an address']) {
      await expect(t.provider.send('a@x.com', { kind: 'native', provider: 'email', payload: { text: 'x', cc } })).rejects.toBeInstanceOf(UnsupportedContentError)
      await expect(t.provider.send('a@x.com', { kind: 'native', provider: 'email', payload: { text: 'x', bcc: cc } })).rejects.toBeInstanceOf(UnsupportedContentError)
    }
    await t.provider.send('a@x.com', { kind: 'native', provider: 'email', payload: { text: 'x', cc: ['b@x.com', 'c@y.org'] } })
    expect(t.smtp.sent.at(-1)!.cc).toEqual(['b@x.com', 'c@y.org'])
  })
})
