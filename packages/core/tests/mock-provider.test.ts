import { describe, it, expect } from 'vitest'
import { MockProvider } from '../src/testing/MockProvider.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import type { DraftOptions, InboundEvent, MessageRef, OutboundContent, SendResult } from '../src/core/provider.js'

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

describe('MockProvider optional seams (editMessage / deleteMessage / sendDraft)', () => {
  // User code that subclasses MockProvider with real methods must typecheck (no TS2425).
  class UserMock extends MockProvider {
    edited: string[] = []
    async editMessage(ref: MessageRef, content: OutboundContent): Promise<SendResult> {
      this.edited.push(content.kind === 'text' ? content.text : content.kind)
      return { ref }
    }
    async deleteMessage(_ref: MessageRef): Promise<void> {}
    async sendDraft(_chatId: string, _draftId: number, _text: string, _opts?: DraftOptions): Promise<void> {}
  }

  it('are real class methods a subclass can override; overrides are never hidden', async () => {
    expect(typeof MockProvider.prototype.editMessage).toBe('function')
    expect(typeof MockProvider.prototype.deleteMessage).toBe('function')
    expect(typeof MockProvider.prototype.sendDraft).toBe('function')
    const p = new UserMock()
    expect(typeof p.editMessage).toBe('function')
    await p.editMessage({ id: '1', chatId: 'c' }, { kind: 'text', text: 'x' })
    expect(p.edited).toEqual(['x'])
  })

  it('look unsupported (undefined) unless the streaming mode or `supports` enables them', async () => {
    const plain = new MockProvider()
    expect(plain.editMessage).toBeUndefined()
    expect(plain.deleteMessage).toBeUndefined()
    expect(plain.sendDraft).toBeUndefined()

    const edit = new MockProvider({ streaming: 'edit' })
    expect(typeof edit.editMessage).toBe('function')
    expect(typeof edit.deleteMessage).toBe('function')
    expect(edit.sendDraft).toBeUndefined()
    await edit.editMessage!({ id: '1', chatId: 'c' }, { kind: 'text', text: 'y' })
    expect(edit.edits).toHaveLength(1)

    const opted = new MockProvider({ supports: { edit: true, delete: true } })
    expect(typeof opted.editMessage).toBe('function')
    await opted.deleteMessage!({ id: '1', chatId: 'c' })
    expect(opted.deleted).toHaveLength(1)

    const off = new MockProvider({ streaming: 'draft', supports: { drafts: false, edit: false } })
    expect(off.sendDraft).toBeUndefined()
    expect(off.editMessage).toBeUndefined()
    expect(typeof off.deleteMessage).toBe('function')
  })

  it('an explicit supports: false hides even a subclass override', () => {
    class NoEdit extends UserMock {
      constructor() { super({ supports: { edit: false } }) }
    }
    expect(new NoEdit().editMessage).toBeUndefined()
    expect(typeof new NoEdit().deleteMessage).toBe('function')
  })

  it('textFormat simulates capabilities.textFormat (unset by default)', () => {
    expect(new MockProvider().capabilities.textFormat).toBeUndefined()
    expect(new MockProvider({ textFormat: 'whatsapp' }).capabilities.textFormat).toBe('whatsapp')
  })
  it('buttons: false simulates a channel without native buttons (on by default)', () => {
    const on = new MockProvider().capabilities
    expect(on.buttons).toBe(true)
    expect(on.contentKinds).toContain('buttons')
    const off = new MockProvider({ buttons: false }).capabilities
    expect(off.buttons).toBe(false)
    expect(off.contentKinds).not.toContain('buttons')
  })

  it('acknowledgeInteraction records each ack in `acks`', async () => {
    const p = new MockProvider()
    await p.acknowledgeInteraction('it-1')
    await p.acknowledgeInteraction('it-2', { text: 'ok' })
    expect(p.acks).toEqual([{ interactionId: 'it-1' }, { interactionId: 'it-2', opts: { text: 'ok' } }])
  })
})

describe('createTestBot', () => {
  it('chat.replies()/expectReply see the text of buttons and list messages', async () => {
    const { bot, chat } = await createTestBot()
    bot.when('menu', async (ctx) => { await ctx.buttons('Elige', [{ id: 'a', title: 'A' }]) })
    await chat.send('menu')
    await chat.expectReply('Elige')
    expect(chat.replies()).toEqual(['Elige'])
    await bot.stop()
  })
})
