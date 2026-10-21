/** `capabilities.exclusiveSession`: one live IMAP session per mailbox; `ingest()`-only is not exclusive. */
import { describe, expect, it } from 'vitest'
import { EmailProvider } from '../src/index.js'

const imap = { host: 'imap.example.com', user: 'bot@example.com', pass: 'secret' }

describe('EmailProvider exclusiveSession', () => {
  it('is exclusive when it owns an IMAP connection', () => {
    expect(new EmailProvider({ address: 'bot@example.com', imap }).capabilities.exclusiveSession).toBe(true)
    expect(new EmailProvider({ address: 'bot@example.com', createImapClient: () => ({}) as never }).capabilities.exclusiveSession).toBe(true)
  })

  it('is not exclusive with ingest() only (a push ingress)', () => {
    expect(new EmailProvider({ address: 'bot@example.com' }).capabilities.exclusiveSession).toBe(false)
  })
})
