import { describe, expect, it } from 'vitest'
import type { InboundEvent } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import { moderationPlugin, type ModerationReport } from '../src/index.js'
import { AdminMockProvider, flush, groupMsg, startBot, textsTo } from './helpers.js'

function collect(bot: { on(event: string, fn: (r: ModerationReport) => void): unknown }): ModerationReport[] {
  const reports: ModerationReport[] = []
  bot.on('moderation', (r) => reports.push(r))
  return reports
}

function emitGroupEvent(provider: MockProvider, event: InboundEvent): void {
  provider['emitEvent'](event)
}

describe('moderationPlugin — anti-spam', () => {
  it('warns (with mention + quote) once a sender exceeds maxMessages in windowMs, and drops that message', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    let t = 0
    bot.plug(moderationPlugin({ provider, now: () => t, antiSpam: { maxMessages: 3, windowMs: 1000, action: 'warn' } }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })
    const reports = collect(bot)

    for (const body of ['a', 'b', 'c', 'd']) {
      t += 100
      groupMsg(provider, body)
      await flush()
    }
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ rule: 'antiSpam', chatId: 'g1', senderId: 'u1', warnings: 1 })
    expect(reports[0].results).toEqual([{ action: 'warn', status: 'done' }])
    const warn = provider.outbox.at(-1)!
    expect(warn.chatId).toBe('g1')
    expect(warn.options?.mentions).toEqual(['u1'])
    expect(warn.options?.quoted?.chatId).toBe('g1')
    expect(textsTo(provider, 'g1')[0]).toBe('⚠️ Ana: no envíes tantos mensajes seguidos. Advertencia 1/3.')

    // The window restarts after a violation, and other senders are counted separately.
    t += 100
    groupMsg(provider, 'e')
    groupMsg(provider, 'otro', 'u2')
    await flush()
    expect(seen).toEqual(['a', 'b', 'c', 'e', 'otro'])
    await bot.stop()
  })

  it('messages outside the window do not count', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    let t = 0
    bot.plug(moderationPlugin({ provider, now: () => t, antiSpam: { maxMessages: 2, windowMs: 1000 } }))
    const reports = collect(bot)
    for (let i = 0; i < 6; i++) {
      t += 600
      groupMsg(provider, `m${i}`)
      await flush()
    }
    expect(reports).toHaveLength(0)
    await bot.stop()
  })
})

describe('moderationPlugin — word filter', () => {
  it('deletes a message with a banned word through provider.deleteMessage and stops routing it', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    const onViolation: ModerationReport[] = []
    bot.plug(moderationPlugin({
      provider,
      wordFilter: { banned: ['estafa', /bit\.ly\/\w+/i], action: 'delete' },
      onViolation: (r) => { onViolation.push(r) },
    }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })

    groupMsg(provider, 'hola a todos')
    groupMsg(provider, 'esto es una Estafa total')
    groupMsg(provider, 'mira bit.ly/xyz')
    await flush()

    expect(seen).toEqual(['hola a todos'])
    expect(provider.deleted).toHaveLength(2)
    expect(onViolation.map((r) => [r.rule, r.detail])).toEqual([
      ['wordFilter', 'estafa'],
      ['wordFilter', '/bit\\.ly\\/\\w+/i'],
    ])
    expect(onViolation[0].results).toEqual([{ action: 'delete', status: 'done' }])
    await bot.stop()
  })

  it('without a provider handle, delete goes through ctx.delete() and reports "attempted"', async () => {
    const provider = new MockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ wordFilter: { banned: ['spam'] } }))
    const reports = collect(bot)
    groupMsg(provider, 'spam spam')
    await flush()
    expect(reports[0].results).toEqual([{ action: 'delete', status: 'attempted' }])
    await bot.stop()
  })

  it('reports "unsupported" when the provider has no deleteMessage', async () => {
    const provider = new MockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, wordFilter: { banned: ['spam'], action: 'delete' } }))
    const reports = collect(bot)
    groupMsg(provider, 'spam')
    await flush()
    expect(reports[0].results).toEqual([{ action: 'delete', status: 'unsupported' }])
    await bot.stop()
  })
})

describe('moderationPlugin — link filter', () => {
  it('autoKickOnLink deletes and kicks on a foreign invite; own invites and plain links pass', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, autoKickOnLink: true }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })
    const reports = collect(bot)

    groupMsg(provider, 'mira https://example.com')
    groupMsg(provider, 'únanse a chat.whatsapp.com/FOREIGN12345')
    await flush()

    expect(seen).toEqual(['mira https://example.com'])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ rule: 'linkFilter', detail: 'chat.whatsapp.com/FOREIGN12345' })
    expect(reports[0].results).toEqual([
      { action: 'delete', status: 'done' },
      { action: 'kick', status: 'done' },
    ])
    expect(provider.kicked).toEqual([{ chatId: 'g1', userIds: ['u1'] }])
    await bot.stop()
  })

  it('allowInvites whitelists your own groups; allLinks + allowDomains filters every other link', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({
      provider,
      linkFilter: { action: 'delete', allowInvites: ['OURGROUP123'], allLinks: true, allowDomains: ['example.com'] },
    }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })

    groupMsg(provider, 'https://chat.whatsapp.com/OURGROUP123')
    groupMsg(provider, 'https://docs.example.com/guia')
    groupMsg(provider, 'https://evil.test/promo')
    await flush()
    expect(seen).toEqual(['https://chat.whatsapp.com/OURGROUP123', 'https://docs.example.com/guia'])
    expect(provider.deleted).toHaveLength(1)
    await bot.stop()
  })
})

describe('moderationPlugin — kick degradation and mute', () => {
  it('an unsupported kick is reported and degrades to mute; the muted user is ignored until it expires', async () => {
    const provider = new MockProvider() // no deleteMessage, no groups namespace
    const bot = await startBot(provider)
    let t = 0
    bot.plug(moderationPlugin({ provider, now: () => t, muteMs: 60_000, wordFilter: { banned: ['estafa'], action: 'kick' } }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })
    const reports = collect(bot)

    groupMsg(provider, 'estafa')
    await flush()
    expect(reports[0].results).toEqual([
      { action: 'kick', status: 'unsupported' },
      { action: 'mute', status: 'done', fallbackFor: 'kick' },
    ])
    expect(bot.injectTools.moderation?.isMuted('g1', 'u1')).toBe(true)

    groupMsg(provider, 'hola?')
    await flush()
    expect(seen).toEqual([])

    t += 60_001
    groupMsg(provider, 'ya puedo')
    await flush()
    expect(seen).toEqual(['ya puedo'])
    await bot.stop()
  })

  it('kickFallback: "none" only reports the unsupported kick', async () => {
    const provider = new MockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, kickFallback: 'none', wordFilter: { banned: ['estafa'], action: 'kick' } }))
    const reports = collect(bot)
    groupMsg(provider, 'estafa')
    await flush()
    expect(reports[0].results).toEqual([{ action: 'kick', status: 'unsupported' }])
    expect(bot.injectTools.moderation?.isMuted('g1', 'u1')).toBe(false)
    await bot.stop()
  })

  it('deleteWhileMuted deletes what a muted user keeps sending', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, deleteWhileMuted: true }))
    bot.injectTools.moderation!.mute('g1', 'u1')
    groupMsg(provider, 'shh')
    await flush()
    expect(provider.deleted).toHaveLength(1)
    expect(bot.injectTools.moderation!.unmute('g1', 'u1')).toBe(true)
    await bot.stop()
  })
})

describe('moderationPlugin — warnings escalation', () => {
  it('the max-th warning escalates to the configured action and resets the count', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({
      provider,
      warnings: { max: 2, then: 'mute' },
      wordFilter: { banned: ['tonto'], action: 'warn' },
      messages: { warn: '{name} ({count}/{max}): {reason}', reasons: { wordFilter: 'sin insultos' } },
    }))
    const reports = collect(bot)
    const mod = bot.injectTools.moderation!

    groupMsg(provider, 'tonto')
    await flush()
    expect(mod.warnings('g1', 'u1')).toBe(1)
    groupMsg(provider, 'tonto otra vez')
    await flush()
    expect(reports[1].results).toEqual([
      { action: 'warn', status: 'done' },
      { action: 'mute', status: 'done' },
    ])
    expect(mod.warnings('g1', 'u1')).toBe(0)
    expect(mod.isMuted('g1', 'u1')).toBe(true)
    expect(textsTo(provider, 'g1')).toEqual(['Ana (1/2): sin insultos', 'Ana (2/2): sin insultos'])
    await bot.stop()
  })

  it('escalating to kick kicks through the provider and clears the user state', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, warnings: { max: 1, then: 'kick' }, wordFilter: { banned: ['tonto'], action: 'warn' } }))
    groupMsg(provider, 'tonto')
    await flush()
    expect(provider.kicked).toEqual([{ chatId: 'g1', userIds: ['u1'] }])
    await bot.stop()
  })
})

describe('moderationPlugin — admin bypass', () => {
  it('config admins and isAdmin() skip every rule', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({
      provider,
      admins: ['boss'],
      isAdmin: (_chat, user) => user === 'mod',
      wordFilter: { banned: ['estafa'] },
    }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(`${ctx.sender}:${ctx.body}`) })
    groupMsg(provider, 'estafa', 'boss')
    groupMsg(provider, 'estafa', 'mod')
    groupMsg(provider, 'estafa', 'u1')
    await flush()
    expect(seen).toEqual(['boss:estafa', 'mod:estafa'])
    await bot.stop()
  })

  it('provider groups.getAdmins is cached and invalidated by promote/demote events', async () => {
    const provider = new AdminMockProvider()
    provider.admins.g1 = ['owner']
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, wordFilter: { banned: ['estafa'] } }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(`${ctx.sender}:${ctx.body}`) })

    groupMsg(provider, 'estafa', 'owner')
    groupMsg(provider, 'estafa', 'owner')
    groupMsg(provider, 'estafa', 'u1')
    await flush()
    expect(seen).toEqual(['owner:estafa', 'owner:estafa'])
    expect(provider.adminLookups).toBe(1)

    provider.admins.g1 = ['owner', 'u1']
    emitGroupEvent(provider, { kind: 'group', event: { chatId: 'g1', action: 'promote', participants: ['u1'] } })
    await flush()
    groupMsg(provider, 'estafa', 'u1')
    await flush()
    expect(seen).toEqual(['owner:estafa', 'owner:estafa', 'u1:estafa'])
    expect(provider.adminLookups).toBe(2)
    await bot.stop()
  })

  it('adminBypass: false moderates admins too', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, admins: ['boss'], adminBypass: false, wordFilter: { banned: ['estafa'] } }))
    const reports = collect(bot)
    groupMsg(provider, 'estafa', 'boss')
    await flush()
    expect(reports).toHaveLength(1)
    await bot.stop()
  })
})

describe('moderationPlugin — scope and per-group config', () => {
  it('moderates only groups by default; applyTo "all" includes DMs', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, wordFilter: { banned: ['estafa'] } }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })
    provider.incoming('estafa en dm', { from: 'dm1' })
    await flush()
    expect(seen).toEqual(['estafa en dm'])
    await bot.stop()

    const p2 = new AdminMockProvider()
    const bot2 = await startBot(p2)
    bot2.plug(moderationPlugin({ provider: p2, applyTo: 'all', wordFilter: { banned: ['estafa'] } }))
    const seen2: string[] = []
    bot2.onMessage((ctx) => { seen2.push(ctx.body) })
    p2.incoming('estafa en dm', { from: 'dm1' })
    await flush()
    expect(seen2).toEqual([])
    await bot2.stop()
  })

  it('per-group overrides merge over the global rules; false disables a group; setGroupRules changes it at runtime', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({
      provider,
      wordFilter: { banned: ['estafa'] },
      groups: { staff: false, ventas: { wordFilter: { banned: ['gratis'] } } },
    }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(`${ctx.from}:${ctx.body}`) })

    groupMsg(provider, 'estafa', 'u1', 'staff')
    groupMsg(provider, 'estafa', 'u1', 'ventas')
    groupMsg(provider, 'gratis', 'u1', 'ventas')
    groupMsg(provider, 'gratis', 'u1', 'g1')
    await flush()
    expect(seen).toEqual(['staff:estafa', 'ventas:estafa', 'g1:gratis'])

    bot.injectTools.moderation!.setGroupRules('staff', { wordFilter: { banned: ['estafa'] } })
    groupMsg(provider, 'estafa', 'u1', 'staff')
    await flush()
    expect(seen).toHaveLength(3)
    await bot.stop()
  })

  it('enabled: false turns the plugin off; unplugging removes the hook', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    const unplug = bot.plug(moderationPlugin({ provider, wordFilter: { banned: ['estafa'] } }))
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })
    groupMsg(provider, 'estafa')
    await flush()
    expect(seen).toEqual([])
    unplug()
    groupMsg(provider, 'estafa')
    await flush()
    expect(seen).toEqual(['estafa'])
    await bot.stop()

    const p2 = new AdminMockProvider()
    const bot2 = await startBot(p2)
    bot2.plug(moderationPlugin({ provider: p2, enabled: false, wordFilter: { banned: ['estafa'] } }))
    const seen2: string[] = []
    bot2.onMessage((ctx) => { seen2.push(ctx.body) })
    groupMsg(p2, 'estafa')
    await flush()
    expect(seen2).toEqual(['estafa'])
    await bot2.stop()
  })

  it('a removed participant loses its warnings and mute', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider, wordFilter: { banned: ['tonto'], action: 'warn' } }))
    const mod = bot.injectTools.moderation!
    groupMsg(provider, 'tonto')
    await flush()
    mod.mute('g1', 'u1')
    expect(mod.warnings('g1', 'u1')).toBe(1)
    emitGroupEvent(provider, { kind: 'group', event: { chatId: 'g1', action: 'remove', participants: ['u1'] } })
    await flush()
    expect(mod.warnings('g1', 'u1')).toBe(0)
    expect(mod.isMuted('g1', 'u1')).toBe(false)
    await bot.stop()
  })

  it('controller.kick() reports provider support', async () => {
    const provider = new AdminMockProvider()
    const bot = await startBot(provider)
    bot.plug(moderationPlugin({ provider }))
    expect(await bot.injectTools.moderation!.kick('g1', 'u9')).toEqual({ action: 'kick', status: 'done' })
    provider.groups.removeParticipants = async () => { throw new Error('not admin') }
    const failed = await bot.injectTools.moderation!.kick('g1', 'u9')
    expect(failed.status).toBe('failed')
    await bot.stop()
  })
})
