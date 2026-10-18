import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { loadMediaOf, MediaTooLargeError, PayloadTooLargeError, VOICE_NOTE, type MediaRef, type MessageContext } from '../src/index.js'
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

  describe('options', () => {
    /** A bare context carrying the lazy-media handle the way buildContext stashes it. */
    function fakeCtx(ref: Partial<MediaRef>, download: () => Promise<Buffer | NodeJS.ReadableStream>) {
      let calls = 0
      const ctx = {
        __mediaRef: { kind: 'voice', token: null, ...ref },
        __downloadMedia: async () => { calls++; return download() },
      } as unknown as MessageContext
      return { ctx, calls: () => calls }
    }

    it('maxBytes refuses media whose declared size is over the cap without downloading it', async () => {
      const { ctx, calls } = fakeCtx({ size: 5000 }, async () => Buffer.alloc(5000))
      const err = await loadMediaOf(ctx, { maxBytes: 1000 }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MediaTooLargeError)
      expect(err).toBeInstanceOf(PayloadTooLargeError)
      expect(err).toMatchObject({ bytes: 5000, maxBytes: 1000 })
      expect(calls()).toBe(0)
      expect(ctx.media).toBeUndefined()
    })

    it('maxBytes stops reading a stream as soon as it goes over the cap', async () => {
      let pulled = 0
      const stream = new Readable({
        read() { pulled++; this.push(pulled > 100 ? null : Buffer.alloc(100, 1)) },
      })
      const { ctx } = fakeCtx({}, async () => stream)
      const err = await loadMediaOf(ctx, { maxBytes: 250 }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MediaTooLargeError)
      expect((err as MediaTooLargeError).bytes).toBeGreaterThan(250)
      expect(pulled).toBeLessThan(10)
      expect(stream.destroyed).toBe(true)
      expect(ctx.media).toBeUndefined()
    })

    it('maxBytes also applies to a downloaded Buffer and lets media under the cap through', async () => {
      const big = fakeCtx({}, async () => Buffer.alloc(300))
      await expect(loadMediaOf(big.ctx, { maxBytes: 250 })).rejects.toBeInstanceOf(MediaTooLargeError)
      const ok = fakeCtx({ mimetype: 'audio/ogg' }, async () => Buffer.alloc(200))
      expect((await loadMediaOf(ok.ctx, { maxBytes: 250 }))?.buffer.length).toBe(200)
    })

    it('download failures resolve undefined by default and reject with throwOnError', async () => {
      const boom = new Error('network down')
      const a = fakeCtx({}, async () => { throw boom })
      await expect(loadMediaOf(a.ctx)).resolves.toBeUndefined()
      const b = fakeCtx({}, async () => { throw boom })
      await expect(loadMediaOf(b.ctx, { throwOnError: true })).rejects.toBe(boom)
    })
  })
})
