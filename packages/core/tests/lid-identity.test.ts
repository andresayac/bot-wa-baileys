import { describe, it, expect } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { IdentityStore } from '../src/core/identity.js'

/**
 * Baileys 7 DM identity flip. The same partner arrives as a LID with the PN twin
 * in remoteJidAlt on one message, then as a bare LID (twin missing) on the next.
 * Before the IdentityStore fix, keyFor() flipped PN<->LID mid-conversation, the
 * active `ask` never got the answer, and the flow re-prompted / mis-captured.
 */
describe('LID/PN identity', () => {
  const registerFlow = () =>
    flow('registrar')
      .say('📝 Vamos a registrarte')
      .ask('¿Cuál es tu nombre?', 'name')
      .ask('¿Cuál es tu email?', 'email', {
        validate: (b) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b) || '❌ email inválido',
      })
      .say((_c, c) => `✅ ${c.state.name} <${c.state.email}>`)

  it('advances the flow when remoteJidAlt drops between messages', async () => {
    const { bot, provider } = await createTestBot()
    const LID = '111111111111111@lid'
    const PN = '573002782284@s.whatsapp.net'
    bot.use(registerFlow())
    bot.onMessage(async (ctx) => { await ctx.reply('🤔 No reconocí eso.') })

    const replies = () => provider.outbox.map((m) => String((m.content as { text?: string }).text ?? ''))

    provider.incoming('registrar', { from: LID, remoteJidAlt: PN }) // LID + twin -> PN
    await new Promise((r) => setTimeout(r, 10))
    provider.incoming('Andres', { from: LID })                      // bare LID -> canonicalised to PN
    await new Promise((r) => setTimeout(r, 10))
    provider.incoming('andres@test.com', { from: LID, remoteJidAlt: PN })
    await new Promise((r) => setTimeout(r, 10))

    const out = replies()
    expect(out.filter((r) => r.includes('¿Cuál es tu nombre?'))).toHaveLength(1) // no loop
    expect(out.some((r) => r.includes('¿Cuál es tu email?'))).toBe(true)          // advanced
    expect(out.some((r) => r.includes('✅ Andres <andres@test.com>'))).toBe(true) // completed correctly
    expect(out.some((r) => r.includes('No reconocí'))).toBe(false)                // never fell through
  })

  it('also works when the first message is PN-twinned and later ones are bare LID', async () => {
    const { bot, provider } = await createTestBot()
    const LID = '222222222222222@lid'
    const PN = '573009999999@s.whatsapp.net'
    bot.use(registerFlow())

    const replies = () => provider.outbox.map((m) => String((m.content as { text?: string }).text ?? ''))

    // First message carries both -> store learns the pair immediately.
    provider.incoming('registrar', { from: PN, remoteJidAlt: LID })
    await new Promise((r) => setTimeout(r, 10))
    provider.incoming('Ada', { from: LID })
    await new Promise((r) => setTimeout(r, 10))
    provider.incoming('ada@x.io', { from: LID })
    await new Promise((r) => setTimeout(r, 10))

    const out = replies()
    expect(out.filter((r) => r.includes('¿Cuál es tu nombre?'))).toHaveLength(1)
    expect(out.some((r) => r.includes('✅ Ada <ada@x.io>'))).toBe(true)
  })
})

describe('IdentityStore (unit)', () => {
  it('canonicalises a learned LID to its PN, both argument orders of observe()', () => {
    const s = new IdentityStore()
    s.observe('999@lid', '573001@s.whatsapp.net')
    expect(s.canonical('999@lid')).toBe('573001@s.whatsapp.net')

    const s2 = new IdentityStore()
    s2.observe('573002@s.whatsapp.net', '888@lid') // reversed arg order
    expect(s2.canonical('888@lid')).toBe('573002@s.whatsapp.net')
  })

  it('leaves unknown LIDs and plain PNs untouched', () => {
    const s = new IdentityStore()
    expect(s.canonical('unknown@lid')).toBe('unknown@lid')
    expect(s.canonical('573003@s.whatsapp.net')).toBe('573003@s.whatsapp.net')
  })

  it('ignores incomplete pairs', () => {
    const s = new IdentityStore()
    s.observe('123@lid', null)
    s.observe(null, '573004@s.whatsapp.net')
    expect(s.canonical('123@lid')).toBe('123@lid')
  })
})
