import { describe, expect, it } from 'vitest'
import { decodeEncodedWords, parseEmail, parseHeaderParams } from '../src/mime.js'

const crlf = (lines: string[]): string => lines.join('\r\n')

describe('decodeEncodedWords', () => {
  it('decodes B and Q encoded words and joins adjacent ones', () => {
    expect(decodeEncodedWords('=?UTF-8?B?wqFIb2xhIG11bmRvIQ==?=')).toBe('¡Hola mundo!')
    expect(decodeEncodedWords('=?ISO-8859-1?Q?Caf=E9_con_leche?=')).toBe('Café con leche')
    expect(decodeEncodedWords('=?UTF-8?Q?a?= =?UTF-8?Q?b?=')).toBe('ab')
    expect(decodeEncodedWords('Re: =?utf-8?q?ma=C3=B1ana?= ok')).toBe('Re: mañana ok')
  })

  it('leaves malformed or plain text alone', () => {
    expect(decodeEncodedWords('plain subject')).toBe('plain subject')
    expect(decodeEncodedWords('=?bogus?X?abc?=')).toBe('=?bogus?X?abc?=')
  })
})

describe('parseHeaderParams', () => {
  it('parses quoted params, RFC 2231 extended values and continuations', () => {
    const p = parseHeaderParams('attachment; filename*0*=UTF-8\'\'informe%20; filename*1="final.pdf"; size=10')
    expect(p.value).toBe('attachment')
    expect(p.params.filename).toBe('informe final.pdf')
    expect(p.params.size).toBe('10')

    const ct = parseHeaderParams('text/plain; charset="iso-8859-1"; format=flowed')
    expect(ct.value).toBe('text/plain')
    expect(ct.params.charset).toBe('iso-8859-1')
  })
})

describe('parseEmail', () => {
  it('parses a simple text message with folded headers', () => {
    const raw = crlf([
      'From: "Ana Pérez" <Ana@Example.COM>',
      'To: bot@acme.test',
      'Subject: =?UTF-8?Q?Pregunta_sobre_el_pedido?=',
      '  #42',
      'Message-ID: <abc123@example.com>',
      'Date: Tue, 14 Oct 2025 10:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hola, ¿dónde está mi pedido?',
    ])
    const email = parseEmail(Buffer.from(raw, 'utf8'))
    expect(email.subject).toBe('Pregunta sobre el pedido #42')
    expect(email.messageId).toBe('abc123@example.com')
    expect(email.from).toEqual({ name: 'Ana Pérez', address: 'Ana@Example.COM' })
    expect(email.to).toEqual([{ name: undefined, address: 'bot@acme.test' }])
    expect(email.text).toBe('Hola, ¿dónde está mi pedido?')
    expect(email.date?.toISOString()).toBe('2025-10-14T10:00:00.000Z')
    expect(email.references).toEqual([])
  })

  it('parses In-Reply-To and References lists', () => {
    const raw = crlf([
      'From: a@x.test',
      'Message-ID: <3@x.test>',
      'In-Reply-To: <2@x.test>',
      'References: <1@x.test>',
      ' <2@x.test>',
      '',
      'body',
    ])
    const email = parseEmail(raw)
    expect(email.inReplyTo).toBe('2@x.test')
    expect(email.references).toEqual(['1@x.test', '2@x.test'])
  })

  it('handles multipart/alternative with quoted-printable and base64 parts', () => {
    const html = Buffer.from('<p>Hola <b>mundo</b></p>', 'utf8').toString('base64')
    const raw = crlf([
      'From: a@x.test',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      'preamble',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Hola mundo con acento: =C3=A1 y una l=',
      'inea larga',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      html,
      '--b1--',
      'epilogue',
    ])
    const email = parseEmail(raw)
    expect(email.text).toBe('Hola mundo con acento: á y una linea larga')
    expect(email.html).toBe('<p>Hola <b>mundo</b></p>')
    expect(email.attachments).toEqual([])
  })

  it('extracts attachments from nested multipart/mixed, decoding charsets', () => {
    const pdf = Buffer.from('%PDF-1.4 fake').toString('base64')
    const raw = crlf([
      'From: a@x.test',
      'Content-Type: multipart/mixed; boundary=outer',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary=inner',
      '',
      '--inner',
      'Content-Type: text/plain; charset=iso-8859-1',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Adjunto la factura, se=F1or.',
      '--inner--',
      '--outer',
      'Content-Type: application/pdf; name="=?UTF-8?Q?factura_n=C2=BA1.pdf?="',
      'Content-Disposition: attachment',
      'Content-Transfer-Encoding: base64',
      '',
      pdf,
      '--outer',
      'Content-Type: image/png',
      'Content-Disposition: inline; filename=logo.png',
      'Content-ID: <logo@x>',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      '--outer--',
    ])
    const email = parseEmail(raw)
    expect(email.text).toBe('Adjunto la factura, señor.')
    expect(email.attachments).toHaveLength(2)
    expect(email.attachments[0]).toMatchObject({ filename: 'factura nº1.pdf', mimetype: 'application/pdf', inline: false, size: 13 })
    expect(email.attachments[0]!.content.toString()).toBe('%PDF-1.4 fake')
    expect(email.attachments[1]).toMatchObject({ filename: 'logo.png', mimetype: 'image/png', inline: true, contentId: 'logo@x' })
  })

  it('treats LF-only messages the same as CRLF', () => {
    const email = parseEmail('From: a@x.test\nSubject: hi\n\nline1\nline2\n')
    expect(email.subject).toBe('hi')
    expect(email.text).toBe('line1\nline2')
  })

  it('exposes headers case-insensitively and copes with a missing body', () => {
    const email = parseEmail('From: a@x.test\r\nX-Custom: one\r\nx-custom: two\r\n')
    expect(email.headers.get('x-custom')).toEqual(['one', 'two'])
    expect(email.header('X-CUSTOM')).toBe('one')
    expect(email.text).toBeUndefined()
  })

  it('keeps message/rfc822 parts as attachments and exposes the parsed child', () => {
    const raw = crlf([
      'From: a@x.test',
      'Content-Type: multipart/mixed; boundary=z',
      '',
      '--z',
      'Content-Type: text/plain',
      '',
      'see attached',
      '--z',
      'Content-Type: message/rfc822',
      '',
      'Message-ID: <inner@x.test>',
      'Subject: Original',
      '',
      'inner body',
      '--z--',
    ])
    const email = parseEmail(raw)
    expect(email.text).toBe('see attached')
    expect(email.attachments).toHaveLength(1)
    expect(email.attachments[0]!.mimetype).toBe('message/rfc822')
    expect(email.attachments[0]!.filename).toBe('Original.eml')
  })
})
