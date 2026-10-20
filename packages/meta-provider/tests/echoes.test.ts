/**
 * Coexistence echoes: a Cloud API number shared with the WhatsApp Business app receives the
 * messages the business sends from the app under the `smb_message_echoes` field. They are not
 * inbound messages: the parser yields no event for them, so the bot never answers itself.
 */
import { describe, expect, it } from 'vitest'
import { parseInbound, type GraphWebhookBody } from '../src/parseInbound.js'

describe('parseInbound: smb_message_echoes', () => {
  it('yields no event for an echo change (message_echoes, not messages)', () => {
    const body: GraphWebhookBody = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'pnid',
        changes: [{
          field: 'smb_message_echoes',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: 'pnid' },
            message_echoes: [{ from: '15550001111', to: '573001234567', id: 'wamid.echo', timestamp: '1', type: 'text', text: { body: 'hola' } }],
          } as never,
        }],
      }],
    }
    expect(parseInbound(body)).toEqual([])
  })

  it('still parses a regular message delivered in the same webhook', () => {
    const body: GraphWebhookBody = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'pnid',
        changes: [
          { field: 'smb_message_echoes', value: { message_echoes: [{ id: 'wamid.echo', type: 'text', text: { body: 'x' } }] } as never },
          { field: 'messages', value: { messages: [{ from: '573001', id: 'wamid.1', timestamp: '1', type: 'text', text: { body: 'hola' } }] } as never },
        ],
      }],
    }
    const events = parseInbound(body)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind === 'message' && events[0].message.ref.id).toBe('wamid.1')
  })
})
