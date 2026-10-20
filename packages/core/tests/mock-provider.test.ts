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

describe('MockProvider journal, media and reactions', () => {
  it('journals inbound messages/interactions and sends (with the ref send() returned) in order', async () => {
    const p = new MockProvider()
    p.incoming('hola', { from: 'u' })
    const res = await p.send('u', { kind: 'text', text: 'hi' })
    p.interaction('btn', { from: 'u', kind: 'list' })
    p.call({ from: 'u' })
    expect(p.journal.map((e) => e.dir)).toEqual(['in', 'out', 'in'])
    expect(p.journal.map((e) => e.seq)).toEqual([1, 2, 3])
    const out = p.journal[1]
    expect(out.dir === 'out' ? out : undefined).toMatchObject({ chatId: 'u', content: { kind: 'text', text: 'hi' }, ref: res.ref })
    const it = p.journal[2]
    expect(it.dir === 'in' && it.event.kind === 'interaction' ? it.event.interaction.kind : undefined).toBe('list')
    expect(p.outbox).toEqual([{ chatId: 'u', content: { kind: 'text', text: 'hi' }, options: undefined }])
    p.clearJournal()
    expect(p.journal).toEqual([])
    p.incoming('otra', { from: 'u' })
    expect(p.journal[0].seq).toBe(4)
  })

  it('caps the journal with maxJournal (oldest first) and rejects a bad cap', async () => {
    const p = new MockProvider({ maxJournal: 2 })
    p.incoming('1'); p.incoming('2'); p.incoming('3')
    expect(p.journal.map((e) => (e.dir === 'in' && e.event.kind === 'message' ? e.event.message.body : ''))).toEqual(['2', '3'])
    expect(() => new MockProvider({ maxJournal: 0 })).toThrow(RangeError)
    const unbounded = new MockProvider({ maxJournal: Infinity })
    for (let i = 0; i < 5; i++) unbounded.incoming('x')
    expect(unbounded.journal).toHaveLength(5)
  })

  it('incomingMedia builds a MediaRef whose bytes downloadMedia returns', async () => {
    const p = new MockProvider()
    let ev: InboundEvent | undefined
    p.onEvent((e) => { ev = e })
    const bytes = Buffer.from('abc')
    p.incomingMedia('document', bytes, { from: 'u', caption: 'cap', filename: 'a.txt', mimetype: 'text/plain' })
    expect(ev?.kind).toBe('message')
    if (ev?.kind !== 'message') return
    expect(ev.message.type).toBe('document')
    expect(ev.message.body).toBe('cap')
    expect(ev.message.media).toMatchObject({ kind: 'document', mimetype: 'text/plain', filename: 'a.txt', size: 3 })
    const downloaded = await p.downloadMedia(ev.message.media!)
    expect(downloaded.equals(bytes)).toBe(true)
    expect(downloaded).not.toBe(bytes)

    p.incomingMedia('image', new Uint8Array([1, 2]), { from: 'u' })
    if (ev?.kind !== 'message') return
    expect(ev.message.body).toBe('')
    expect(ev.message.media?.mimetype).toBe('image/jpeg')
    expect((await p.downloadMedia(ev.message.media!)).length).toBe(2)

    p.incomingMedia('video', { url: 'https://x/v.mp4', bytes: Buffer.from('mp4') }, { from: 'u', media: { size: 1234 } })
    if (ev?.kind !== 'message') return
    expect(ev.message.media).toMatchObject({ kind: 'video', size: 1234, token: { url: 'https://x/v.mp4' } })
    expect((await p.downloadMedia(ev.message.media!)).toString()).toBe('mp4')

    p.incomingMedia('audio', { url: 'https://x/a.ogg' }, { from: 'u' })
    if (ev?.kind !== 'message') return
    await expect(p.downloadMedia(ev.message.media!)).rejects.toThrow(/pass bytes/)
    await expect(p.downloadMedia({ kind: 'image', token: null })).resolves.toEqual(Buffer.alloc(0))
    await expect(p.downloadMedia()).resolves.toEqual(Buffer.alloc(0))
  })

  it('incoming({ media }) overrides the auto-built MediaRef fields', () => {
    const p = new MockProvider()
    let ev: InboundEvent | undefined
    p.onEvent((e) => { ev = e })
    p.incoming('', { type: 'image', media: { mimetype: 'image/gif', token: { bytes: Buffer.from('gif') } } })
    expect(ev?.kind === 'message' ? ev.message.media : undefined).toEqual({ kind: 'image', mimetype: 'image/gif', token: { bytes: Buffer.from('gif') } })
    p.incoming('texto', { media: { mimetype: 'x' } })
    expect(ev?.kind === 'message' ? ev.message.media : undefined).toBeUndefined()
  })

  it('reaction() emits a reaction event with the target ref, sender and removed flag', () => {
    const p = new MockProvider()
    const events: InboundEvent[] = []
    p.onEvent((e) => { events.push(e) })
    const to: MessageRef = { id: 'm1', chatId: 'u' }
    p.reaction('👍', { to })
    p.reaction('👍', { to, from: 'g', sender: 'member', removed: true })
    expect(events[0]).toEqual({ kind: 'reaction', reaction: { ref: to, emoji: '👍', senderId: 'u' } })
    expect(events[1]).toEqual({ kind: 'reaction', reaction: { ref: to, emoji: '👍', senderId: 'member', removed: true } })
    expect(p.journal).toEqual([])
  })
})
