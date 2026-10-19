import { describe, expect, it } from 'vitest'
import { PayloadTooLargeError, ProviderError, RateLimitedError, RecipientUnreachableError } from '@bot-wa/core'
import { parseEmail } from '../src/mime.js'
import { detectAutomated, SenderFloodGuard } from '../src/loop.js'
import { detectBounce } from '../src/bounce.js'
import { toEmailProviderError } from '../src/errors.js'

const mail = (headers: string[], body = 'hi'): ReturnType<typeof parseEmail> =>
  parseEmail([...headers, '', body].join('\r\n'))

describe('detectAutomated', () => {
  it('flags RFC 3834 Auto-Submitted unless it is "no"', () => {
    expect(detectAutomated(mail(['From: a@x.test', 'Auto-Submitted: auto-replied']))).toBe('auto-submitted')
    expect(detectAutomated(mail(['From: a@x.test', 'Auto-Submitted: auto-generated; owner=x']))).toBe('auto-submitted')
    expect(detectAutomated(mail(['From: a@x.test', 'Auto-Submitted: No']))).toBeUndefined()
  })

  it('flags mailing lists, bulk precedence and vendor auto-reply headers', () => {
    expect(detectAutomated(mail(['From: a@x.test', 'List-Id: <news.x.test>']))).toBe('mailing-list')
    expect(detectAutomated(mail(['From: a@x.test', 'List-Unsubscribe: <mailto:u@x.test>']))).toBe('mailing-list')
    expect(detectAutomated(mail(['From: a@x.test', 'Precedence: bulk']))).toBe('precedence')
    expect(detectAutomated(mail(['From: a@x.test', 'X-Autoreply: yes']))).toBe('auto-reply-header')
    expect(detectAutomated(mail(['From: a@x.test', 'X-Auto-Response-Suppress: OOF, AutoReply']))).toBe('auto-reply-header')
  })

  it('flags null senders and mailer daemons', () => {
    expect(detectAutomated(mail(['From: a@x.test', 'Return-Path: <>']))).toBe('null-sender')
    expect(detectAutomated(mail(['From: MAILER-DAEMON@x.test']))).toBe('system-sender')
    expect(detectAutomated(mail(['From: no-reply@x.test']))).toBe('system-sender')
  })

  it('lets a normal human email through', () => {
    expect(detectAutomated(mail(['From: Ana <ana@x.test>', 'Subject: hola']))).toBeUndefined()
  })
})

describe('SenderFloodGuard', () => {
  it('allows up to N messages per window per sender, then blocks until it slides', () => {
    let now = 0
    const guard = new SenderFloodGuard({ max: 2, windowMs: 1000 }, () => now)
    expect(guard.allow('a')).toBe(true)
    expect(guard.allow('a')).toBe(true)
    expect(guard.allow('a')).toBe(false)
    expect(guard.allow('b')).toBe(true)
    now = 1001
    expect(guard.allow('a')).toBe(true)
  })
})

describe('detectBounce', () => {
  const dsn = [
    'From: Mail Delivery System <MAILER-DAEMON@mx.acme.test>',
    'To: bot@acme.test',
    'Subject: Undelivered Mail Returned to Sender',
    'Auto-Submitted: auto-replied',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="R"',
    '',
    '--R',
    'Content-Type: text/plain',
    '',
    'This is the mail system. Your message could not be delivered.',
    '--R',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.acme.test',
    '',
    'Final-Recipient: rfc822; Ghost@Nowhere.test',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 <ghost@nowhere.test>: Recipient address rejected',
    '',
    'Final-Recipient: rfc822; slow@nowhere.test',
    'Action: delayed',
    'Status: 4.4.1',
    '--R',
    'Content-Type: text/rfc822-headers',
    '',
    'Message-ID: <sent-1@acme.test>',
    'Subject: Hola',
    '--R--',
  ].join('\r\n')

  it('parses a multipart/report DSN with per-recipient status and the original Message-ID', () => {
    const bounce = detectBounce(parseEmail(dsn))
    expect(bounce).toBeDefined()
    expect(bounce!.originalMessageId).toBe('sent-1@acme.test')
    expect(bounce!.recipients).toEqual([
      { address: 'ghost@nowhere.test', action: 'failed', status: '5.1.1', diagnostic: '550 5.1.1 <ghost@nowhere.test>: Recipient address rejected', permanent: true },
      { address: 'slow@nowhere.test', action: 'delayed', status: '4.4.1', diagnostic: undefined, permanent: false },
    ])
  })

  it('falls back to heuristics for non-standard bounces (X-Failed-Recipients)', () => {
    const bounce = detectBounce(mail([
      'From: Mail Delivery Subsystem <mailer-daemon@googlemail.test>',
      'Subject: Delivery Status Notification (Failure)',
      'X-Failed-Recipients: gone@x.test',
    ], 'Address not found.\r\n\r\nMessage-ID: <orig-9@acme.test>\r\n'))
    expect(bounce?.originalMessageId).toBe('orig-9@acme.test')
    expect(bounce?.recipients).toEqual([{ address: 'gone@x.test', action: 'failed', status: undefined, diagnostic: undefined, permanent: true }])
  })

  it('ignores ordinary mail', () => {
    expect(detectBounce(mail(['From: ana@x.test', 'Subject: Delivery failure of my package?']))).toBeUndefined()
  })
})

describe('toEmailProviderError', () => {
  it('maps SMTP replies to typed provider errors', () => {
    const e550 = toEmailProviderError(Object.assign(new Error('550 5.1.1 user unknown'), { responseCode: 550, code: 'EENVELOPE' }), 'c1')
    expect(e550).toBeInstanceOf(RecipientUnreachableError)
    expect((e550 as RecipientUnreachableError).chatId).toBe('c1')
    expect(toEmailProviderError(Object.assign(new Error('552 message size exceeds'), { responseCode: 552 }), 'c1')).toBeInstanceOf(PayloadTooLargeError)
    expect(toEmailProviderError(Object.assign(new Error('554 5.3.4 too big'), { responseCode: 554, response: '554 5.3.4 Message too big' }), 'c1')).toBeInstanceOf(PayloadTooLargeError)
    const e421 = toEmailProviderError(Object.assign(new Error('421 try later'), { responseCode: 421 }), 'c1')
    expect(e421).toBeInstanceOf(RateLimitedError)
    expect((e421 as RateLimitedError).retryAfterMs).toBe(60_000)
    expect(toEmailProviderError(Object.assign(new Error('451 4.7.1 slow down'), { responseCode: 451 }), 'c1')).toBeInstanceOf(RateLimitedError)
  })

  it('keeps auth/connection failures as a generic ProviderError and passes ProviderErrors through', () => {
    const auth = toEmailProviderError(Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }), 'c1')
    expect(auth).toBeInstanceOf(ProviderError)
    expect(auth).not.toBeInstanceOf(RecipientUnreachableError)
    expect(auth.message).toMatch(/authentication/i)
    const original = new RateLimitedError(5)
    expect(toEmailProviderError(original, 'c1')).toBe(original)
    expect(toEmailProviderError('boom', 'c1')).toBeInstanceOf(ProviderError)
  })
})

describe('toEmailProviderError — 552 disambiguation', () => {
  it('552 5.2.2 (mailbox full) is RecipientUnreachableError, not PayloadTooLargeError', () => {
    const full = toEmailProviderError(Object.assign(new Error('552 5.2.2 Mailbox full'), { responseCode: 552, response: '552 5.2.2 Mailbox full' }), 'c9')
    expect(full).toBeInstanceOf(RecipientUnreachableError)
    expect(full).not.toBeInstanceOf(PayloadTooLargeError)
    expect((full as RecipientUnreachableError).chatId).toBe('c9')
  })

  it('552 5.3.4 (message too big) stays PayloadTooLargeError', () => {
    const big = toEmailProviderError(Object.assign(new Error('552 5.3.4 too big'), { responseCode: 552, response: '552 5.3.4 Message size exceeds fixed limit' }), 'c9')
    expect(big).toBeInstanceOf(PayloadTooLargeError)
  })
})
