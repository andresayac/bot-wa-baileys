import { describe, expect, it } from 'vitest'
import { Bot } from '@bot-wa/core'
import { moderationPlugin } from '../src/index.js'
import { compileTerms, firstMatch } from '../src/words.js'
import { AdminMockProvider, flush, groupMsg, startBot } from './helpers.js'

describe('moderation — groupMode interaction', () => {
  it('warns at install when the bot groupMode hides group messages from moderation', async () => {
    const warnings: string[] = []
    const logger = {
      debug() {}, info() {}, error() {},
      warn(_obj: unknown, msg?: string) { if (typeof msg === 'string') warnings.push(msg) },
      child() { return logger },
    }
    const provider = new AdminMockProvider()
    const bot = new Bot({ provider, groupMode: 'mentions', logger })
    await bot.start()
    bot.plug(moderationPlugin({ provider, wordFilter: { banned: ['estafa'] } }))
    expect(warnings.some((w) => w.includes('groupMode'))).toBe(true)
    await bot.stop()
  })

  it('does not warn with groupMode all', async () => {
    const warnings: string[] = []
    const logger = {
      debug() {}, info() {}, error() {},
      warn(_obj: unknown, msg?: string) { if (typeof msg === 'string') warnings.push(msg) },
      child() { return logger },
    }
    const provider = new AdminMockProvider()
    const bot = new Bot({ provider, groupMode: 'all', logger })
    await bot.start()
    bot.plug(moderationPlugin({ provider, wordFilter: { banned: ['estafa'] } }))
    expect(warnings.some((w) => w.includes('groupMode'))).toBe(false)
    await bot.stop()
  })
})

describe('moderation — allowInvites is matched exactly', () => {
  it('an allowed invite code inside another URL does not whitelist it', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, linkFilter: { action: 'delete', allLinks: true, allowInvites: ['MYCODE123'] } }))
    groupMsg(provider, 'mira https://evil.example/phish?MYCODE123')
    groupMsg(provider, 'mira https://evil.example/x?u=chat.whatsapp.com/MYCODE123')
    await flush()
    expect(provider.deleted).toHaveLength(2)
    await bot.stop()
  })

  it('a foreign invite whose code contains the allowed code is still blocked', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, linkFilter: { action: 'delete', allowInvites: ['MYCODE123'] } }))
    groupMsg(provider, 'https://chat.whatsapp.com/MYCODE123XYZ')
    await flush()
    expect(provider.deleted).toHaveLength(1)
    await bot.stop()
  })

  it('an allowInvites entry given as a full URL also allows the invite typed without scheme', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({
      provider,
      linkFilter: { action: 'delete', allLinks: true, allowInvites: ['https://chat.whatsapp.com/OURGROUP123'] },
    }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })
    groupMsg(provider, 'chat.whatsapp.com/OURGROUP123')
    groupMsg(provider, 'https://chat.whatsapp.com/OURGROUP123')
    await flush()
    expect(provider.deleted).toHaveLength(0)
    expect(seen).toHaveLength(2)
    await bot.stop()
  })
})

describe('moderation — ñ is a distinct letter', () => {
  it('banning "ano" does not match "año"; banning "coño" matches in any case', () => {
    expect(firstMatch(compileTerms(['ano']), 'Feliz año nuevo')).toBeUndefined()
    expect(firstMatch(compileTerms(['ano']), 'Feliz AÑO nuevo')).toBeUndefined()
    expect(firstMatch(compileTerms(['coño']), 'qué COÑO')?.label).toBe('coño')
    expect(firstMatch(compileTerms(['coño']), 'que cono')).toBeUndefined()
    // Decomposed input (n + combining tilde) folds the same as precomposed ñ.
    expect(firstMatch(compileTerms(['ano']), 'feliz an\u0303o')).toBeUndefined()
    expect(firstMatch(compileTerms(['estafa']), 'ESTAFÁ')?.label).toBe('estafa')
  })
})
