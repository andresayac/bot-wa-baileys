/**
 * 🚀 bot-wa-baileys v2 — Example bot
 * =================================
 *
 * Run with:
 *   pnpm run build
 *   node examples/bot.ts
 *
 * Or via ts-node:
 *   pnpm run example
 *
 * Then scan the QR code that appears in your terminal with your phone.
 */

import {
  Bot,
  flow,
  definePlugin,
  slashCommandsPlugin,
  type MessageContext,
} from '../lib/index.js'

// =============================================================================
// 1. CREATE THE BOT
// =============================================================================

const bot = new Bot({
  session: 'demo-bot',
  sessionsDir: './sessions',
  debug: false,
  qr: { terminal: true, small: true },
  // pairingCode: '+57300XXXXXXX',  // alternative to QR
  markOnlineOnConnect: false,        // don't steal phone push notifications
  ignoreNewsletters: true,
  ignoreBroadcasts: true,
})

// =============================================================================
// 2. CONNECTION EVENTS
// =============================================================================

bot.on('qr', (qr: string) => {
  console.log('\n📱 Scan this QR with your WhatsApp:\n')
})

bot.on('ready', () => {
  console.log('\n✅ Bot is ready and connected!\n')
})

bot.on('connection', (update) => {
  if (update.state === 'close') {
    console.log('⚠️ Connection closed. Reason:', update.lastDisconnect?.reason ?? 'unknown')
  }
})

bot.on('error', ({ error, ctx }) => {
  console.error('❌ Bot error:', error)
  if (ctx) console.error('   in context from:', ctx.from)
})

// =============================================================================
// 3. BUILT-IN SLASH COMMANDS (/start, /help, /reset, /id, /ping)
// =============================================================================

bot.plug(slashCommandsPlugin, {
  greeting: [
    '🤖 *Demo Bot* — built with @bot-wa/bot-wa-baileys v2',
    '',
    'Commands:',
    '  /start  — show this message',
    '  /reset  — cancel any active flow',
    '  /id     — show this chat ID',
    '  /ping   — health check',
    '',
    'Try sending:',
    '  • hola      → welcome flow',
    '  • registrar → registration flow with capture',
    '  • comprar   → shopping flow with branch',
    '  • soporte   → support flow with timeout',
    '  • info      → simple info reply',
    '  • foto      → send an image',
    '  • sticker   → send a sticker',
    '  • audio     → send a voice note',
    '  • ubicacion → send a location',
    '  • contacto → send a contact',
    '  • encuesta → send a poll',
    '  • visitas  → check your visit count (DI demo)',
  ].join('\n'),
})

// =============================================================================
// 4. SIMPLE DECLARATIVE HANDLERS (when)
// =============================================================================

// Text match
bot.when('hola', async (ctx: MessageContext) => {
  await ctx.reply('👋 ¡Hola! ¿Cómo te llamas?')
})

bot.when(['adios', 'chao', 'bye'], async (ctx: MessageContext) => {
  await ctx.reply('👋 ¡Hasta luego! Vuelve pronto.')
})

bot.when('info', async (ctx: MessageContext) => {
  await ctx.reply([
    'ℹ️ *Información del bot*',
    '',
    '• Versión: 2.0.0-alpha',
    '• Motor: Baileys 7.x',
    '• Sesión: ' + bot.getSessionName(),
    '',
    'Envía /help para ver todos los comandos.',
  ].join('\n'))
})

bot.when('ping', async (ctx: MessageContext) => {
  const start = Date.now()
  await ctx.reply('🏓 pong!')
  console.log(`Ping reply sent in ${Date.now() - start}ms`)
})

// Regex match — detect long numbers
bot.when(/\d{4,}/, async (ctx: MessageContext) => {
  await ctx.reply(`🔢 Detecté un número largo en tu mensaje: "${ctx.body}"`)
})

// =============================================================================
// 5. MEDIA HANDLERS
// =============================================================================

bot.when('foto', async (ctx: MessageContext) => {
  await ctx.photo(
    'https://picsum.photos/400/300',
    '📸 Aquí tienes una foto aleatoria'
  )
})

bot.when('sticker', async (ctx: MessageContext) => {
  await ctx.reply('🎨 Generando sticker...')
  try {
    await ctx.sticker('https://picsum.photos/512/512', {
      pack: 'Demo Bot',
      author: 'v2',
    })
  } catch (err) {
    await ctx.reply('❌ No pude generar el sticker: ' + (err as Error).message)
  }
})

bot.when('audio', async (ctx: MessageContext) => {
  await ctx.reply('🎵 Enviando audio...')
  await ctx.voice('https://www.soundjay.com/buttons/sounds/beep-01a.mp3')
})

bot.when('ubicacion', async (ctx: MessageContext) => {
  await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
})

bot.when('contacto', async (ctx: MessageContext) => {
  await ctx.contact('573001234567', 'Soporte Bot')
})

bot.when('encuesta', async (ctx: MessageContext) => {
  await ctx.poll('¿Qué te parece el bot?', ['👍 Excelente', '👌 Bueno', '👎 Regular'], false)
})

// =============================================================================
// 6. TYPED MEDIA HANDLERS (onImage, onAudio, etc.)
// =============================================================================

bot.onImage(async (ctx: MessageContext) => {
  await ctx.reply('📸 ¡Recibí tu imagen! Si quieres que la devuelva como sticker, envía "sticker".')
})

bot.onAudio(async (ctx: MessageContext) => {
  await ctx.reply('🎵 Recibí tu audio. No puedo transcribirlo todavía, ¡pero lo escuché! 👂')
})

bot.onSticker(async (ctx: MessageContext) => {
  await ctx.reply('🎨 ¡Sticker recibido!')
})

// =============================================================================
// 7. FLOWS (DSL v2)
// =============================================================================

// --- Flow: Registration with capture & validation ---
const registerFlow = flow('registrar')
  .say('📝 *Vamos a registrarte*')
  .say('¿Cuál es tu nombre?', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('name', ctx.body)
  })
  .say('¿Cuál es tu email?', { capture: true })
  .validate((body) => {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)
    return ok ? true : '❌ Email inválido. Intenta de nuevo.'
  })
  .do(async (ctx, { state }) => {
    state.set('email', ctx.body)
  })
  .say(async (ctx, { state }) => {
    const name = state.get('name') as string
    const email = state.get('email') as string
    return [
      '✅ *Registro completado!*',
      '',
      `👤 Nombre: ${name}`,
      `📧 Email: ${email}`,
    ].join('\n')
  })
  .end()

// --- Flow: Shopping with branch (choose) ---
const buyFlow = flow('comprar')
  .say([
    '🛒 *¿Qué quieres comprar?*',
    '',
    '1️⃣ Electrónica',
    '2️⃣ Ropa',
    '3️⃣ Hogar',
  ].join('\n'))
  .say('Escribe el número de opción', { capture: true })
  .choose({
    '1': flow()
      .say('📱 *Electrónica* — Tenemos:')
      .say(['• iPhone 15 — $999', '• Samsung S24 — $899', '• Xiaomi 14 — $599'].join('\n'))
      .end(),
    '2': flow()
      .say('👕 *Ropa* — Tenemos:')
      .say(['• Camiseta — $25', '• Jeans — $45', '• Chaqueta — $80'].join('\n'))
      .end(),
    '3': flow()
      .say('🏠 *Hogar* — Tenemos:')
      .say(['• Lámpara — $35', '• Alfombra — $60', '• Vaso — $12'].join('\n'))
      .end(),
  })
  .say('✅ ¡Gracias por tu interés! ¿Algo más en lo que pueda ayudarte?')
  .end()

// --- Flow: Support with timeout & fallback ---
const supportFlow = flow('soporte')
  .say('🛠️ *Soporte técnico*')
  .say('Describe tu problema en una frase', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('problem', ctx.body)
  })
  .say(async (ctx, { state }) => {
    return `✅ Tu problema "${state.get('problem')}" fue registrado. Te contactaremos pronto.`
  })
  .timeout(60_000, '⏰ Tu sesión de soporte caducó por inactividad.')
  .fallback(async (ctx) => {
    await ctx.reply('🤔 No entendí eso. Por favor describe tu problema o envía "cancelar".')
  })
  .end()

// Register all flows
bot.use([registerFlow, buyFlow, supportFlow])

// =============================================================================
// 8. HOOKS (before / after / error)
// =============================================================================

// Logging middleware — runs before every message
bot.before('message', async (ctx: MessageContext, next: () => Promise<void>) => {
  console.log(`📥 [${new Date().toISOString()}] ${ctx.from}: ${ctx.body}`)
  await next()
})

// Metrics — runs after every message
bot.after('message', async (ctx) => {
  // In a real bot you'd send this to Datadog, Prometheus, etc.
  console.log(`📤 Processed message from ${ctx.from} (type: ${ctx.type})`)
})

// Error handler
bot.onError('message', async (ctx, error) => {
  console.error('💥 Handler error:', error)
  if (ctx) await ctx.reply('😅 Ocurrió un error procesando tu mensaje. Intenta de nuevo.')
})

// =============================================================================
// 9. CUSTOM PLUGIN (example: rate limiter)
// =============================================================================

const rateLimitPlugin = definePlugin({
  name: 'rate-limit',
  version: '1.0.0',
  description: 'Simple rate limiter — max N messages per user per window',
  install(pluginCtx, config = {}) {
    const max = (config as any).max ?? 10
    const windowMs = (config as any).windowMs ?? 60_000
    const counts = new Map<string, { count: number; resetAt: number }>()

    pluginCtx.bot.before('message', async (ctx: MessageContext, next: () => Promise<void>) => {
      const now = Date.now()
      let entry = counts.get(ctx.from)
      if (!entry || entry.resetAt < now) {
        entry = { count: 0, resetAt: now + windowMs }
        counts.set(ctx.from, entry)
      }
      entry.count++
      if (entry.count > max) {
        await ctx.reply(`⏳ Estás enviando muchos mensajes. Espera ${Math.ceil((entry.resetAt - now) / 1000)}s.`)
        ctx.abort()
        return
      }
      await next()
    })

    pluginCtx.logger.info(`Rate limit plugin active: ${max} msg / ${windowMs / 1000}s`)
  },
})

bot.plug(rateLimitPlugin, { max: 20, windowMs: 60_000 })

// =============================================================================
// 10. DEPENDENCY INJECTION (provide)
// =============================================================================

// Inject a simple in-memory "database" available as ctx.tools.db
bot.provide('db', {
  users: new Map<string, { name: string; visits: number }>(),

  async touch(jid: string): Promise<{ name?: string; visits: number }> {
    const u = this.users.get(jid) ?? { name: undefined, visits: 0 }
    u.visits++
    this.users.set(jid, u)
    return u
  },
})

// Use the injected tool in a handler
bot.when('visitas', async (ctx: MessageContext) => {
  const db = (ctx.tools as any).db
  const user = await db.touch(ctx.from)
  await ctx.reply(`📊 Has visitado este bot ${user.visits} veces.`)
})

// =============================================================================
// 11. SCHEDULER (cron / every / delay)
// =============================================================================

// Every 30 seconds, log a heartbeat
bot.every('30 seconds', () => {
  console.log(`💓 Heartbeat — ${new Date().toISOString()}`)
})

// Cron: every weekday at 9:00 AM (uncomment to use)
// bot.schedule('0 9 * * 1-5', async () => {
//   await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 ¡Buenos días! El bot está activo.')
// })

// One-shot delay: 10 seconds after start
bot.delay('10 seconds', async () => {
  console.log('⏰ 10 seconds have passed since the bot started.')
})

// =============================================================================
// 12. CATCH-ALL (messages that don't match any handler)
// =============================================================================

bot.onMessage(async (ctx: MessageContext) => {
  await ctx.reply([
    '🤔 No reconocí ese comando.',
    '',
    'Envía /help para ver lo que puedo hacer.',
  ].join('\n'))
})

// =============================================================================
// 13. START
// =============================================================================

console.log('🚀 Starting bot-wa-baileys v2 demo...')
console.log('   Session:', bot.getSessionName())
console.log('   Waiting for QR...\n')

bot.start().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...')
  await bot.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await bot.stop()
  process.exit(0)
})



