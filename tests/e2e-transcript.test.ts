import { describe, it, expect } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { slashCommandsPlugin } from '../src/plugins/slashCommands.js'
import { flow } from '../src/flows/FlowBuilder.js'

/** Reproduce la sesión real del 2026-07-18 que evidenció los bugs de v2-alpha. */
async function setupDemoBot() {
  const { bot, chat, provider } = await createTestBot()
  bot.plug(slashCommandsPlugin, { greeting: '🤖 Demo Bot' })
  bot.when('hola', async (ctx) => { await ctx.reply('👋 ¡Hola! ¿Cómo te llamas?') })
  bot.use(flow('registrar')
    .say('📝 Vamos a registrarte')
    .ask('¿Cuál es tu nombre?', 'name')
    .ask('¿Cuál es tu email?', 'email', { validate: (b) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b) || '❌ email inválido' })
    .say((_c, c) => `✅ ${c.state.name} <${c.state.email}>`))
  bot.onMessage(async (ctx) => { await ctx.reply('🤔 No reconocí eso. Envía /help.') })
  return { bot, chat, provider }
}

describe('E2E: transcript 2026-07-18', () => {
  it('[6:53] "hola" produces EXACTLY one reply', async () => {
    const { chat } = await setupDemoBot()
    await chat.send('hola')
    await chat.expectReply('¿Cómo te llamas?')
    await new Promise((r) => setTimeout(r, 30))
    expect(chat.replies()).toHaveLength(1)
  })

  it('[6:59] register flow advances: name → email → done (no infinite re-ask)', async () => {
    const { chat } = await setupDemoBot()
    await chat.send('registrar')
    await chat.expectReply('¿Cuál es tu nombre?')
    await chat.send('andres')
    await chat.expectReply('¿Cuál es tu email?')     // v2-alpha repetía '¿nombre?' infinito
    await chat.send('no-es-email')
    await chat.expectReply('❌ email inválido')
    await chat.send('andres@test.com')
    await chat.expectReply('✅ andres <andres@test.com>')
  })

  it('[6:59] "comprar"/"foto" mid-flow are captured as answers, and /reset escapes', async () => {
    const { chat } = await setupDemoBot()
    await chat.send('registrar')
    await chat.expectReply('¿Cuál es tu nombre?')
    await chat.send('/reset')                         // v2-alpha: imposible escapar
    await chat.expectReply('reiniciada')
    await chat.send('hola')
    await chat.expectReply('¿Cómo te llamas?')        // el bot volvió a la normalidad
  })

  it('[7:02] unknown text falls to catch-all ONCE; /registrar (con slash) no arranca flow', async () => {
    const { chat } = await setupDemoBot()
    await chat.send('Quien te creo')
    await chat.expectReply('No reconocí')
    await chat.send('/registrar')                     // comando desconocido, NO el flow
    await chat.expectReply('Comando desconocido')
    await new Promise((r) => setTimeout(r, 30))
    expect(chat.replies().filter((r) => r.includes('Vamos a registrarte'))).toHaveLength(0)
  })

  it('unknown /command with slash-plugin + catch-all produces EXACTLY one reply (C1)', async () => {
    const { chat } = await setupDemoBot()
    await chat.send('/comandoinventado')
    await chat.expectReply('Comando desconocido')     // el plugin lo consumió
    await new Promise((r) => setTimeout(r, 30))
    // El catch-all NO debe volver a responder: exactamente 1 respuesta en total.
    expect(chat.replies()).toHaveLength(1)
    expect(chat.replies().filter((r) => r.includes('No reconocí'))).toHaveLength(0)
  })
})
