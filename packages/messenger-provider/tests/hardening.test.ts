import { describe, it, expect, vi, afterEach } from 'vitest'
import { OutsideSessionWindowError, RecipientUnreachableError } from '@bot-wa/core'
import { MessengerProvider, toProviderError } from '../src/MessengerProvider.js'
import { toOutbound } from '../src/toOutbound.js'
import { parseInbound } from '../src/parseInbound.js'

const baseCfg = { accessToken: 'TOK', verifyToken: 'vt', allowUnsignedWebhooks: true }

function stubGraphError(error: Record<string, unknown>, status = 400): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error }),
  })))
}

afterEach(() => vi.unstubAllGlobals())

describe('Messenger error mapping', () => {
  it('outside the 24h window (code 10 / subcode 2018278) → OutsideSessionWindowError with the chat id', async () => {
    stubGraphError({ code: 10, error_subcode: 2018278, message: '(#10) This message is sent outside of allowed window.' })
    const err = await new MessengerProvider(baseCfg).send('PSID1', { kind: 'text', text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OutsideSessionWindowError)
    expect((err as OutsideSessionWindowError).chatId).toBe('PSID1')
  })

  it('"person isn\'t available" (551) and "no matching user" (100 / 2018001) → RecipientUnreachableError', async () => {
    stubGraphError({ code: 551, error_subcode: 1545041, message: "This person isn't available right now." })
    const err = await new MessengerProvider(baseCfg).send('PSID2', { kind: 'text', text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecipientUnreachableError)
    expect((err as RecipientUnreachableError).chatId).toBe('PSID2')
    expect(toProviderError({ code: 100, error_subcode: 2018001, message: 'No matching user found' }, undefined, 'P')).toBeInstanceOf(RecipientUnreachableError)
  })
})

describe('Messenger outbound hardening', () => {
  it('URL buttons become web_url buttons; an empty id falls back to the title', () => {
    const msg = toOutbound({
      kind: 'buttons',
      text: 'Elige',
      buttons: [{ id: 'web', title: 'Web', url: 'https://x.dev' }, { id: '', title: 'Sin id' }],
    }) as { attachment: { payload: { buttons: unknown[] } } }
    expect(msg.attachment.payload.buttons).toEqual([
      { type: 'web_url', title: 'Web', url: 'https://x.dev' },
      { type: 'postback', title: 'Sin id', payload: 'Sin id' },
    ])
  })

  it('a card with image/buttons becomes a generic template (image and buttons are not dropped)', () => {
    const msg = toOutbound({
      kind: 'card',
      title: 'Pan de queso',
      body: 'Recién horneado',
      imageUrl: 'https://x.dev/pan.jpg',
      buttons: [{ id: 'BUY', title: 'Comprar' }],
    })
    expect(msg).toEqual({
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [{
            title: 'Pan de queso',
            subtitle: 'Recién horneado',
            image_url: 'https://x.dev/pan.jpg',
            buttons: [{ type: 'postback', title: 'Comprar', payload: 'BUY' }],
          }],
        },
      },
    })
  })

  it('generic-template titles and subtitles are cut to 80 chars', () => {
    const long = 'x'.repeat(120)
    const msg = toOutbound({ kind: 'list', text: 't', buttonText: 'b', sections: [{ title: 's', rows: [{ id: 'r', title: long, description: long }] }] }) as {
      attachment: { payload: { elements: Array<{ title: string; subtitle: string }> } }
    }
    expect(msg.attachment.payload.elements[0].title).toHaveLength(80)
    expect(msg.attachment.payload.elements[0].subtitle).toHaveLength(80)
  })
})

describe('Messenger inbound hardening', () => {
  it('a shared location is a location message, not a document', () => {
    const [ev] = parseInbound({
      object: 'page',
      entry: [{ messaging: [{ sender: { id: 'U' }, timestamp: 1, message: { mid: 'm1', attachments: [{ type: 'location', payload: { title: 'Pin' } }] } }] }],
    })
    expect(ev.kind).toBe('message')
    const m = (ev as { kind: 'message'; message: { type: string; media?: unknown } }).message
    expect(m.type).toBe('location')
    expect(m.media).toBeUndefined()
  })

  it('a reply carries the quoted message id', () => {
    const [ev] = parseInbound({
      object: 'page',
      entry: [{ messaging: [{ sender: { id: 'U' }, timestamp: 1, message: { mid: 'm2', text: 'sí', reply_to: { mid: 'm1' } } }] }],
    })
    expect((ev as { kind: 'message'; message: { quoted?: { ref: { id: string } } } }).message.quoted?.ref.id).toBe('m1')
  })
})
