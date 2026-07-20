/**
 * bot-wa-baileys v2 — ejemplo de referencia
 * ==========================================
 *
 * Cubre la API pública real de @bot-wa/core@2:
 *   - new Bot(config) + eventos de conexión (qr/ready/connection/error)
 *   - bot.plug(slashCommandsPlugin)
 *   - bot.when(trigger, handler) — texto / lista / regex
 *   - bot.use(flow(...)) — DSL declarativo (say/ask/choose)
 *   - bot.conversation(name, async (c, ctx) => {...}) — runtime async con control total
 *   - handlers de media tipada (onImage)
 *   - hooks (before/after), inyección de dependencias (provide) y scheduler
 *
 * Ejecutar:
 *   pnpm run build
 *   pnpm run example   # compila examples/ y corre node examples/bot.js
 *
 * Luego escanea el QR que aparece en la terminal con tu WhatsApp.
 */

import {
  Bot,
  flow,
  slashCommandsPlugin,
  type MessageContext,
} from '@bot-wa/core'
import { BaileysProvider } from '../lib/index.js'

// =============================================================================
// 1. CREAR EL BOT — inyectas el transporte (WhatsApp vía Baileys)
// =============================================================================

const SESSION = 'demo-bot'

const bot = new Bot({
  debug: false,
  provider: new BaileysProvider({
    session: SESSION,
    sessionsDir: './sessions',
    qr: { terminal: true, small: true },
    // pairingCode: '+57300XXXXXXX',   // alternativa al QR
    markOnlineOnConnect: false,        // no le "robes" las notificaciones push al teléfono
    ignoreNewsletters: true,
    ignoreBroadcasts: true,
  }),
})

// =============================================================================
// 2. EVENTOS DE CONEXIÓN
// =============================================================================

bot.on('qr', () => {
  console.log('\n📱 Escanea este QR con tu WhatsApp:\n')
})

bot.on('ready', () => {
  console.log('\n✅ Bot conectado y listo!\n')
})

bot.on('connection', (update) => {
  if (update.state === 'closed') {
    console.log('⚠️ Conexión cerrada. Motivo:', update.reason ?? update.detail?.message ?? 'desconocido')
  }
})

bot.on('error', ({ error, ctx }) => {
  console.error('❌ Error del bot:', error)
  if (ctx) console.error('   en el contexto de:', ctx.from)
})

// =============================================================================
// 3. COMANDOS SLASH INCLUIDOS (/start, /help, /reset, /id, /ping)
// =============================================================================

bot.plug(slashCommandsPlugin, {
  greeting: [
    '🤖 *Demo Bot* — hecho con @bot-wa/core v2',
    '',
    'Comandos:',
    '  /help  — este mensaje',
    '  /reset — cancelar la conversación activa',
    '  /id    — ID de este chat',
    '  /ping  — comprobar que el bot vive',
    '',
    'Prueba enviando:',
    '  • hola      → saludo simple',
    '  • registrar → flujo de registro (ask + validate + choose)',
    '  • soporte   → conversación async con espera y timeout',
    '  • visitas   → demo de inyección de dependencias',
  ].join('\n'),
})

// =============================================================================
// 4. HANDLERS DECLARATIVOS (when) — texto / lista / regex
// =============================================================================

bot.when('hola', async (ctx: MessageContext) => {
  await ctx.reply('👋 ¡Hola! Envía "registrar" o "soporte" para ver los flujos, o /help.')
})

bot.when(['adios', 'chao', 'bye'], async (ctx: MessageContext) => {
  await ctx.reply('👋 ¡Hasta luego! Vuelve pronto.')
})

// Regex — detecta números largos (por ejemplo, un número de pedido)
bot.when(/\d{4,}/, async (ctx: MessageContext) => {
  await ctx.reply(`🔢 Detecté un número largo en tu mensaje: "${ctx.body}"`)
})

// =============================================================================
// 5. HANDLER DE MEDIA TIPADA (onImage)
// =============================================================================

bot.onImage(async (ctx: MessageContext) => {
  await ctx.reply('📸 ¡Buena foto! Aún no la proceso, pero la recibí perfectamente.')
})

// =============================================================================
// 6. FLOW DECLARATIVO — say / ask / validate / choose
// =============================================================================

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
  .say((_ctx, c) => [
    '✅ *Registro completo*',
    '',
    `👤 Nombre: ${c.state.name}`,
    `📧 Email: ${c.state.email}`,
    `🎯 Interés: ${c.state.interest}`,
  ].join('\n'))

bot.use(registerFlow)

// =============================================================================
// 7. CONVERSACIÓN ASYNC — control total con las controls (c.ask/waitText/choose)
// =============================================================================

bot.conversation('soporte', async (c, ctx) => {
  await ctx.reply('🛠️ Describe tu problema en una frase (tienes 2 minutos):')
  const problema = await c.waitText({ timeout: '2m', retries: 2 })

  const prioridad = await c.choose('¿Qué tan urgente es?', {
    alta: 'Urgente 🔴',
    media: 'Puede esperar unas horas 🟡',
    baja: 'No corre prisa 🟢',
  })

  await ctx.reply(`🎫 Ticket registrado ("${problema}", prioridad ${prioridad}). Te contactaremos pronto.`)
})

// =============================================================================
// 8. HOOKS (middleware antes/después de cada mensaje)
// =============================================================================

bot.before('message', async (ctx, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${ctx.from}: ${ctx.body}`)
  await next()
})

bot.after('message', async (ctx) => {
  console.log(`📤 Procesado: ${ctx.from} (tipo: ${ctx.type})`)
})

// =============================================================================
// 9. INYECCIÓN DE DEPENDENCIAS (provide)
// =============================================================================

bot.provide('db', {
  visits: new Map<string, number>(),
  touch(jid: string): number {
    const n = (this.visits.get(jid) ?? 0) + 1
    this.visits.set(jid, n)
    return n
  },
})

bot.when('visitas', async (ctx: MessageContext) => {
  const db = ctx.tools as { db: { touch(jid: string): number } }
  await ctx.reply(`📊 Has visitado este bot ${db.db.touch(ctx.from)} veces.`)
})

// =============================================================================
// 10. SCHEDULER (cron / every / delay)
// =============================================================================

bot.every('5 minutes', () => {
  console.log(`💓 Heartbeat — ${new Date().toISOString()}`)
})

// bot.schedule('0 9 * * 1-5', async () => {
//   await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 ¡Buenos días! El bot está activo.')
// })

// =============================================================================
// 11. CATCH-ALL — mensajes que no matchearon ningún handler
// =============================================================================

bot.onMessage(async (ctx: MessageContext) => {
  await ctx.reply('🤔 No reconocí ese mensaje. Envía /help para ver las opciones.')
})

// =============================================================================
// 12. ARRANCAR EL BOT
// =============================================================================

console.log('🚀 Iniciando bot-wa-baileys v2 demo...')
console.log('   Sesión:', SESSION)
console.log('   Esperando QR...\n')

bot.start().catch((err) => {
  console.error('No se pudo iniciar el bot:', err)
  process.exit(1)
})

process.on('SIGINT', async () => {
  console.log('\n🛑 Deteniendo bot...')
  await bot.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await bot.stop()
  process.exit(0)
})
