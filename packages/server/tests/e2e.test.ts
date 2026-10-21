import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Bot } from '@botmesh/core'
import { CloudAPIProvider } from '@botmesh/meta'
import { TelegramProvider } from '@botmesh/telegram'
import { createIngress, createNodeHandler } from '../src/index.js'
import { listen, tick, type Running } from './support.js'

const APP_SECRET = 'app-secret-xyz'

function cloudTextWebhook(text: string): string {
  // Deliberately irregular whitespace: the signature only matches the exact bytes.
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: '1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID' },
          contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
          messages: [{ from: '573001112233', id: 'wamid.1', timestamp: '1749416383', type: 'text', text: { body: text } }],
        },
      }],
    }],
  }, null, 3)
}

let running: Running | undefined
let bot: Bot | undefined
afterEach(async () => { await bot?.stop(); bot = undefined; await running?.close(); running = undefined })

describe('end-to-end with real providers', () => {
  it('delivers a signed Cloud API webhook to the bot and gates /readyz on bot state', async () => {
    const provider = new CloudAPIProvider({ accessToken: 't', phoneNumberId: 'PNID', verifyToken: 'vt', appSecret: APP_SECRET })
    bot = new Bot({ provider })
    const seen: string[] = []
    bot.on('message', (ctx) => { seen.push(ctx.body) })
    const ingress = createIngress({ routes: [{ path: '/webhook', provider }], bot })
    running = await listen(createNodeHandler(ingress))

    expect((await fetch(`${running.url}/readyz`)).status).toBe(503)
    await bot.start()
    expect((await fetch(`${running.url}/readyz`)).status).toBe(200)

    const hs = await fetch(`${running.url}/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`)
    expect(await hs.text()).toBe('42')

    const body = cloudTextWebhook('hola ñandú')
    const signature = 'sha256=' + createHmac('sha256', APP_SECRET).update(Buffer.from(body, 'utf8')).digest('hex')
    const ok = await fetch(`${running.url}/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } })
    expect(ok.status).toBe(200)
    const forged = await fetch(`${running.url}/webhook`, { method: 'POST', body: cloudTextWebhook('forged'), headers: { 'x-hub-signature-256': signature } })
    expect(forged.status).not.toBe(200)

    for (let i = 0; i < 50 && seen.length === 0; i++) await tick(10)
    expect(seen).toEqual(['hola ñandú'])

    await bot.stop()
    bot = undefined
    expect((await fetch(`${running.url}/readyz`)).status).toBe(503)
  })

  it("feeds TelegramProvider (body: 'text') and enforces its secret token", async () => {
    const provider = new TelegramProvider({ token: '1:x', polling: false, webhookSecret: 'tg-secret' })
    const updates: unknown[] = []
    provider.onEvent((e) => { updates.push(e.kind) })
    running = await listen(createNodeHandler(createIngress({ routes: [{ path: '/tg', provider, body: 'text' }] })))
    const update = JSON.stringify({ update_id: 7, message: { message_id: 1, date: 1, chat: { id: 5, type: 'private' }, from: { id: 5, is_bot: false, first_name: 'A' }, text: 'hi' } })
    expect((await fetch(`${running.url}/tg`, { method: 'POST', body: update, headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' } })).status).toBe(200)
    expect((await fetch(`${running.url}/tg`, { method: 'POST', body: update, headers: { 'x-telegram-bot-api-secret-token': 'nope' } })).status).toBe(401)
    expect(updates).toEqual(['message'])
  })
})
