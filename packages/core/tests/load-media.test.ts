import { describe, expect, it } from 'vitest'
import { loadMediaOf, VOICE_NOTE, type MessageContext } from '../src/index.js'
import { createTestBot } from '../src/testing/index.js'

describe('loadMediaOf (public export)', () => {
  it('downloads the inbound media once and caches it on ctx.media', async () => {
    const { bot, chat, provider } = await createTestBot()
    let downloads = 0
    provider.downloadMedia = async () => { downloads++; return Buffer.from('OggS-bytes') }
    const seen: Array<{ first: number; same: boolean }> = []
    bot.before('message', async (ctx: MessageContext, next: () => Promise<void>) => {
      const a = await loadMediaOf(ctx)
      const b = await loadMediaOf(ctx)
      seen.push({ first: a?.buffer.length ?? -1, same: a === b })
      await next()
    })
    bot.when(VOICE_NOTE, (ctx) => ctx.reply(`media:${ctx.media?.buffer.toString()}`))

    await chat.send('', { type: 'voice' })
    await chat.expectReply('media:OggS-bytes')
    expect(downloads).toBe(1)
    expect(seen).toEqual([{ first: 10, same: true }])
    await bot.stop()
  })

  it('resolves undefined for a text message', async () => {
    const { bot, chat } = await createTestBot()
    bot.onMessage(async (ctx) => ctx.reply(`media:${String(await loadMediaOf(ctx))}`))
    await chat.send('hola')
    await chat.expectReply('media:undefined')
    await bot.stop()
  })
})
