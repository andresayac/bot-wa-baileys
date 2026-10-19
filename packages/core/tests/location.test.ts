import { describe, it, expect } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { Bot } from '../src/core/Bot.js'
import { LOCATION } from '../src/core/triggers.js'
import { toInboundLocation } from '../src/index.js'
import type { InboundLocation, MessageContext } from '../src/index.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

describe('inbound location (InboundMessage.location → ctx.sharedLocation)', () => {
  it('MockProvider.incomingLocation emits a location message with normalized coordinates', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    const seen: MessageContext[] = []
    bot.onMessage((ctx) => { seen.push(ctx) })
    await bot.start()
    provider.incomingLocation({ latitude: 4.711, longitude: -74.0721, name: 'Plaza de Bolívar', address: 'Bogotá' }, { from: 'u1' })
    await tick()
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe('location')
    expect(seen[0].sharedLocation).toEqual({ latitude: 4.711, longitude: -74.0721, name: 'Plaza de Bolívar', address: 'Bogotá' })
    expect(seen[0].body).toBe('Plaza de Bolívar')
    expect(seen[0].media).toBeUndefined()
    await bot.stop()
  })

  it('a bare pin has an empty body; live locations are flagged', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    const seen: Array<InboundLocation | undefined> = []
    const bodies: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.sharedLocation); bodies.push(ctx.body) })
    await bot.start()
    provider.incomingLocation({ latitude: 1, longitude: 2 })
    provider.incomingLocation({ latitude: 1.5, longitude: 2.5, live: true }, { from: 'u2' })
    await tick()
    expect(seen).toEqual([{ latitude: 1, longitude: 2 }, { latitude: 1.5, longitude: 2.5, live: true }])
    expect(bodies).toEqual(['', ''])
    await bot.stop()
  })

  it('is undefined on messages without a location', async () => {
    const { bot, chat } = await createTestBot()
    let loc: InboundLocation | undefined | null = null
    bot.onMessage((ctx) => { loc = ctx.sharedLocation })
    await chat.send('hola')
    expect(loc).toBeUndefined()
    await bot.stop()
  })

  it('the LOCATION trigger matches it and a conversation wait receives it', async () => {
    const { bot, chat } = await createTestBot()
    bot.when(LOCATION, (ctx) => ctx.reply(`pin ${ctx.sharedLocation?.latitude}`))
    await chat.sendLocation({ latitude: 6.25, longitude: -75.56 })
    await chat.expectReply('pin 6.25')

    bot.conversation('envio', async (c) => {
      await c.say('Comparte tu ubicación')
      const m = (await c.waitAny()) as unknown as MessageContext
      await c.say(`Entregamos en ${m.sharedLocation?.latitude},${m.sharedLocation?.longitude}`)
    })
    await chat.send('envio')
    await chat.expectReply('Comparte')
    await chat.sendLocation({ latitude: 6.26, longitude: -75.57, name: 'Casa' })
    await chat.expectReply('Entregamos en 6.26,-75.57')
    await bot.stop()
  })
})

describe('toInboundLocation (provider helper)', () => {
  it('normalizes valid coordinates and optional fields', () => {
    expect(toInboundLocation({ latitude: 4.6, longitude: -74.1, name: 'Casa', address: '', live: true }))
      .toEqual({ latitude: 4.6, longitude: -74.1, name: 'Casa', live: true })
    expect(toInboundLocation({ latitude: '4.6', longitude: '-74.1', live: 'yes' })).toEqual({ latitude: 4.6, longitude: -74.1 })
  })

  it('rejects missing, non-finite or out-of-range coordinates', () => {
    expect(toInboundLocation(undefined)).toBeUndefined()
    expect(toInboundLocation({ latitude: 4.6 })).toBeUndefined()
    expect(toInboundLocation({ latitude: null, longitude: null })).toBeUndefined()
    expect(toInboundLocation({ latitude: Number.NaN, longitude: 1 })).toBeUndefined()
    expect(toInboundLocation({ latitude: 91, longitude: 1 })).toBeUndefined()
    expect(toInboundLocation({ latitude: 1, longitude: -181 })).toBeUndefined()
    expect(toInboundLocation({ latitude: '', longitude: 1 })).toBeUndefined()
  })
})
