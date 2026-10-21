/**
 * IProvider signature parity + an end-to-end pass through a real `Bot`:
 * a signed comment webhook reaches a handler and `ctx.reply()` becomes a
 * comment reply. Hermetic — fetch and DNS are injected.
 */

import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { Bot, flow, type IProvider } from '@botmesh/core'
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
      selfUniqueIdentifier: fx.SELF_UID,
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

  it('a flow started from a high-intent comment receives the customer answer sent by DM', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let n = 0
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ code: 0, message: 'OK', data: { message: { message_id: `out-${++n}` } } }))
    })
    const provider = new TikTokProvider({
      accessToken: 'ACCESS',
      businessId: fx.BUSINESS_ID,
      appSecret: SECRET,
      selfUniqueIdentifier: fx.SELF_UID,
      http: { fetch: fetch as unknown as typeof globalThis.fetch, resolver: async () => ['93.184.216.34'] },
    })
    const bot = new Bot({ provider })
    const done = new Promise<string>((resolve) => {
      bot.use(flow('quiero comprar').ask('¿Qué talla?', 'size').do((_ctx, c) => { resolve(String(c.state.size)) }).say('Anotado'))
    })
    await bot.start()
    const hic = JSON.stringify(fx.highIntentComment)
    expect(provider.ingest(hic, sign(hic))).toBe(200)
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    const answer = JSON.stringify(fx.envelope('im_receive_msg', {
      ...(JSON.parse(String((fx.dmText as { content: string }).content)) as Record<string, unknown>),
      message_id: 'msg-answer',
      text: { body: 'M' },
    }))
    expect(provider.ingest(answer, sign(answer))).toBe(200)
    expect(await done).toBe('M')
    await vi.waitFor(() => expect(bodies).toHaveLength(2))
    await bot.stop()

    expect(bodies[0]).toMatchObject({ direct_reply: { comment_reply: { comment_id: '7247303576418566777' } }, text: { body: '¿Qué talla?' } })
    expect(bodies[1]).toMatchObject({ recipient_type: 'CONVERSATION', recipient: fx.CONVERSATION_ID, text: { body: 'Anotado' } })
  })
})
