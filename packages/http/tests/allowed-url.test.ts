/** isAllowedHostUrl: a synchronous host allow-list check for URLs read back from storage. */
import { describe, expect, it } from 'vitest'
import { isAllowedHostUrl } from '../src/index.js'

const policy = { hosts: ['fbcdn.net', 'cdn.example.com', '127.0.0.1'] }

describe('isAllowedHostUrl', () => {
  it('accepts https URLs on a listed host or a subdomain of one', () => {
    expect(isAllowedHostUrl('https://fbcdn.net/a.jpg', policy)).toBe(true)
    expect(isAllowedHostUrl('https://scontent.xx.fbcdn.net/v/t1/a.jpg?_nc_sig=abc', policy)).toBe(true)
    expect(isAllowedHostUrl('https://CDN.Example.com./x', policy)).toBe(true)
    expect(isAllowedHostUrl('https://127.0.0.1:8443/x', policy)).toBe(true)
  })

  it('rejects other hosts, look-alikes, credentials, other schemes, junk and over-long URLs', () => {
    for (const url of [
      'https://evil.example/a.jpg', 'https://fbcdn.net.evil.example/a', 'https://notfbcdn.net/a',
      'https://sub.cdn.example.com.evil/a', 'https://user:pw@fbcdn.net/a', 'http://fbcdn.net/a',
      'ftp://fbcdn.net/a', 'file:///etc/passwd', 'not a url', '', 42, null, undefined, { url: 'https://fbcdn.net' },
      `https://fbcdn.net/${'x'.repeat(5000)}`, 'https://127.0.0.2/x', 'https://1.127.0.0.1/x',
    ]) {
      expect(isAllowedHostUrl(url, policy), String(url).slice(0, 60)).toBe(false)
    }
  })

  it('allows plain http only when asked, and honours maxLength', () => {
    expect(isAllowedHostUrl('http://127.0.0.1:9/x', { ...policy, allowHttp: true })).toBe(true)
    expect(isAllowedHostUrl('https://fbcdn.net/abcdef', { ...policy, maxLength: 10 })).toBe(false)
  })

  it('an empty host list allows nothing', () => {
    expect(isAllowedHostUrl('https://fbcdn.net/a', { hosts: [] })).toBe(false)
  })
})
