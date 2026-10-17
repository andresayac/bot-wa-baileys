/**
 * IProvider signature parity + an end-to-end pass through a real `Bot`:
 * a signed comment webhook reaches a handler and `ctx.reply()` becomes a
 * comment reply. Hermetic — fetch and DNS are injected.
 */

import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { Bot, type IProvider } from '@bot-wa/core'
import { TikTokProvider } from '../src/TikTokProvider.js'
import * as fx from './fixtures/webhooks.js'

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type IProviderMethod = {
  [K in keyof IProvider]-?: NonNullable<IProvider[K]> extends (...args: never[]) => unknown ? K : never
}[keyof IProvider]
type DivergentMethods<C> = {
  [K in IProviderMethod & keyof C]-?: C[K] extends (...args: infer P) => unknown
    ? Equals<P, Parameters<NonNullable<IProvider[K]>>> extends true ? never : K
    : K
}[IProviderMethod & keyof C]

const SECRET = 'client-secret'
const sign = (raw: string) => {
  const t = Math.floor(Date.now() / 1000)
  return { 'tiktok-signature': `t=${t},s=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}` }
}

describe('TikTokProvider — IProvider contract', () => {
  it('is assignable to IProvider', () => {
    expectTypeOf<TikTokProvider>().toExtend<IProvider>()
  })
  it('declares every IProvider method with exactly the interface parameters', () => {
    expectTypeOf<DivergentMethods<TikTokProvider>>().toEqualTypeOf<never>()
  })
})

describe('TikTokProvider + Bot', () => {
  it('routes a comment to a handler and ctx.reply() answers in the comment thread', async () => {
    const bodies: Array<{ url: string; json: unknown }> = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      bodies.push({ url: String(url), json: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ code: 0, message: 'OK', data: { comment_id: '555' } }))
    })
    const provider = new TikTokProvider({
      accessToken: 'ACCESS',
      businessId: fx.BUSINESS_ID,
      appSecret: SECRET,
      http: { fetch: fetch as unknown as typeof globalThis.fetch, resolver: async () => ['93.184.216.34'] },
    })
    const bot = new Bot({ provider })
    const replied = new Promise<void>((resolve) => {
      bot.when('precio?', async (ctx) => {
        await ctx.reply('Te escribimos por DM 🙌')
        resolve()
      })
    })
    await bot.start()
    expect(provider.ingest(fx.commentInsertRaw, sign(fx.commentInsertRaw))).toBe(200)
    await replied
    await bot.stop()

    expect(bodies).toEqual([{
      url: 'https://business-api.tiktok.com/open_api/v1.3/business/comment/reply/create/',
      json: { business_id: fx.BUSINESS_ID, video_id: '7203946942097902849', comment_id: '7247303576418566913', text: 'Te escribimos por DM 🙌' },
    }])
  })
})
