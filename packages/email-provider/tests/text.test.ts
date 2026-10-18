import { describe, expect, it } from 'vitest'
import { htmlToText } from '../src/html.js'
import { stripQuotedReply } from '../src/reply.js'
import { normalizeAddress, parseAddressList } from '../src/address.js'

describe('htmlToText', () => {
  it('drops scripts/styles/comments and keeps block structure', () => {
    const html = '<html><head><style>p{color:red}</style><title>x</title></head><body>' +
      '<!-- hidden --><script>alert(1)</script><p>Hola&nbsp;<b>Ana</b>,</p><div>Línea 2<br>Línea 3</div>' +
      '<ul><li>uno</li><li>dos</li></ul><p>Precio: 5 &lt; 10 &amp; &#8364;3 &#x41;</p></body></html>'
    expect(htmlToText(html)).toBe('Hola Ana,\nLínea 2\nLínea 3\n- uno\n- dos\nPrecio: 5 < 10 & €3 A')
  })

  it('keeps link targets that differ from the link text', () => {
    expect(htmlToText('<a href="https://acme.test/x">ver pedido</a> y <a href="https://a.test">https://a.test</a>'))
      .toBe('ver pedido (https://acme.test/x) y https://a.test')
  })

  it('collapses whitespace and runs of blank lines', () => {
    expect(htmlToText('<p>a</p>\n\n\n<p>   b    c </p><br><br><br><p>d</p>')).toBe('a\nb c\n\nd')
  })
})

describe('stripQuotedReply', () => {
  it('cuts English and Spanish attribution lines', () => {
    expect(stripQuotedReply('Sí, gracias\n\nOn Tue, Oct 14, 2025 at 10:00 AM Bot <bot@acme.test> wrote:\n> Hola')).toBe('Sí, gracias')
    expect(stripQuotedReply('Perfecto\n\nEl mar, 14 oct 2025 a las 10:00, Bot (<bot@acme.test>)\nescribió:\n> hola')).toBe('Perfecto')
  })

  it('cuts Outlook separators and original-message markers', () => {
    expect(stripQuotedReply('ok\n\n________________________________\nFrom: Bot\nSent: today')).toBe('ok')
    expect(stripQuotedReply('dale\n-----Original Message-----\nFrom: x')).toBe('dale')
    expect(stripQuotedReply('listo\n\nFrom: Bot <bot@acme.test>\nSent: Tuesday\nTo: me\nSubject: hi')).toBe('listo')
  })

  it('drops trailing > quoted lines and a signature', () => {
    expect(stripQuotedReply('respuesta\n> citado 1\n> citado 2\n')).toBe('respuesta')
    expect(stripQuotedReply('cuerpo\n-- \nAna\nCEO')).toBe('cuerpo')
  })

  it('returns the full text when nothing is quoted', () => {
    expect(stripQuotedReply('a\nb')).toBe('a\nb')
  })
})

describe('addresses', () => {
  it('normalizes case, whitespace and angle brackets', () => {
    expect(normalizeAddress('  <Ana.Perez@Example.COM> ')).toBe('ana.perez@example.com')
  })

  it('parses display names, quoted commas, encoded words and groups', () => {
    expect(parseAddressList('"Pérez, Ana" <ana@x.test>, bob@y.test (Bob), =?UTF-8?Q?Jos=C3=A9?= <jose@z.test>, Team: c@t.test, d@t.test;'))
      .toEqual([
        { name: 'Pérez, Ana', address: 'ana@x.test' },
        { name: undefined, address: 'bob@y.test' },
        { name: 'José', address: 'jose@z.test' },
        { name: undefined, address: 'c@t.test' },
        { name: undefined, address: 'd@t.test' },
      ])
    expect(parseAddressList('')).toEqual([])
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([])
  })
})
