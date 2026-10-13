/**
 * No-false-positive guard: the reference example bot
 * (packages/baileys-provider/examples/bot.ts) and every flow recipe in docs/
 * (guide + examples, EN/ES mirror the same code) must lint without a single
 * warning or error. The only diagnostics allowed are the advisory
 * `missing-timeout` infos — those examples genuinely rely on the built-in
 * 5-minute wait because they configure no timeout.
 */
import { describe, it, expect } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import type { MessageContext } from '../src/core/types.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { slashCommandsPlugin } from '../src/plugins/slashCommands.js'
import { ConversationTimeout, ConversationCancelled } from '../src/conversations/errors.js'
import { describeFlows } from '../src/flows/describe.js'

type Cfg = Partial<ConstructorParameters<typeof Bot>[0]>
const mkBot = (cfg: Cfg = {}) => new Bot({ provider: new MockProvider(), ...cfg })
const str = (v: unknown) => String(v)

/** packages/baileys-provider/examples/bot.ts, with the transport swapped for MockProvider. */
function referenceExampleBot(): Bot {
  const bot = mkBot({ debug: false })
  bot.plug(slashCommandsPlugin, { greeting: ['🤖 *Demo Bot*', '', 'Comandos:', '  /help'].join('\n') })
  bot.when('hola', async (ctx: MessageContext) => { await ctx.reply('👋 ¡Hola!') })
  bot.when(['adios', 'chao', 'bye'], async (ctx: MessageContext) => { await ctx.reply('👋 ¡Hasta luego!') })
  bot.when(/\d{4,}/, async (ctx: MessageContext) => { await ctx.reply(`🔢 ${ctx.body}`) })
  bot.onImage(async (ctx: MessageContext) => { await ctx.reply('📸 ¡Buena foto!') })

  const registerFlow = flow('registrar')
    .say('📝 *Vamos a registrarte*')
    .ask('¿Cuál es tu nombre?', 'name')
    .ask('¿Cuál es tu email?', 'email', {
      validate: (body) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body) ? true : '❌ Ese email no parece válido. Intenta de nuevo.',
    })
    .choose('¿Qué te interesa recibir?', {
      ofertas: { label: 'Ofertas y promociones 🏷️', then: (_ctx, c) => { c.state.interest = 'ofertas' } },
      soporte: { label: 'Novedades de soporte 🛠️', then: (_ctx, c) => { c.state.interest = 'soporte' } },
      nada: { label: 'Nada por ahora 🙅', then: (_ctx, c) => { c.state.interest = 'nada' } },
    })
    .say((_ctx, c) => ['✅ *Registro completo*', '', `👤 Nombre: ${str(c.state.name)}`].join('\n'))
  bot.use(registerFlow)

  bot.conversation('soporte', async (c, ctx) => {
    await ctx.reply('🛠️ Describe tu problema en una frase (tienes 2 minutos):')
    const problema = await c.waitText({ timeout: '2m', retries: 2 })
    const prioridad = await c.choose('¿Qué tan urgente es?', { alta: 'Urgente 🔴', media: 'Puede esperar 🟡', baja: 'No corre prisa 🟢' })
    await ctx.reply(`🎫 Ticket registrado ("${problema}", prioridad ${prioridad}).`)
  })

  bot.before('message', async (_ctx, next) => { await next() })
  bot.after('message', async () => {})
  bot.provide('db', { visits: new Map<string, number>() })
  bot.when('visitas', async (ctx: MessageContext) => { await ctx.reply('📊') })
  bot.every('5 minutes', () => {})
  bot.onMessage(async (ctx: MessageContext) => { await ctx.reply('🤔 No reconocí ese mensaje.') })
  return bot
}

const catalog: Record<string, string> = { electronics: '📱', clothing: '👕', home: '🏠' }
const validEmail = (body: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body) ? true : '❌ Invalid email')

/** Every flow recipe in docs/, one bot per snippet (alternatives are never registered together). */
const docsExamples: Array<[string, () => Bot]> = [
  ['guide/flows: basic flow', () => {
    const bot = mkBot()
    bot.use(flow('hola').ask('👋 Hello! What is your name?', 'name').say((_ctx, c) => `Nice to meet you, ${str(c.state.name)}!`))
    return bot
  }],
  ['guide/flows: ask with validate/retries/timeout', () => {
    const bot = mkBot()
    bot.use(flow('x').ask('Email?', 'email', { validate: validEmail, retries: 2, timeout: '2m' }))
    return bot
  }],
  ['guide/flows: do + media', () => {
    const bot = mkBot()
    bot.use(flow('x').do((_ctx, c) => { c.state.registeredAt = Date.now() }))
    bot.use(flow('y').media('https://picsum.photos/400/300', 'caption'))
    return bot
  }],
  ['guide/flows + MIGRATION: confirmar choose', () => {
    const bot = mkBot()
    bot.use(flow('confirmar')
      .choose('Confirm your order?', { si: 'Yes', no: 'No' })
      .say((_ctx, c) => (c.state.choice === 'si' ? '✅ Confirmed' : '❌ Cancelled')))
    return bot
  }],
  ['MIGRATION: confirmar choose (es labels)', () => {
    const bot = mkBot()
    bot.use(flow('confirmar')
      .choose('¿Confirmas tu pedido?', { si: 'Sí', no: 'No' })
      .say((_ctx, c) => (c.state.choice === 'si' ? '✅ Confirmado' : '❌ Cancelado')))
    return bot
  }],
  ['MIGRATION: confirmar as async conversation', () => {
    const bot = mkBot()
    bot.conversation('confirmar', async (c, ctx) => {
      const respuesta = await c.choose('¿Confirmas tu pedido?', { si: 'Sí', no: 'No' })
      await ctx.reply(respuesta === 'si' ? '✅ Confirmado' : '❌ Cancelado')
    })
    return bot
  }],
  ['guide/flows: choose with then actions', () => {
    const bot = mkBot()
    bot.use(flow('menu')
      .choose('What are you interested in?', {
        ofertas: { label: 'Offers 🏷️', then: (_ctx, c) => { c.state.interest = 'ofertas' } },
        soporte: { label: 'Support 🛠️', then: (_ctx, c) => { c.state.interest = 'soporte' } },
      })
      .say((_ctx, c) => `Got it: ${str(c.state.interest)}`))
    return bot
  }],
  ['guide/flows: timeout', () => {
    const bot = mkBot({ conversation: { timeoutMessage: '⏰ Session expired due to inactivity.' } })
    bot.use(flow('soporte').timeout('60s').ask('Describe your issue', 'issue'))
    return bot
  }],
  ['guide/flows: goto', () => {
    const bot = mkBot()
    bot.use(flow('a').say('Redirecting you...').goto('b'))
    bot.use(flow('b').say('Welcome to b'))
    return bot
  }],
  ['guide/flows: persistent with storeConfig.file', () => {
    const bot = mkBot({ storeConfig: { file: './store.json' } })
    bot.use(flow('registrar').persistent().ask('Name?', 'name').say('Done'))
    return bot
  }],
  ['guide/flows: scope', () => {
    const bot = mkBot()
    bot.use(flow('soporte').scope('dm').ask('Describe your issue', 'issue'))
    return bot
  }],
  ['guide/flows: c.state', () => {
    const bot = mkBot()
    bot.use(flow('x')
      .ask('Name?', 'name')
      .do((_ctx, c) => { c.state.name = str(c.state.name).trim() })
      .say((_ctx, c) => `Hi ${str(c.state.name)}`))
    return bot
  }],
  ['guide/flows + first-bot + concepts: registration', () => {
    const bot = mkBot()
    bot.plug(slashCommandsPlugin, { greeting: '🤖 Hi! I am a bot. Send /help to see my commands.' })
    bot.when('hola', async (ctx) => { await ctx.reply('👋 Hello!') })
    bot.when('info', async (ctx) => { await ctx.reply('ℹ️ I am a bot') })
    bot.when('photo', async (ctx) => { await ctx.photo('https://picsum.photos/400/300', '📸 Here is a photo') })
    bot.when('sticker', async (ctx) => { await ctx.sticker('https://picsum.photos/512/512', { pack: 'My Bot', author: 'me' }) })
    bot.use(flow('registrar')
      .say('📝 *Let us register you*')
      .ask('What is your name?', 'name')
      .ask('What is your email?', 'email', { validate: validEmail })
      .say((_ctx, c) => `✅ Registration complete!\n👤 ${str(c.state.name)}\n📧 ${str(c.state.email)}`))
    bot.onMessage(async (ctx) => { await ctx.reply('🤔 I did not recognize that.') })
    return bot
  }],
  ['guide/concepts: triggers + flow', () => {
    const bot = mkBot()
    const handler = async () => {}
    bot.when('hola', handler)
    bot.when(['bye', 'goodbye'], handler)
    bot.when(/\d{4,}/, handler)
    bot.when({ pattern: 'factura', match: 'contains' }, handler)
    bot.use(flow('registrar').ask('Name?', 'name').say((_ctx, c) => `Hi ${str(c.state.name)}`))
    return bot
  }],
  ['examples/registration-flow (+ es)', () => {
    const bot = mkBot()
    bot.use(flow('register')
      .say('📝 *Let us register you*')
      .ask('What is your name?', 'name')
      .ask('What is your email?', 'email', { validate: validEmail })
      .say((_ctx, c) => ['✅ *Registration complete!*', '', `👤 Name: ${str(c.state.name)}`].join('\n')))
    return bot
  }],
  ['examples/registration-flow: save to a database (+ es)', () => {
    const bot = mkBot()
    bot.provide('db', { users: new Map<string, unknown>(), async save() {} })
    bot.use(flow('register')
      .ask('Name?', 'name')
      .ask('Email?', 'email', { validate: (body) => (body.includes('@') ? true : '❌ Invalid email') })
      .do(async (ctx, c) => {
        // The docs snippet reads ctx.tools directly; .do() is typed with RuntimeMessage, so cast here.
        const { db } = (ctx as unknown as MessageContext).tools as { db: { save(jid: string, data: unknown): Promise<void> } }
        await db.save(ctx.from, { name: c.state.name, email: c.state.email })
      })
      .say('✅ Registered!'))
    return bot
  }],
  ['examples/shopping-flow (+ es)', () => {
    const bot = mkBot()
    bot.use(flow('buy')
      .say('🛒 *What do you want to buy?*')
      .choose('Write the option number', { electronics: 'Electronics 📱', clothing: 'Clothing 👕', home: 'Home 🏠' }, 'category')
      .say((_ctx, c) => catalog[str(c.state.category)])
      .say('✅ Thanks for your interest! Anything else?'))
    return bot
  }],
  ['examples/shopping-flow: then sub-steps (+ es)', () => {
    const bot = mkBot()
    bot.use(flow('buy')
      .say('🛒 *What do you want to buy?*')
      .choose('Write the option number', {
        electronics: { label: 'Electronics 📱', then: (_ctx, c) => { c.state.summary = '📱 iPhone 15 — $999' } },
        clothing: { label: 'Clothing 👕', then: (_ctx, c) => { c.state.summary = '👕 Shirt — $25' } },
        home: { label: 'Home 🏠', then: (_ctx, c) => { c.state.summary = '🏠 Lamp — $35' } },
      })
      .say((_ctx, c) => `${str(c.state.summary)}\n\n✅ Thanks for your interest!`))
    return bot
  }],
  ['examples/shopping-flow: whole-flow timeout (+ es)', () => {
    const bot = mkBot({ conversation: { timeoutMessage: '⏰ Session expired due to inactivity.' } })
    bot.use(flow('buy')
      .timeout('2m')
      .say('🛒 *What do you want to buy?*')
      .choose('Write the option number', { electronics: 'Electronics 📱', clothing: 'Clothing 👕', home: 'Home 🏠' }, 'category')
      .say((_ctx, c) => catalog[str(c.state.category)]))
    return bot
  }],
  ['examples/support-flow (+ es)', () => {
    const bot = mkBot({ conversation: { timeoutMessage: '⏰ Your support session expired due to inactivity.' } })
    bot.conversation('support', async (c, ctx) => {
      await ctx.reply('🛠️ *Technical support*')
      const issue = await c.waitText({ timeout: '2m', retries: 2 })
      const priority = await c.choose('How urgent is it?', { high: 'Urgent 🔴', medium: 'Can wait 🟡', low: 'No rush 🟢' })
      await ctx.reply(`🎫 Ticket registered ("${issue}", priority: ${priority}).`)
    })
    return bot
  }],
  ['examples/support-flow: explicit timeout handling (+ es)', () => {
    const bot = mkBot()
    bot.conversation('support', async (c, ctx) => {
      try {
        await ctx.reply('🛠️ Describe your issue (or send "cancel"):')
        const issue = await c.waitText({ timeout: '2m' })
        await ctx.reply(`✅ Registered: "${issue}".`)
      } catch (err) {
        if (err instanceof ConversationTimeout) await ctx.reply('⏰ Session expired due to inactivity.')
        else if (err instanceof ConversationCancelled) await ctx.reply('🛑 Session cancelled.')
        else throw err
      }
    })
    return bot
  }],
  ['guide/store + MIGRATION: persistent flow with a durable store', () => {
    // SQLiteStore lives in another package; a file-backed MemoryStore is the same contract here.
    const bot = mkBot({ store: new MemoryStore({ file: './data/bot.json' }) })
    bot.use(flow('registro')
      .persistent()
      .ask('¿Tu nombre?', 'name')
      .ask('¿Tu email?', 'email')
      .say((_ctx, c) => `✅ Registrado: ${str(c.state.name)}`))
    return bot
  }],
  ['MIGRATION: captured answer', () => {
    const bot = mkBot()
    bot.use(flow('registrar').ask('¿Cuál es tu nombre?', 'name').say((_ctx, c) => `Gracias, ${str(c.state.name)}`))
    return bot
  }],
  ['guide/ai: summary conversation', () => {
    const bot = mkBot()
    bot.conversation('summary', async (c, ctx) => {
      await ctx.reply('📋 Paste the text to summarize:')
      await c.waitText()
    })
    return bot
  }],
]

describe('lint — no false positives on shipped examples', () => {
  it('reference example bot: no warnings or errors, only the expected missing-timeout infos', () => {
    const bot = referenceExampleBot()
    expect(bot.lint({ minSeverity: 'warning' })).toEqual([])
    expect(bot.lint().map((d) => [d.code, d.severity, d.flow, d.path])).toEqual([
      ['missing-timeout', 'info', 'registrar', 'steps[1]'],
      ['missing-timeout', 'info', 'registrar', 'steps[2]'],
      ['missing-timeout', 'info', 'registrar', 'steps[3]'],
    ])
  })

  it('reference example bot describes both the flow and the async conversation', () => {
    const out = referenceExampleBot().describe()
    expect(out).toContain('  subgraph f0 ["flow: registrar"]')
    expect(out).toContain('  f1[["conversation: soporte<br/>▶ #34;soporte#34;"]]')
    // plain when() handlers are not flows and stay out of the diagram
    expect(out).not.toContain('visitas')
  })

  it.each(docsExamples)('%s: no warnings or errors', (_name, build) => {
    const bot = build()
    expect(bot.lint({ minSeverity: 'warning' })).toEqual([])
    expect(bot.lint().every((d) => d.code === 'missing-timeout')).toBe(true)
    expect(() => describeFlows(bot)).not.toThrow()
  })
})
