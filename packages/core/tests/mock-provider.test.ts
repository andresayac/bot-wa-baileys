import { describe, it, expect } from 'vitest'
import { MockProvider } from '../src/testing/MockProvider.js'
import type { InboundEvent } from '../src/core/provider.js'

describe('MockProvider (v2)', () => {
  it('start emits a ready connection event', async () => {
    const p = new MockProvider()
    const states: string[] = []
    p.onEvent((e) => { if (e.kind === 'connection') states.push(e.update.state) })
    await p.start()
    expect(states).toContain('ready')
  })

  it('send accumulates the outbox as OutboundContent', async () => {
    const p = new MockProvider()
    const res = await p.send('x', { kind: 'text', text: 'hola' })
    expect(p.outbox).toHaveLength(1)
    expect(p.outbox[0].content).toEqual({ kind: 'text', text: 'hola' })
    expect(res.ref.chatId).toBe('x')
  })

  it('incoming emits a normalized message event', async () => {
    const p = new MockProvider()
    let ev: InboundEvent | undefined
    p.onEvent((e) => { ev = e })
    p.incoming('hola', { from: 'user-1' })
    expect(ev?.kind).toBe('message')
    if (ev?.kind === 'message') {
      expect(ev.message.chatId).toBe('user-1')
      expect(ev.message.fromMe).toBe(false)
      expect(ev.message.type).toBe('text')
      expect(ev.message.body).toBe('hola')
    }
  })

  it('incoming with a media type attaches a MediaRef', async () => {
    const p = new MockProvider()
    let ev: InboundEvent | undefined
    p.onEvent((e) => { ev = e })
    p.incoming('cap', { type: 'image' })
    if (ev?.kind === 'message') {
      expect(ev.message.type).toBe('image')
      expect(ev.message.media?.kind).toBe('image')
    }
  })

  it('interaction emits an interaction event', async () => {
    const p = new MockProvider()
    let ev: InboundEvent | undefined
    p.onEvent((e) => { ev = e })
    p.interaction('btn_yes', { from: 'user-1' })
    expect(ev?.kind).toBe('interaction')
    if (ev?.kind === 'interaction') {
      expect(ev.interaction.data).toBe('btn_yes')
      expect(ev.interaction.kind).toBe('button')
    }
  })
})
