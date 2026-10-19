import { describe, expect, it } from 'vitest'
import { findLinks } from '../src/index.js'

describe('findLinks — bounded cost on adversarial bodies', () => {
  it('stays linear on a body packed with distinct bare invite links', () => {
    let body = ''
    for (let i = 0; body.length < 200_000; i++) body += `t.me/${i.toString(36)} `
    const started = performance.now()
    const links = findLinks(body)
    const elapsed = performance.now() - started
    expect(links.length).toBeGreaterThan(20_000)
    // The previous O(n²) de-duplication took seconds here.
    expect(elapsed).toBeLessThan(1000)
  })

  it('still skips a bare invite host that is part of a scheme link', () => {
    expect(findLinks('https://t.me/joinchat/AAAA y t.me/+BBBB')).toEqual(['https://t.me/joinchat/AAAA', 't.me/+BBBB'])
  })
})
