/**
 * Use-case templates for `create-bot-wa` (FEATURES.md #39): games, support,
 * store, restaurant, clinic and ai-full. All of them run on WhatsApp via
 * Baileys (QR login) and follow the same `defineBot` factory pattern as the
 * transport templates, so `npm run dev` works out of the box.
 *
 * The generated JavaScript is written as raw blocks (`code\`...\``) to keep it
 * readable here; it must stay free of backticks, and `${...}` interpolates a TS value.
 */

import type { ProjectTemplate } from './templates.js'
import {
  ANTHROPIC_SDK_VERSION,
  BETTER_SQLITE3_VERSION,
  CORE_VERSION,
  GITIGNORE,
  TRANSPORT_VERSION,
  baileysMain,
  botModule,
  packageJson,
  readme,
} from './shared.js'

export type DomainTemplateName = 'games' | 'support' | 'store' | 'restaurant' | 'clinic' | 'ai-full'

/** Raw multi-line block → lines (leading/trailing blank line trimmed). */
function code(strings: TemplateStringsArray, ...values: string[]): string[] {
  return String.raw({ raw: strings.raw }, ...values).replace(/^\n/, '').replace(/\n$/, '').split('\n')
}

const BAILEYS_IMPORT = "import { BaileysProvider } from '@bot-wa/baileys'"
const BAILEYS_DEPS = { '@bot-wa/core': CORE_VERSION, '@bot-wa/baileys': TRANSPORT_VERSION }
const BAILEYS_README = [
  'On first start a **QR code** is printed — scan it with WhatsApp → Linked devices.',
  'Auth is cached under `sessions/` so later starts connect automatically.',
]

function envFile(session: string, extra: string[] = []): string {
  return ['# Session/auth folder name (sessions/<name>).', 'BOT_SESSION=' + session, ...extra, ''].join('\n')
}

/** Shared skeleton of a Baileys-based use-case template. */
function baileysTemplate(spec: {
  name: DomainTemplateName
  label: string
  description: string
  session: string
  readyLine: string
  coreImports?: string[]
  prelude: string[]
  config?: string
  handlers: string[]
  env?: string[]
  notes: string[]
}): ProjectTemplate {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    files: (name) => [
      { path: 'package.json', contents: packageJson(name, { ...BAILEYS_DEPS }) },
      {
        path: 'src/bot.js',
        contents: botModule({
          imports: [BAILEYS_IMPORT],
          coreImports: spec.coreImports,
          prelude: spec.prelude,
          config: spec.config,
          handlers: spec.handlers,
          main: baileysMain(spec.session, spec.readyLine),
        }),
      },
      { path: '.env.example', contents: envFile(spec.session, spec.env) },
      { path: '.gitignore', contents: GITIGNORE },
      { path: 'README.md', contents: readme(name, spec.label, spec.description, [...BAILEYS_README, '', ...spec.notes]) },
    ],
  }
}

/* games ------------------------------------------------------------------ */

const games = baileysTemplate({
  name: 'games',
  label: 'WhatsApp · Games',
  description: 'Games bot (guess the number, hangman, trivia, tic-tac-toe) with persistent per-user scores in ctx.user.',
  session: 'games-bot',
  readyLine: '✅ Games bot connected — send it "hola"',
  coreImports: ['userOf'],
  prelude: code`
const HELP = [
  '🎮 *Juegos*',
  '• *adivina* — adivina el número (1-100)',
  '• *ahorcado* — el ahorcado',
  '• *trivia* — 3 preguntas',
  '• *triqui* — tres en raya contra el bot',
  '• *ppt* — piedra, papel o tijera',
  '• *puntos* — tu puntaje',
].join('\n')

const WORDS = ['WHATSAPP', 'MENSAJE', 'TECLADO', 'PANTALLA', 'GUITARRA', 'MONTANA', 'CAFETERA']

const TRIVIA = [
  { q: '¿Cuál es el planeta más grande del sistema solar?', options: { 1: 'Marte', 2: 'Júpiter', 3: 'Saturno' }, answer: '2' },
  { q: '¿Cuántos lados tiene un hexágono?', options: { 1: 'Seis', 2: 'Ocho', 3: 'Cinco' }, answer: '1' },
  { q: '¿En qué continente está Colombia?', options: { 1: 'Europa', 2: 'África', 3: 'América' }, answer: '3' },
]

const RPS_OPTIONS = { 1: 'Piedra', 2: 'Papel', 3: 'Tijera' }
/** Which option each option beats: piedra > tijera, papel > piedra, tijera > papel. */
const RPS_BEATS = { 1: '3', 2: '1', 3: '2' }

/** Add points to the player's persistent score (ctx.user survives restarts with a durable store). */
async function addPoints(ctx, points) {
  const scores = userOf(ctx).ns('games')
  const total = ((await scores.get('total')) ?? 0) + points
  await scores.set('total', total)
  return total
}

/* Tic-tac-toe helpers: the board is an array of 9 cells ('X', 'O' or null). */
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
const winnerOf = (b) => {
  for (const [x, y, z] of LINES) if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x]
  return b.every(Boolean) ? 'draw' : null
}
const renderBoard = (b) => [0, 3, 6].map((r) => b.slice(r, r + 3).map((v, i) => v ?? String(r + i + 1)).join(' | ')).join('\n')
function botMove(b) {
  const free = b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0)
  // Win if possible, otherwise block the player, otherwise take the centre or any free cell.
  for (const mark of ['O', 'X']) {
    for (const i of free) {
      const next = [...b]
      next[i] = mark
      if (winnerOf(next) === mark) return i
    }
  }
  return free.includes(4) ? 4 : free[Math.floor(Math.random() * free.length)]
}
`,
  handlers: code`
const showHelp = async (ctx) => await ctx.reply('¡Hola! 👋\n' + HELP)
bot.when('hola', showHelp)
bot.when(['juegos', 'ayuda'], showHelp)

// Rock, paper, scissors: a one-question flow (DSL) — the bot's pick is made in the .say step.
bot.use(
  flow('ppt')
    .choose('✊✋✌️ ¿Piedra, papel o tijera?', RPS_OPTIONS, 'pick')
    .say(async (ctx, c) => {
      const mine = String(1 + Math.floor(Math.random() * 3))
      const outcome = c.state.pick === mine ? 'draw' : RPS_BEATS[c.state.pick] === mine ? 'win' : 'lose'
      const total = outcome === 'win' ? ' Total: ' + (await addPoints(ctx, 1)) + ' puntos.' : ''
      const verdict = outcome === 'win' ? '🎉 ¡Ganaste!' : outcome === 'draw' ? '🤝 Empate.' : '🤖 Gané yo.'
      return 'Yo elegí ' + RPS_OPTIONS[mine] + '. ' + verdict + total
    })
    .timeout('2m'),
)

bot.when('puntos', async (ctx) => {
  const total = (await ctx.user.ns('games').get('total')) ?? 0
  await ctx.reply('🏆 Tienes ' + total + ' puntos.')
})

// Guess the number: a free-form async conversation (loops are plain JS).
bot.conversation('adivina', async (c, ctx) => {
  const secret = 1 + Math.floor(Math.random() * 100)
  await ctx.reply('🔢 Pensé un número del 1 al 100. Tienes 7 intentos.')
  for (let attempt = 1; attempt <= 7; attempt++) {
    const text = await c.ask('Intento ' + attempt + '/7:', {
      timeout: '2m',
      validate: (t) => /^\d+$/.test(t.trim()) || 'Escribe solo un número.',
    })
    const guess = Number(text.trim())
    if (guess === secret) {
      const points = 8 - attempt
      const total = await addPoints(ctx, points)
      await ctx.reply('🎉 ¡Correcto! Era ' + secret + '. +' + points + ' puntos (total: ' + total + ').')
      return
    }
    await ctx.reply(guess < secret ? '⬆️ Más alto' : '⬇️ Más bajo')
  }
  await ctx.reply('😅 Se acabaron los intentos. Era ' + secret + '.')
}, { trigger: 'adivina' })

// Hangman.
bot.conversation('ahorcado', async (c, ctx) => {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)]
  const guessed = new Set()
  let lives = 6
  const board = () => word.split('').map((l) => (guessed.has(l) ? l : '_')).join(' ')
  while (lives > 0) {
    const answer = await c.ask('🪢 ' + board() + '\n❤️ ' + lives + ' vidas. Escribe una letra:', {
      timeout: '3m',
      validate: (t) => /^\p{L}$/u.test(t.trim()) || 'Escribe una sola letra.',
    })
    const letter = answer.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    if (guessed.has(letter)) {
      await ctx.reply('Ya probaste la ' + letter + '.')
      continue
    }
    guessed.add(letter)
    if (!word.includes(letter)) lives--
    if (word.split('').every((l) => guessed.has(l))) {
      const total = await addPoints(ctx, lives)
      await ctx.reply('🎉 ¡Ganaste! La palabra era *' + word + '*. +' + lives + ' puntos (total: ' + total + ').')
      return
    }
  }
  await ctx.reply('💀 Perdiste. La palabra era *' + word + '*.')
}, { trigger: 'ahorcado' })

// Trivia: numbered menus with c.choose (WhatsApp Web has no native buttons).
bot.conversation('trivia', async (c, ctx) => {
  let correct = 0
  for (const item of TRIVIA) {
    const pick = await c.choose(item.q, item.options, { timeout: '2m' })
    if (pick === item.answer) {
      correct++
      await ctx.reply('✅ ¡Correcto!')
    } else {
      await ctx.reply('❌ Era: ' + item.options[item.answer])
    }
  }
  const total = await addPoints(ctx, correct)
  await ctx.reply('🏁 ' + correct + '/' + TRIVIA.length + ' aciertos. Total: ' + total + ' puntos.')
}, { trigger: 'trivia' })

// Tic-tac-toe against the bot.
bot.conversation('triqui', async (c, ctx) => {
  const board = Array(9).fill(null)
  for (;;) {
    const cell = await c.ask(renderBoard(board) + '\nEres X. Elige una casilla libre (1-9):', {
      timeout: '2m',
      validate: (t) => {
        const n = Number(t.trim())
        return (Number.isInteger(n) && n >= 1 && n <= 9 && !board[n - 1]) || 'Elige el número de una casilla libre (1-9).'
      },
    })
    board[Number(cell.trim()) - 1] = 'X'
    let result = winnerOf(board)
    if (!result) {
      board[botMove(board)] = 'O'
      result = winnerOf(board)
    }
    if (result) {
      const points = result === 'X' ? 3 : result === 'draw' ? 1 : 0
      const total = points ? await addPoints(ctx, points) : null
      const verdict = result === 'X' ? '🎉 ¡Ganaste!' : result === 'draw' ? '🤝 Empate.' : '🤖 Gané yo.'
      await ctx.reply(renderBoard(board) + '\n' + verdict + (total === null ? '' : ' Total: ' + total + ' puntos.'))
      return
    }
  }
}, { trigger: 'triqui' })
`,
  notes: [
    'Send **hola** for the list of games. Every game is a `bot.conversation()` started by its keyword',
    '(`adivina`, `ahorcado`, `trivia`, `triqui`); scores live in `ctx.user.ns(\'games\')`, so they survive',
    'restarts once you plug a persistent store (`@bot-wa/sqlite-store`, `@bot-wa/redis-store`).',
  ],
})

/* support ---------------------------------------------------------------- */

const support = baileysTemplate({
  name: 'support',
  label: 'WhatsApp · Support desk',
  description: 'Customer-support bot: tickets per user, FAQ menu and human handoff (ctx.handoff / /bot to resume).',
  session: 'support-bot',
  readyLine: '✅ Support bot connected — send it "hola"',
  coreImports: ['userOf'],
  config: "{ provider, handoff: { allowCommands: ['bot'] } }",
  prelude: code`
const BUSINESS = process.env.BUSINESS_NAME ?? 'Mi Empresa'

const HELP = [
  'Hola 👋 Soy el asistente de soporte de ' + BUSINESS + '.',
  '• *ticket* — abrir un ticket',
  '• *mis tickets* — ver tus tickets',
  '• *faq* — preguntas frecuentes',
  '• *agente* — hablar con una persona',
].join('\n')

const CATEGORIES = { 1: 'Pedido', 2: 'Pago', 3: 'Cuenta', 4: 'Otro' }

const FAQ = {
  1: { label: 'Horario de atención', answer: '🕘 Atendemos de lunes a viernes, 8:00–18:00.' },
  2: { label: 'Tiempos de envío', answer: '🚚 Los envíos tardan de 2 a 5 días hábiles.' },
  3: { label: 'Devoluciones', answer: '↩️ Tienes 30 días para devolver un producto sin uso.' },
}

const newTicketId = () => 'T-' + Date.now().toString(36).toUpperCase()
`,
  handlers: code`
const showHelp = async (ctx) => await ctx.reply(HELP)
bot.when('hola', showHelp)
bot.when(['ayuda', 'soporte'], showHelp)

// Open a ticket: flow DSL (choose → ask → do → say). Tickets live in the user's profile.
bot.use(
  flow('ticket')
    .choose('¿Sobre qué es tu consulta?', CATEGORIES, 'category')
    .ask('Describe el problema en un solo mensaje:', 'description', {
      validate: (t) => t.trim().length >= 10 || 'Cuéntame un poco más (mínimo 10 caracteres).',
    })
    .do(async (ctx, c) => {
      const support = userOf(ctx).ns('support')
      const ticket = {
        id: newTicketId(),
        category: CATEGORIES[c.state.category],
        description: c.state.description,
        status: 'abierto',
        createdAt: new Date().toISOString(),
      }
      const tickets = (await support.get('tickets')) ?? []
      await support.set('tickets', [...tickets, ticket].slice(-20))
      c.state.ticketId = ticket.id
      // Log ids only — never message bodies or personal data.
      bot.logger.info({ ticket: ticket.id, category: ticket.category }, 'ticket opened')
    })
    .say((_ctx, c) => '🎫 Ticket *' + c.state.ticketId + '* creado. Te responderemos pronto. Escribe *mis tickets* para verlo.')
    .timeout('10m'),
)

bot.when('mis tickets', async (ctx) => {
  const tickets = (await ctx.user.ns('support').get('tickets')) ?? []
  if (tickets.length === 0) return await ctx.reply('No tienes tickets. Escribe *ticket* para abrir uno.')
  await ctx.reply(['📋 *Tus tickets*', ...tickets.map((t) => '• ' + t.id + ' — ' + t.category + ' (' + t.status + ')')].join('\n'))
})

bot.use(
  flow('faq')
    .choose('❓ Preguntas frecuentes:', Object.fromEntries(Object.entries(FAQ).map(([k, v]) => [k, v.label])), 'topic')
    .say((_ctx, c) => FAQ[c.state.topic].answer)
    .timeout('5m'),
)

// Human handoff: the bot stays silent in this chat until /bot (or bot.resume from your inbox).
bot.when('agente', async (ctx) => {
  await ctx.reply('👩‍💼 Te comunico con una persona del equipo. Escribe /bot para volver al asistente.')
  await ctx.handoff({ reason: 'user request' })
})
bot.command('bot', async (ctx) => {
  await bot.resume(ctx.from, { reason: 'user returned' })
  await ctx.reply('🤖 ¡He vuelto! Escribe *ayuda* para ver las opciones.')
})
bot.on('handoff', ({ reason }) => bot.logger.info({ reason }, 'chat handed off to a human'))
`,
  env: ['# Shown in the greeting.', 'BUSINESS_NAME=Mi Empresa'],
  notes: [
    '- **ticket** opens a ticket (category → description); tickets are kept per user in `ctx.user.ns(\'support\')`.',
    '- **faq** shows a numbered FAQ menu; **agente** hands the chat off to a human (`ctx.handoff`);',
    '  `/bot` resumes the bot. Hook `bot.on(\'handoff\')` / `bot.on(\'message\')` to your inbox or CRM.',
  ],
})

/* store ------------------------------------------------------------------ */

const store = baileysTemplate({
  name: 'store',
  label: 'WhatsApp · Store',
  description: 'Store bot with a product catalog, a per-user cart (ctx.user with TTL) and a checkout flow.',
  session: 'store-bot',
  readyLine: '✅ Store bot connected — send it "hola"',
  coreImports: ['userOf'],
  prelude: code`
const CURRENCY = process.env.CURRENCY ?? 'COP'
const money = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 }).format(n)

// Your catalog. Replace with data from your backend/DB if you have one.
const CATALOG = [
  { sku: 'CAM-01', name: 'Camiseta básica', price: 45000 },
  { sku: 'GOR-01', name: 'Gorra bordada', price: 38000 },
  { sku: 'TAZ-01', name: 'Taza personalizada', price: 25000 },
  { sku: 'BOL-01', name: 'Bolso de tela', price: 52000 },
]
const bySku = (sku) => CATALOG.find((p) => p.sku === sku)
const PRODUCT_OPTIONS = Object.fromEntries(CATALOG.map((p, i) => [String(i + 1), p.name + ' — ' + money(p.price)]))

const HELP = [
  '🛍️ *Tienda*',
  '• *catalogo* — ver productos',
  '• *comprar* — añadir al carrito',
  '• *carrito* — ver tu carrito',
  '• *pagar* — finalizar la compra',
  '• *vaciar* — vaciar el carrito',
].join('\n')

/** The cart lives in the user's profile and expires after 7 days without changes. */
const cartOf = (ctx) => userOf(ctx).ns('shop')
const CART_TTL = '7d'
const cartTotal = (cart) => cart.reduce((sum, item) => sum + (bySku(item.sku)?.price ?? 0) * item.qty, 0)
const cartLines = (cart) => cart.map((item) => '• ' + item.qty + ' × ' + (bySku(item.sku)?.name ?? item.sku))
`,
  handlers: code`
const showHelp = async (ctx) => await ctx.reply('¡Hola! 👋\n' + HELP)
bot.when('hola', showHelp)
bot.when('ayuda', showHelp)

bot.when(['catalogo', 'productos'], async (ctx) => {
  await ctx.reply(['📦 *Catálogo*', ...CATALOG.map((p, i) => (i + 1) + '. ' + p.name + ' — ' + money(p.price))].join('\n'))
})

bot.use(
  flow('comprar')
    .choose('¿Qué producto quieres?', PRODUCT_OPTIONS, 'product')
    .ask('¿Cuántas unidades? (1-20)', 'qty', {
      validate: (t) => (/^\d+$/.test(t.trim()) && Number(t) >= 1 && Number(t) <= 20) || 'Escribe un número entre 1 y 20.',
    })
    .do(async (ctx, c) => {
      const product = CATALOG[Number(c.state.product) - 1]
      const cart = (await cartOf(ctx).get('cart')) ?? []
      const existing = cart.find((item) => item.sku === product.sku)
      if (existing) existing.qty += Number(c.state.qty)
      else cart.push({ sku: product.sku, qty: Number(c.state.qty) })
      await cartOf(ctx).set('cart', cart, { ttl: CART_TTL })
      c.state.total = cartTotal(cart)
    })
    .say((_ctx, c) => '🛒 Añadido. Total del carrito: ' + money(c.state.total) + '. Escribe *carrito* o *pagar*.')
    .timeout('10m'),
)

bot.when('carrito', async (ctx) => {
  const cart = (await cartOf(ctx).get('cart')) ?? []
  if (cart.length === 0) return await ctx.reply('Tu carrito está vacío. Escribe *comprar*.')
  await ctx.reply(['🛒 *Tu carrito*', ...cartLines(cart), 'Total: ' + money(cartTotal(cart))].join('\n'))
})

bot.when('vaciar', async (ctx) => {
  await cartOf(ctx).delete('cart')
  await ctx.reply('🗑️ Carrito vacío.')
})

bot.use(
  flow('pagar')
    .do(async (ctx, c) => {
      const cart = (await cartOf(ctx).get('cart')) ?? []
      if (cart.length === 0) c.end('Tu carrito está vacío. Escribe *comprar*.')
      c.state.cart = cart
    })
    .ask('¿A nombre de quién va el pedido?', 'name')
    .ask('¿Dirección de entrega?', 'address')
    .choose('¿Cómo vas a pagar?', { 1: 'Transferencia', 2: 'Contraentrega' }, 'payment')
    .say((_ctx, c) => ['🧾 *Resumen*', ...cartLines(c.state.cart), 'Total: ' + money(cartTotal(c.state.cart))].join('\n'))
    .choose('¿Confirmas el pedido?', { 1: 'Confirmar', 2: 'Cancelar' }, 'confirm')
    .do(async (ctx, c) => {
      if (c.state.confirm !== '1') c.end('Pedido cancelado. Tu carrito sigue guardado.')
      const order = {
        id: 'P-' + Date.now().toString(36).toUpperCase(),
        items: c.state.cart,
        total: cartTotal(c.state.cart),
        payment: c.state.payment === '1' ? 'transferencia' : 'contraentrega',
        createdAt: new Date().toISOString(),
      }
      const orders = (await cartOf(ctx).get('orders')) ?? []
      await cartOf(ctx).set('orders', [...orders, order].slice(-20))
      await cartOf(ctx).delete('cart')
      c.state.order = order
      bot.logger.info({ order: order.id }, 'order placed')
    })
    .say((_ctx, c) => '✅ Pedido *' + c.state.order.id + '* recibido por ' + money(c.state.order.total) + '. ¡Gracias, ' + c.state.name + '!')
    .timeout('15m'),
)
`,
  env: ['# ISO 4217 currency used to format prices.', 'CURRENCY=COP'],
  notes: [
    '- Edit `CATALOG` in `src/bot.js` (or load it from your backend inside the factory — it may be async).',
    '- The cart is stored in `ctx.user.ns(\'shop\')` with a 7-day TTL; orders are kept per user.',
    '- Flows: **comprar** (product → quantity), **pagar** (name → address → payment → confirm).',
  ],
})

/* restaurant ------------------------------------------------------------- */

const restaurant = baileysTemplate({
  name: 'restaurant',
  label: 'WhatsApp · Restaurant',
  description: 'Restaurant bot: menu, delivery/pickup orders, table reservations and "repeat my last order".',
  session: 'restaurant-bot',
  readyLine: '✅ Restaurant bot connected — send it "hola"',
  coreImports: ['userOf'],
  prelude: code`
const RESTAURANT = process.env.RESTAURANT_NAME ?? 'Mi Restaurante'
const money = (n) => '$' + n.toLocaleString('es-CO')

const DISHES = [
  { name: 'Bandeja paisa', price: 32000 },
  { name: 'Ajiaco santafereño', price: 28000 },
  { name: 'Arroz con pollo', price: 24000 },
  { name: 'Ensalada de la casa', price: 18000 },
  { name: 'Limonada de coco', price: 9000 },
]
const DISH_OPTIONS = Object.fromEntries(DISHES.map((d, i) => [String(i + 1), d.name + ' — ' + money(d.price)]))

const HELP = [
  '🍽️ *' + RESTAURANT + '*',
  '• *carta* — ver el menú',
  '• *pedir* — hacer un pedido',
  '• *repetir* — repetir tu último pedido',
  '• *reservar* — reservar una mesa',
  '• *horario* — horario y dirección',
].join('\n')

const orderSummary = (o) => o.qty + ' × ' + o.dish + ' — ' + money(o.total) + ' (' + (o.address ? 'domicilio: ' + o.address : 'recoger en el local') + ')'
`,
  handlers: code`
const showHelp = async (ctx) => await ctx.reply('¡Hola! 👋\n' + HELP)
bot.when('hola', showHelp)
bot.when('ayuda', showHelp)

bot.when(['carta', 'menu del dia'], async (ctx) => {
  await ctx.reply(['📜 *Carta*', ...DISHES.map((d, i) => (i + 1) + '. ' + d.name + ' — ' + money(d.price))].join('\n'))
})

bot.when('horario', async (ctx) => {
  await ctx.reply('🕛 Lunes a domingo, 12:00–22:00.\n📍 ' + (process.env.RESTAURANT_ADDRESS ?? 'Calle 123 #45-67'))
})

bot.use(
  flow('pedir')
    .choose('¿Qué deseas pedir?', DISH_OPTIONS, 'dish')
    .ask('¿Cuántas porciones? (1-10)', 'qty', {
      validate: (t) => (/^\d+$/.test(t.trim()) && Number(t) >= 1 && Number(t) <= 10) || 'Escribe un número entre 1 y 10.',
    })
    .choose('¿Domicilio o recoger?', { 1: 'Domicilio', 2: 'Recoger en el local' }, 'delivery')
    .do(async (_ctx, c) => {
      // Waits inside a .do() step are fine: ask the address only for deliveries.
      if (c.state.delivery === '1') c.state.address = (await c.ask('¿Dirección de entrega?', { timeout: '5m' })).trim()
      const dish = DISHES[Number(c.state.dish) - 1]
      c.state.order = { dish: dish.name, qty: Number(c.state.qty), total: dish.price * Number(c.state.qty), address: c.state.address ?? null }
    })
    .say((_ctx, c) => '🧾 Tu pedido: ' + orderSummary(c.state.order))
    .choose('¿Confirmas el pedido?', { 1: 'Confirmar', 2: 'Cancelar' }, 'confirm')
    .do(async (ctx, c) => {
      if (c.state.confirm !== '1') c.end('Pedido cancelado. Escribe *pedir* cuando quieras.')
      await userOf(ctx).set('lastOrder', c.state.order)
      bot.logger.info({ dish: c.state.order.dish, qty: c.state.order.qty }, 'order placed')
    })
    .say('✅ ¡Pedido confirmado! Te avisamos cuando salga de cocina.')
    .timeout('15m'),
)

bot.when('repetir', async (ctx) => {
  const last = await ctx.user.get('lastOrder')
  if (!last) return await ctx.reply('Aún no tienes pedidos. Escribe *pedir*.')
  await ctx.reply('🔁 Repetimos tu último pedido: ' + orderSummary(last))
})

bot.use(
  flow('reservar')
    .ask('¿Para cuántas personas? (1-20)', 'people', {
      validate: (t) => (/^\d+$/.test(t.trim()) && Number(t) >= 1 && Number(t) <= 20) || 'Escribe un número entre 1 y 20.',
    })
    .ask('¿Qué día y hora? (ej. viernes 8pm)', 'when')
    .ask('¿A nombre de quién?', 'name')
    .do(async (ctx, c) => {
      await userOf(ctx).set('reservation', { people: Number(c.state.people), when: c.state.when, name: c.state.name })
    })
    .say((_ctx, c) => '📅 Reserva para ' + c.state.people + ' personas (' + c.state.when + ') a nombre de ' + c.state.name + '. ¡Te esperamos!')
    .timeout('10m'),
)
`,
  env: ['# Shown in the greeting and in "horario".', 'RESTAURANT_NAME=Mi Restaurante', 'RESTAURANT_ADDRESS=Calle 123 #45-67'],
  notes: [
    '- Edit `DISHES` in `src/bot.js`. Flows: **pedir** (dish → portions → delivery/pickup → address → confirm)',
    '  and **reservar** (people → date/time → name). The last order and reservation are kept in `ctx.user`.',
  ],
})

/* clinic ----------------------------------------------------------------- */

const clinic = baileysTemplate({
  name: 'clinic',
  label: 'WhatsApp · Clinic',
  description: 'Clinic bot: appointment booking by specialty/day/time, list and cancel appointments, emergency notice.',
  session: 'clinic-bot',
  readyLine: '✅ Clinic bot connected — send it "hola"',
  prelude: code`
const CLINIC = process.env.CLINIC_NAME ?? 'Mi Clínica'
const EMERGENCY_PHONE = process.env.EMERGENCY_PHONE ?? '123'

const SPECIALTIES = { 1: 'Medicina general', 2: 'Odontología', 3: 'Pediatría', 4: 'Psicología' }
const HOURS = { 1: '08:00', 2: '10:00', 3: '14:00', 4: '16:00' }
const SITES = {
  1: { name: 'Sede Norte', address: 'Calle 100 #15-20', hours: 'L-V 7:00–19:00' },
  2: { name: 'Sede Centro', address: 'Carrera 7 #24-10', hours: 'L-S 7:00–17:00' },
}

const HELP = [
  '🏥 *' + CLINIC + '*',
  '• *cita* — agendar una cita',
  '• *mis citas* — ver tus citas',
  '• *cancelar cita* — cancelar una cita',
  '• *sedes* — direcciones y horarios',
  '• *urgencias* — qué hacer en una urgencia',
].join('\n')

/** The next working days (Mon–Fri) after today, as choose() options. */
function nextWorkingDays(count, from = new Date()) {
  const days = []
  const d = new Date(from)
  while (days.length < count) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() === 0 || d.getDay() === 6) continue
    days.push({
      iso: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
      label: d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' }),
    })
  }
  return days
}
const apptLine = (a) => a.id + ' — ' + a.specialty + ', ' + a.date + ' ' + a.time
`,
  handlers: code`
const showHelp = async (ctx) => await ctx.reply('¡Hola! 👋\n' + HELP)
bot.when('hola', showHelp)
bot.when('ayuda', showHelp)

// Locations: a small flow (numbered menu → answer).
bot.use(
  flow('sedes')
    .choose('📍 ¿Qué sede te queda mejor?', Object.fromEntries(Object.entries(SITES).map(([k, v]) => [k, v.name])), 'site')
    .say((_ctx, c) => '📍 ' + SITES[c.state.site].name + ': ' + SITES[c.state.site].address + ' (' + SITES[c.state.site].hours + ')')
    .timeout('5m'),
)

bot.when('urgencias', async (ctx) => {
  await ctx.reply('🚨 Si es una urgencia, no esperes una cita: llama al ' + EMERGENCY_PHONE + ' o acude al servicio de urgencias más cercano.')
})

// Booking: an async conversation, because the day options are computed when it starts.
bot.conversation('cita', async (c, ctx) => {
  const clinic = ctx.user.ns('clinic')
  let patient = await clinic.get('patient')
  if (!patient) {
    patient = (await c.ask('¿Nombre completo del paciente?', {
      timeout: '5m',
      validate: (t) => t.trim().length >= 3 || 'Escribe el nombre completo.',
    })).trim()
    await clinic.set('patient', patient)
  }
  const specialty = await c.choose('¿Qué especialidad necesitas?', SPECIALTIES, { timeout: '5m' })
  const days = nextWorkingDays(5)
  const dayKey = await c.choose('¿Qué día?', Object.fromEntries(days.map((d, i) => [String(i + 1), d.label])), { timeout: '5m' })
  const hourKey = await c.choose('¿A qué hora?', HOURS, { timeout: '5m' })
  const day = days[Number(dayKey) - 1]
  const appt = { id: 'C-' + Date.now().toString(36).toUpperCase(), specialty: SPECIALTIES[specialty], date: day.iso, time: HOURS[hourKey] }
  const confirm = await c.choose('Confirma la cita de ' + patient + ': ' + appt.specialty + ', ' + day.label + ' a las ' + appt.time, { 1: 'Sí, agendar', 2: 'No' }, { timeout: '5m' })
  if (confirm !== '1') return await ctx.reply('Cita no agendada. Escribe *cita* para empezar de nuevo.')
  const appointments = (await clinic.get('appointments')) ?? []
  await clinic.set('appointments', [...appointments, appt])
  // Log ids only: health data is sensitive personal data.
  bot.logger.info({ appointment: appt.id }, 'appointment booked')
  await ctx.reply('✅ Cita agendada: ' + apptLine(appt) + '. Llega 15 minutos antes.')
}, { trigger: 'cita' })

bot.when('mis citas', async (ctx) => {
  const appointments = (await ctx.user.ns('clinic').get('appointments')) ?? []
  if (appointments.length === 0) return await ctx.reply('No tienes citas. Escribe *cita* para agendar una.')
  await ctx.reply(['📅 *Tus citas*', ...appointments.map((a) => '• ' + apptLine(a))].join('\n'))
})

bot.conversation('cancelar-cita', async (c, ctx) => {
  const clinic = ctx.user.ns('clinic')
  const appointments = (await clinic.get('appointments')) ?? []
  if (appointments.length === 0) return await ctx.reply('No tienes citas para cancelar.')
  const pick = await c.choose('¿Cuál cita quieres cancelar?', Object.fromEntries(appointments.map((a, i) => [String(i + 1), apptLine(a)])), { timeout: '5m' })
  const removed = appointments[Number(pick) - 1]
  await clinic.set('appointments', appointments.filter((a) => a.id !== removed.id))
  await ctx.reply('🗑️ Cita ' + removed.id + ' cancelada.')
}, { trigger: 'cancelar cita' })
`,
  env: ['# Shown in the greeting.', 'CLINIC_NAME=Mi Clínica', '# Number given for emergencies.', 'EMERGENCY_PHONE=123'],
  notes: [
    '- **cita** books an appointment (patient name once, then specialty → working day → time → confirm);',
    '  **mis citas** / **cancelar cita** manage them. Everything is stored per patient in `ctx.user.ns(\'clinic\')`.',
    '- Health data is sensitive: plug a persistent, access-controlled store, keep logs free of personal data and',
    '  connect `cita` to your real agenda before going live. The bot is not a channel for emergencies.',
  ],
})

/* ai-full ---------------------------------------------------------------- */

const AI_POLICY_URL = 'https://www.whatsapp.com/legal/business-solution-terms'

const aiFullDescription =
  'Full-stack bot: business-scoped AI (@bot-wa/ai) with order tools + keyword intents + SQLite store + scheduler + slash commands + human handoff.'

const aiFull: ProjectTemplate = {
  name: 'ai-full',
  label: 'WhatsApp · AI full stack',
  description: aiFullDescription,
  files: (name) => [
    {
      path: 'package.json',
      contents: packageJson(name, {
        '@bot-wa/core': CORE_VERSION,
        '@bot-wa/baileys': TRANSPORT_VERSION,
        '@bot-wa/ai': TRANSPORT_VERSION,
        '@bot-wa/sqlite-store': TRANSPORT_VERSION,
        '@anthropic-ai/sdk': ANTHROPIC_SDK_VERSION,
        'better-sqlite3': BETTER_SQLITE3_VERSION,
      }),
    },
    {
      path: 'src/bot.js',
      contents: botModule({
        imports: [
          BAILEYS_IMPORT,
          "import { aiPlugin } from '@bot-wa/ai'",
          "import { SQLiteStore } from '@bot-wa/sqlite-store'",
        ],
        coreImports: ['slashCommandsPlugin'],
        prelude: code`
// Business-scoped persona: keep the AI on YOUR business (support, sales, bookings).
// Since 2026-01-15 the WhatsApp Business Platform terms prohibit general-purpose
// AI assistants (open-ended, ChatGPT-style chatbots); AI that serves your own
// customers is allowed. Policy: ${AI_POLICY_URL}
const BUSINESS = process.env.BUSINESS_NAME ?? 'Mi Negocio'
const PERSONA = [
  'Eres el asistente de atención al cliente de ' + BUSINESS + '.',
  'Solo respondes sobre sus productos, servicios, precios, pedidos, horarios y reservas.',
  'Si te piden algo ajeno al negocio, explica con amabilidad que solo puedes ayudar con temas de ' + BUSINESS + ' y ofrece hablar con una persona.',
  'Responde breve y en el idioma del cliente. Si no sabes un dato, dilo; no lo inventes.',
  'Para pedidos usa las herramientas: consulta ver_menu y usa solo sus claves de producto.',
].join(' ')

// Catalog the AI can sell from. The product keys are an enum in the tool schemas, so the
// model can only order real products: invalid arguments go back to the model (it corrects
// itself) and the customer is never asked to confirm an order that cannot exist.
const MENU = {
  torta_chocolate: { name: 'Torta de chocolate', price: 45000 },
  pan_queso: { name: 'Pan de queso', price: 3500 },
  cafe: { name: 'Café', price: 4000 },
}
const PRODUCTS = Object.keys(MENU)
const ITEMS = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    properties: {
      producto: { type: 'string', enum: PRODUCTS, description: 'Clave del menú (ver_menu)' },
      cantidad: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['producto', 'cantidad'],
    additionalProperties: false,
  },
}
const ORDER_ID = { type: 'string', description: 'Id del pedido (mis_pedidos)' }
const priced = (items) => {
  const lines = items.map((i) => ({ ...i, subtotal: MENU[i.producto].price * i.cantidad }))
  return { items: lines, total: lines.reduce((sum, i) => sum + i.subtotal, 0) }
}
// Orders live in ctx.user (per customer, persisted by the store).
const ordersOf = (tctx) => {
  if (!tctx.ctx) throw new Error('only available in a chat')
  return tctx.ctx.user.ns('pedidos')
}
const loadOrders = async (tctx) => (await ordersOf(tctx).get('list')) ?? []
const findOrder = (orders, id) => {
  const order = orders.find((o) => o.id === id && o.estado !== 'cancelado')
  if (!order) throw new Error('No existe un pedido activo con id ' + id + '. Consulta mis_pedidos.')
  return order
}

// AI tools. confirm: true → the bot shows the customer a readable summary and waits for
// "sí"/"no" (a reply with changes goes back to the model, which re-proposes). The model is
// told not to ask for confirmation itself. dedupe blocks the same order twice in a row.
const TOOLS = {
  ver_menu: {
    description: 'Lista los productos del menú: clave, nombre y precio.',
    handler: () => Object.entries(MENU).map(([clave, p]) => ({ clave, nombre: p.name, precio: p.price })),
  },
  mis_pedidos: {
    description: 'Lista los pedidos del cliente con su id, productos, total y estado.',
    handler: async (_args, tctx) => await loadOrders(tctx),
  },
  crear_pedido: {
    title: 'Crear pedido',
    description: 'Registra un pedido nuevo. items: lista de { producto, cantidad } con claves del menú.',
    schema: { type: 'object', properties: { items: ITEMS }, required: ['items'], additionalProperties: false },
    confirm: true,
    dedupe: 'args',
    handler: async ({ items }, tctx) => {
      const orders = await loadOrders(tctx)
      const order = { id: 'P-' + Date.now().toString(36).toUpperCase(), ...priced(items), estado: 'confirmado' }
      await ordersOf(tctx).set('list', [...orders, order].slice(-20))
      return order
    },
  },
  actualizar_pedido: {
    title: 'Cambiar pedido',
    description: 'Reemplaza los productos de un pedido existente (por id) con la nueva lista completa.',
    schema: { type: 'object', properties: { id: ORDER_ID, items: ITEMS }, required: ['id', 'items'], additionalProperties: false },
    confirm: true,
    handler: async ({ id, items }, tctx) => {
      const orders = await loadOrders(tctx)
      Object.assign(findOrder(orders, id), priced(items))
      await ordersOf(tctx).set('list', orders)
      return findOrder(orders, id)
    },
  },
  cancelar_pedido: {
    title: 'Cancelar pedido',
    description: 'Cancela un pedido existente por id.',
    schema: { type: 'object', properties: { id: ORDER_ID }, required: ['id'], additionalProperties: false },
    confirm: true,
    handler: async ({ id }, tctx) => {
      const orders = await loadOrders(tctx)
      findOrder(orders, id).estado = 'cancelado'
      await ordersOf(tctx).set('list', orders)
      return { id, estado: 'cancelado' }
    },
  },
}

// Lightweight intents (keyword/regex NLU): answered before the AI, at zero token cost.
const INTENTS = {
  hours: /\b(horario|abren|cierran|atienden)\b/i,
  prices: /\b(precios?|cu[aá]nto (cuesta|vale)|tarifas?)\b/i,
  human: /\b(humano|persona|agente|asesor)\b/i,
  name: /^(?:me llamo|mi nombre es)\s+(.{2,40})$/i,
}
`,
        // `store` is undefined under `npm run dev` (the simulator passes only the provider),
        // so the bot falls back to the in-memory store there.
        params: 'provider, store',
        config: "{ provider, store, handoff: { allowCommands: ['bot'] } }",
        setup: [
          ...code`
// /start /help /reset /cancel /id /ping. Installed BEFORE aiPlugin: the AI is a catch-all.
bot.plug(slashCommandsPlugin)
// AI autoresponder for text nothing else consumed; its /reset also clears the chat's AI context.
bot.plug(
  aiPlugin({
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    persona: PERSONA,
    context: { maxMessages: 20 },
    tools: TOOLS,
  }),
)

// Scheduler: hourly housekeeping removes expired ctx.user keys (TTL) from the store...
bot.every('1h', async () => {
  const removed = await bot.purgeExpiredUserData()
  if (removed > 0) bot.logger.info({ removed }, 'purged expired user data')
})
// ...and a weekday 09:00 summary (replace with your own report or broadcast).
bot.schedule('0 9 * * 1-5', () => bot.logger.info({ handoffs: bot.listHandoffs().length }, 'daily summary'))
`,
          '',
        ],
        handlers: code`
bot.when('hola', async (ctx) => {
  const name = await ctx.user.get('name')
  await ctx.reply('¡Hola' + (name ? ' ' + name : '') + '! 👋 Soy el asistente de ' + BUSINESS + '. Pregúntame lo que necesites o escribe /help.')
})

bot.when(INTENTS.name, async (ctx) => {
  const name = (INTENTS.name.exec(ctx.body.trim())?.[1] ?? '').trim()
  if (!name) return await ctx.reply('¿Cómo te llamas? Escribe: me llamo <tu nombre>')
  await ctx.user.set('name', name)
  await ctx.reply('¡Mucho gusto, ' + name + '! Lo recordaré.')
})

bot.when(INTENTS.hours, async (ctx) => await ctx.reply('🕘 Atendemos de lunes a sábado, 8:00–19:00.'))
bot.when(INTENTS.prices, async (ctx) => await ctx.reply('💲 Nuestra lista de precios: ' + (process.env.PRICES_URL ?? 'https://example.com/precios')))

// Human handoff: the bot (and the AI) stay silent in this chat until /bot.
bot.when(INTENTS.human, async (ctx) => {
  await ctx.reply('👩‍💼 Te comunico con una persona. Escribe /bot para volver al asistente.')
  await ctx.handoff({ reason: 'user request' })
})
bot.command('bot', async (ctx) => {
  await bot.resume(ctx.from, { reason: 'user returned' })
  await ctx.reply('🤖 ¡He vuelto!')
})

// A small flow: leave your contact details for a callback (kept in ctx.user).
bot.use(
  flow('contacto')
    .ask('¿Cómo te llamas?', 'name')
    .ask('¿A qué hora prefieres que te llamemos?', 'when')
    .do(async (ctx, c) => {
      await ctx.user.update({ name: c.state.name, callback: c.state.when })
    })
    .say((_ctx, c) => '📞 ¡Listo, ' + c.state.name + '! Te llamamos ' + c.state.when + '.')
    .timeout('10m'),
)
`,
        main: [
          '// Durable store: conversations, ctx.user profiles, AI context and handoffs survive restarts.',
          "const store = new SQLiteStore({ file: process.env.SQLITE_FILE ?? './bot.db' })",
          ...baileysMain('my-ai-full-bot', '✅ Bot connected — try "hola", "horario" or any question', ', store'),
        ],
      }),
    },
    {
      path: '.env.example',
      contents: [
        '# Anthropic API key (console.anthropic.com) — used by the AI autoresponder.',
        'ANTHROPIC_API_KEY=',
        '# Your business name — the AI persona only answers about this business.',
        'BUSINESS_NAME=Mi Negocio',
        '# Link sent for price questions.',
        'PRICES_URL=https://example.com/precios',
        '# SQLite database file (gitignored).',
        'SQLITE_FILE=./bot.db',
        '# Session/auth folder name (sessions/<name>).',
        'BOT_SESSION=my-ai-full-bot',
        '',
      ].join('\n'),
    },
    { path: '.gitignore', contents: GITIGNORE },
    {
      path: 'README.md',
      contents: readme(name, 'WhatsApp · AI full stack', aiFullDescription, [
        ...BAILEYS_README,
        '',
        'What is wired in `src/bot.js`:',
        '',
        '- **Intents** (`INTENTS`): regex triggers for hours, prices, "talk to a human" and "me llamo …", answered before the AI.',
        '- **AI** (`@bot-wa/ai`, Anthropic): answers any other text, scoped to `BUSINESS_NAME`; `/reset` clears the chat context.',
        '- **AI tools** (`TOOLS`): `ver_menu`, `mis_pedidos`, `crear_pedido`, `actualizar_pedido` and `cancelar_pedido`.',
        '  Products are an `enum` of the `MENU` keys (the model cannot order what does not exist); the order tools use',
        '  `confirm: true`, so the customer approves a readable summary first, and `crear_pedido` has `dedupe`.',
        '- **Store** (`@bot-wa/sqlite-store` + `better-sqlite3`): everything persists in `bot.db` on `npm start`;',
        '  `npm run dev` uses the in-memory store.',
        '- **Scheduler**: `bot.every(\'1h\')` purges expired user data, `bot.schedule(\'0 9 * * 1-5\')` logs a daily summary.',
        '- **Slash commands** (`/help`, `/reset`, `/id`, `/ping`…) and **human handoff** (`/bot` to resume).',
        '',
        '## WhatsApp AI policy',
        '',
        'Since 2026-01-15 the Meta terms for the **WhatsApp Business Platform** prohibit **general-purpose AI assistants**.',
        'AI that serves your own business — customer support, sales, bookings — is allowed. Keep `PERSONA` scoped to',
        'your business. Check the [current terms](' + AI_POLICY_URL + ') before going live.',
      ]),
    },
  ],
}

/* Registry --------------------------------------------------------------- */

export const DOMAIN_TEMPLATES: Record<DomainTemplateName, ProjectTemplate> = {
  games,
  support,
  store,
  restaurant,
  clinic,
  'ai-full': aiFull,
}

/** Template-specific lines for each project's AGENTS.md. */
export const DOMAIN_AGENT_NOTES: Record<DomainTemplateName, string[]> = {
  games: [
    '- Each game is a `bot.conversation(name, fn, { trigger })`; keep every `c.ask`/`c.choose` with a `timeout`.',
    "- Scores: `userOf(ctx).ns('games')` — never a module-level Map.",
  ],
  support: [
    "- Tickets are stored per user in `ctx.user.ns('support')`. Handoff: `ctx.handoff()` + `bot.command('bot', …resume)`",
    '  (`handoff.allowCommands` lists the commands that still work while a human is in charge).',
  ],
  store: ["- Cart: `ctx.user.ns('shop')` key `cart` with `{ ttl: '7d' }`; orders under `orders`. Prices come from `CATALOG`."],
  restaurant: ['- Conditional questions go inside a `.do()` step (`await c.ask(...)`); `c.end(msg)` cancels a flow.'],
  clinic: [
    '- Booking is a `bot.conversation` because its options are computed at runtime; appointments live in',
    "  `ctx.user.ns('clinic')`. Never log patient names or health data.",
  ],
  'ai-full': [
    '- Plugin order matters: `slashCommandsPlugin` first, `aiPlugin` last (it is the catch-all).',
    '- Intents are plain `bot.when(RegExp, …)` handlers; they run before the AI catch-all.',
    '- AI tools (`TOOLS`): keep product keys as a JSON Schema `enum` (validated before any confirmation); side-effecting',
    "  tools use `confirm: true` (and `dedupe` when a repeat would duplicate data). Orders live in `ctx.user.ns('pedidos')`.",
    '- The factory takes `(provider, store)`; `bot-wa dev` passes only the provider (in-memory store).',
  ],
}
