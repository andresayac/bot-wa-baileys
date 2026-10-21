/**
 * IProvider signature parity + an end-to-end round trip through a real Bot:
 * a signed webhook reaches a handler and the reply goes out over REST.
 */

import { describe, it, expect, expectTypeOf } from 'vitest'
import { Bot, type IProvider } from '@botmesh/core'
import { TwilioProvider } from '../src/TwilioProvider.js'
import type { TwilioWebhookParams } from '../src/types.js'
import { computeTwilioSignature, parseFormParams } from '../src/signature.js'
import { fakeHttp } from './support.js'
import { form, WA_TEXT } from './fixtures.js'

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Raw = TwilioWebhookParams
type IProviderMethod = {
  [K in keyof IProvider<Raw>]-?: NonNullable<IProvider<Raw>[K]> extends (...args: never[]) => unknown ? K : never
}[keyof IProvider<Raw>]
type DivergentMethods<C> = {
  [K in IProviderMethod & keyof C]-?: C[K] extends (...args: infer P) => unknown
    ? Equals<P, Parameters<NonNullable<IProvider<Raw>[K]>>> extends true ? never : K
    : K
}[IProviderMethod & keyof C]

describe('TwilioProvider — IProvider contract', () => {
  it('is assignable to IProvider with interface-exact method parameters', () => {
    expectTypeOf<TwilioProvider>().toExtend<IProvider>()
    expectTypeOf<DivergentMethods<TwilioProvider>>().toEqualTypeOf<never>()
  })

  it('drives a Bot: signed webhook → handler → REST reply to the same chat', async () => {
    const { calls, http } = fakeHttp(() => ({ status: 201, json: { sid: 'SMreply' } }))
    const provider = new TwilioProvider({
      accountSid: 'AC1', authToken: 'tok', whatsappFrom: 'whatsapp:+14155238886',
      webhookUrl: 'https://bot.example.com/hook', http,
    })
    const bot = new Bot({ provider })
    const seen: string[] = []
    bot.when('hola', async (ctx) => {
      seen.push(ctx.sender)
      await ctx.reply('¡Hola!')
    })
    await bot.start()
    const sig = computeTwilioSignature('tok', 'https://bot.example.com/hook', WA_TEXT)
    expect(provider.ingest(form(WA_TEXT), { 'X-Twilio-Signature': sig })).toBe(200)
    await expect.poll(() => calls.length).toBe(1)
    expect(seen).toEqual(['whatsapp:+573001112233'])
    expect(parseFormParams(calls[0]!.body)).toMatchObject({ To: 'whatsapp:+573001112233', Body: '¡Hola!' })
    await bot.stop()
  })
})
