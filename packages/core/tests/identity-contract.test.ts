import { describe, it, expect } from 'vitest'
import {
  checkIdentityContract,
  assertStableIdentity,
  IdentityContractError,
  recordEvents,
} from '../src/testing/identityContract.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import type { ChatKind, InboundEvent, InboundInteraction, InboundMessage } from '../src/core/provider.js'

const PN = '573001112233@s.whatsapp.net'
const LID = '111111111111111@lid'

function dm(senderId: string, id: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    ref: { id, chatId: senderId },
    chat: { id: senderId, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: senderId },
    from: senderId, sender: senderId, chatId: senderId, senderId,
    isGroup: false, isBroadcast: false, fromMe: false,
    type: 'text', body: 'x', timestamp: 1, mentions: [], raw: {},
    ...over,
  }
}

function group(groupId: string, senderId: string, id: string, kind: ChatKind = 'group'): InboundMessage {
  const isGroup = kind === 'group'
  return {
    ref: { id, chatId: groupId },
    chat: { id: groupId, kind, isGroup, isBroadcast: false },
    senderInfo: { id: senderId },
    from: groupId, sender: senderId, chatId: groupId, senderId,
    isGroup, isBroadcast: false, fromMe: false,
    type: 'text', body: 'x', timestamp: 1, mentions: [], raw: {},
  }
}

function click(senderId: string, interactionId: string): InboundInteraction {
  return {
    interactionId,
    ref: { id: 'menu', chatId: senderId },
    chat: { id: senderId, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: senderId },
    from: senderId, sender: senderId, chatId: senderId, senderId,
    isGroup: false, kind: 'button', data: 'ok', timestamp: 1, raw: {},
  }
}

const rules = (events: Parameters<typeof checkIdentityContract>[0], ex?: Parameters<typeof checkIdentityContract>[1]) =>
  checkIdentityContract(events, ex).map((v) => v.rule)

describe('checkIdentityContract / assertStableIdentity', () => {
  it('accepts a conforming stream (stable ids, consistent kinds)', () => {
    const events: InboundEvent[] = [
      { kind: 'message', message: dm(PN, 'm1') },
      { kind: 'connection', update: { state: 'ready' } },
      { kind: 'message', message: group('g1@g.us', PN, 'm2') },
      { kind: 'interaction', interaction: click(PN, 'cb-1') },
      { kind: 'message', message: dm('maria', 'm3') },
    ]
    expect(checkIdentityContract(events, { andres: [0, 2, 3], maria: [4] })).toEqual([])
    expect(() => assertStableIdentity(events, { andres: { events: [0, 2, 3], senderId: PN } })).not.toThrow()
  })

  it('flags the LID/PN flip: one human split across two sender and chat ids', () => {
    const events = [dm(PN, 'm1'), dm(LID, 'm2'), dm(PN, 'm3')]
    expect(rules(events, { andres: [0, 1, 2] })).toEqual(expect.arrayContaining(['unstable-sender', 'unstable-chat']))
    let thrown: unknown
    try { assertStableIdentity(events, { andres: [0, 1, 2] }) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(IdentityContractError)
    const err = thrown as IdentityContractError
    expect(err.violations.length).toBeGreaterThanOrEqual(2)
    expect(err.message).toContain('andres')
    expect(err.message).toContain(LID)
  })

  it('checks the expected canonical sender / chat when given', () => {
    const events = [dm(LID, 'm1'), dm(LID, 'm2')]
    expect(rules(events, { andres: { events: [0, 1], senderId: PN } })).toContain('unexpected-sender')
    expect(rules(events, { andres: { events: [0, 1], chatId: PN } })).toContain('unexpected-chat')
    expect(rules([group('g1', PN, 'm1')], { andres: { events: [0], kind: 'dm' } })).toContain('unexpected-kind')
  })

  it('flags missing and "undefined" ids', () => {
    expect(rules([dm(PN, 'm1', { senderId: undefined as never })])).toContain('missing-id')
    expect(rules([dm(PN, '', {})])).toContain('missing-id')
    expect(rules([dm('undefined@s.whatsapp.net', 'm1')])).toContain('suspicious-id')
    expect(rules([dm('null', 'm1')])).toContain('suspicious-id')
    expect(rules([click(PN, '')])).toContain('missing-id')
  })

  it('flags alias fields that disagree (from/chatId/chat.id, sender/senderId/senderInfo.id, ref.chatId)', () => {
    expect(rules([dm(PN, 'm1', { from: LID })])).toContain('alias-mismatch')
    expect(rules([dm(PN, 'm1', { senderInfo: { id: LID } })])).toContain('alias-mismatch')
    expect(rules([dm(PN, 'm1', { ref: { id: 'm1', chatId: LID } })])).toContain('alias-mismatch')
    expect(checkIdentityContract([dm(PN, 'm1', { ref: { id: 'm1', chatId: LID } })], undefined, { requireRefChatId: false })).toEqual([])
  })

  it('flags ChatKind inconsistencies and kind drift for one chat', () => {
    const wrongFlag = group('g1', PN, 'm1')
    wrongFlag.isGroup = false
    expect(rules([wrongFlag])).toContain('chat-kind')
    expect(rules([dm(PN, 'm1', { chat: { id: PN, kind: 'bogus' as ChatKind, isGroup: false, isBroadcast: false } })])).toContain('chat-kind')
    expect(rules([dm(PN, 'm1', { isBroadcast: true })])).toContain('chat-kind')
    expect(rules([group('g1', PN, 'm1'), group('g1', PN, 'm2', 'channel')])).toContain('kind-drift')
    // a channel may be flagged broadcast (Telegram) or not (WhatsApp newsletter)
    const channel = group('ch1', 'ch1', 'm1', 'channel')
    expect(rules([channel])).toEqual([])
    expect(rules([{ ...channel, isBroadcast: true, chat: { ...channel.chat, isBroadcast: true } }])).toEqual([])
  })

  it('flags two humans collapsed into one senderId', () => {
    expect(rules([dm(PN, 'm1'), dm(PN, 'm2')], { andres: [0], maria: [1] })).toContain('collapsed-humans')
  })

  it('reports out-of-range or non-identity indices', () => {
    const events: InboundEvent[] = [{ kind: 'connection', update: { state: 'ready' } }]
    expect(rules(events, { andres: [0] })).toContain('bad-index')
    expect(rules(events, { andres: [7] })).toContain('bad-index')
  })

  it('recordEvents() collects a provider stream for later assertions', () => {
    const provider = new MockProvider()
    const rec = recordEvents(provider)
    provider.incoming('hola', { from: 'u1' })
    provider.interaction('ok', { from: 'u1' })
    provider.incoming('hola', { from: 'u2' })
    rec.stop()
    provider.incoming('ignored', { from: 'u3' })
    expect(rec.events).toHaveLength(3)
    expect(rec.messages()).toHaveLength(2)
    expect(rec.interactions()).toHaveLength(1)
    expect(() => assertStableIdentity(rec.events, { u1: [0, 1], u2: [2] })).not.toThrow()
  })
})
