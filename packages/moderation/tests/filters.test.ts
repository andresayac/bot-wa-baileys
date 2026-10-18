import { describe, expect, it } from 'vitest'
import { compileTerms, findInviteLinks, findLinks } from '../src/index.js'
import { firstMatch } from '../src/words.js'
import { RateWindow } from '../src/rateWindow.js'

describe('findInviteLinks', () => {
  it('detects WhatsApp, Telegram and Discord group invites', () => {
    const text = 'únete https://chat.whatsapp.com/AbCdEf123456 o t.me/+XyZ987abc o discord.gg/abc12 ya'
    expect(findInviteLinks(text).map((l) => [l.platform, l.code])).toEqual([
      ['whatsapp', 'AbCdEf123456'],
      ['telegram', 'XyZ987abc'],
      ['discord', 'abc12'],
    ])
  })

  it('supports t.me/joinchat, discord.com/invite and custom patterns', () => {
    expect(findInviteLinks('https://t.me/joinchat/AAAA-bbb')[0]?.code).toBe('AAAA-bbb')
    expect(findInviteLinks('https://discord.com/invite/zzTop')[0]?.code).toBe('zzTop')
    expect(findInviteLinks('entra a mi.grupo/invite/QQ11', [/mi\.grupo\/invite\/(\w+)/])).toEqual([
      { platform: 'custom', code: 'QQ11', url: 'mi.grupo/invite/QQ11' },
    ])
  })

  it('ignores ordinary text and non-invite links', () => {
    expect(findInviteLinks('hola.que tal, mira https://example.com/x')).toEqual([])
  })
})

describe('findLinks', () => {
  it('finds scheme and www links but not bare words with dots', () => {
    expect(findLinks('ver https://a.com/x y www.b.org pero no hola.que')).toEqual(['https://a.com/x', 'www.b.org'])
  })
  it('finds bare invite hosts without a scheme', () => {
    expect(findLinks('chat.whatsapp.com/ABCDEF123')).toEqual(['chat.whatsapp.com/ABCDEF123'])
  })
})

describe('compileTerms', () => {
  it('matches whole words, case- and diacritic-insensitively', () => {
    const terms = compileTerms(['estafa', 'spam'])
    expect(firstMatch(terms, 'Esto es una ESTAFÁ!')?.label).toBe('estafa')
    expect(firstMatch(terms, 'soy un spammer')).toBeUndefined()
    expect(firstMatch(terms, 'nada raro')).toBeUndefined()
  })
  it('wholeWord: false matches substrings', () => {
    expect(firstMatch(compileTerms(['spam'], false), 'soy un spammer')?.label).toBe('spam')
  })
  it('regex terms test the raw body and are stateless with the g flag', () => {
    const terms = compileTerms([/bit\.ly\/\w+/gi])
    expect(firstMatch(terms, 'mira bit.ly/abc')?.label).toBe('/bit\\.ly\\/\\w+/gi')
    expect(firstMatch(terms, 'mira bit.ly/abc')).toBeDefined()
  })
})

describe('RateWindow', () => {
  it('counts hits inside a sliding window', () => {
    const w = new RateWindow()
    expect(w.hit('k', 0, 1000)).toBe(1)
    expect(w.hit('k', 500, 1000)).toBe(2)
    expect(w.hit('k', 1200, 1000)).toBe(2) // the hit at 0 left the window
    w.reset('k')
    expect(w.hit('k', 1300, 1000)).toBe(1)
  })
  it('sweeps idle keys when it grows past the threshold', () => {
    const w = new RateWindow(2)
    w.hit('a', 0, 100)
    w.hit('b', 0, 100)
    w.hit('c', 1000, 100)
    expect(w.size).toBe(1)
  })
})
