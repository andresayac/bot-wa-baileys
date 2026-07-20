import { describe, it, expect } from 'vitest'
import { MockProvider } from '../src/testing/MockProvider.js'

describe('MockProvider', () => {
  it('start emits open connection', async () => {
    const p = new MockProvider()
    const states: string[] = []
    p.onTyped('connection', (u: any) => states.push(u.state))
    await p.start()
    expect(states).toContain('open')
  })

  it('send accumulates outbox and emits sent', async () => {
    const p = new MockProvider()
    const sent: any[] = []
    p.on('sent', (m) => sent.push(m))
    await p.send('x@s.whatsapp.net', { text: 'hola' })
    expect(p.outbox).toHaveLength(1)
    expect(p.outbox[0].content).toEqual({ text: 'hola' })
    expect(sent).toHaveLength(1)
  })

  it('incoming emits a rawMessage Baileys-shaped', async () => {
    const p = new MockProvider()
    let raw: any
    p.onTyped('rawMessage', (r: any) => { raw = r })
    p.incoming('hola', { from: 'user@s.whatsapp.net' })
    expect(raw.type).toBe('notify')
    expect(raw.message.key.remoteJid).toBe('user@s.whatsapp.net')
    expect(raw.message.key.fromMe).toBe(false)
    expect(raw.message.message.conversation).toBe('hola')
  })
})
