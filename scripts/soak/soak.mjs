#!/usr/bin/env node
/**
 * Load + soak + leak harness for the @bot-wa/core runtime (and @bot-wa/ai with
 * MockAIProvider). NOT part of `pnpm test`: run `pnpm build` first, then
 *
 *   pnpm bench:soak                                  # defaults (a few seconds)
 *   pnpm bench:soak -- --chats 2000 --rounds 20      # heavier
 *   pnpm bench:soak -- --duration 600 --chats 1000   # 10-minute soak
 *   pnpm bench:soak -- --json > soak.json            # machine-readable report
 *
 * Each round drives every scenario for the same set of chats (steady state: the
 * stores plateau, so heap growth across rounds is a leak) plus `--fresh` brand new
 * chats per round (bounded caches must stay at their caps). After every round it
 * waits for the bots to go idle, forces GC and samples heap, active handles,
 * internal map sizes, event-loop lag and throughput. At the end it stops both bots
 * and checks that no timers are left behind.
 *
 * Scenarios: flows (ask/validate/retry/timeout/delay), conversations with c.idle,
 * bot.onIdle, inbound dedupe, handoff/resume, i18n sticky language, ctx.user,
 * broadcast, metrics, typing pacer, streaming (edit), group participants, and AI
 * tool confirmations (buttons yes/no, typed answers, timeouts, /reset, stale presses).
 */

import { monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const lib = (p) => new URL(`file:///${resolve(root, p).replace(/\\/g, '/')}`).href

const { Bot, flow } = await import(lib('packages/core/lib/index.js'))
const { MockProvider } = await import(lib('packages/core/lib/testing/index.js'))
const { aiPlugin, MockAIProvider } = await import(lib('packages/ai/lib/index.js'))

const { values: args } = parseArgs({
  // `pnpm bench:soak -- --chats 2000` forwards a literal `--`: drop it.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    chats: { type: 'string', default: '300' },
    groups: { type: 'string', default: '20' },
    participants: { type: 'string', default: '10' },
    'ai-chats': { type: 'string', default: '150' },
    fresh: { type: 'string', default: '100' },
    rounds: { type: 'string', default: '6' },
    duration: { type: 'string' },
    json: { type: 'boolean', default: false },
    'trace-timers': { type: 'boolean', default: false },
  },
  allowPositionals: true,
})
const N = Number(args.chats)
const G = Number(args.groups)
const P = Number(args.participants)
const AI_N = Number(args['ai-chats'])
const FRESH = Number(args.fresh)
const ROUNDS = Number(args.rounds)
const DURATION_MS = args.duration ? Number(args.duration) * 1000 : undefined

if (typeof globalThis.gc !== 'function') {
  console.error('Run with --expose-gc (pnpm bench:soak does it for you).')
  process.exit(1)
}

/** --trace-timers: remember where every live Timeout was created (diagnostics, slow). */
const liveTimers = new Map()
if (args['trace-timers']) {
  const { createHook } = await import('node:async_hooks')
  createHook({
    init(asyncId, type) {
      if (type !== 'Timeout') return
      const stack = new Error().stack.split('\n').slice(2).filter((l) => l.includes('/packages/')).slice(0, 3).map((l) => l.trim().replace(/\(file:.*\/packages\//, '(')).join(' <- ')
      liveTimers.set(asyncId, stack)
    },
    destroy(asyncId) { liveTimers.delete(asyncId) },
  }).enable()
}
function timerOrigins() {
  const counts = {}
  // Timers without a package frame are the harness's own (scenario sleeps).
  for (const stack of liveTimers.values()) if (stack) counts[stack] = (counts[stack] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => { if (!args.json) console.log(...a) }
const silentLogger = () => {
  const l = { level: 'silent', child: () => l }
  for (const k of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) l[k] = () => {}
  return l
}

/* ------------------------------------------------------------------ core bot */

const coreProvider = new MockProvider({ streaming: 'edit' })
const core = new Bot({
  provider: coreProvider,
  logger: silentLogger(),
  storeConfig: { maxMessagesPerChat: 10 },
  typing: { enabled: true, minMs: 1, maxMs: 4, charsPerSecond: 1000 },
  conversation: { timeout: '400ms' },
  i18n: { defaultLocale: 'es' },
})
let errors = 0
core.on('error', () => { errors++ })

core.use(
  flow('registro')
    .ask('¿Nombre?', 'name', { timeout: '150ms' })
    .ask('¿Edad?', 'age', { timeout: '150ms', retries: 2, validate: (v) => /^\d+$/.test(v) || 'número' })
    .say('procesando', { delay: 3 })
    .delay(2)
    .say((_ctx, c) => `listo ${String(c.state.name)}`),
)
core.conversation('soporte', async (c) => {
  c.idle('20ms', async () => { await c.say('¿sigues?') })
  await c.ask('¿En qué te ayudo?', { timeout: '120ms' })
  c.idleClear()
  await c.say('ok')
})
core.when('soporte', async (ctx) => { void core.enterConversation('soporte', ctx).catch(() => {}) })
core.command('save', async (ctx) => {
  await ctx.user.set('visits', ((await ctx.user.get('visits')) ?? 0) + 1)
  await ctx.reply(ctx.t('core.commandsReset'))
})
core.when('cuento', async (ctx) => {
  async function* gen() { for (const w of ['Había ', 'una ', 'vez ', 'un ', 'bot.']) { await sleep(1); yield w } }
  await ctx.stream(gen(), { throttleMs: 0 })
})
core.when('eco', async (ctx) => { await ctx.reply(`eco ${ctx.lang}`) })
core.onIdle('40ms', async (ctx) => { await ctx.reply('idle', { typing: false }) })
core.onMessage(async (ctx) => { await ctx.reply('?', { typing: false }) })

/* -------------------------------------------------------------------- AI bot */

const aiProvider = new MockProvider({ buttons: true, supports: { edit: true } })
const ai = new Bot({ provider: aiProvider, logger: silentLogger(), storeConfig: { maxMessagesPerChat: 10 }, i18n: { defaultLocale: 'es' } })
ai.on('error', () => { errors++ })
const model = new MockAIProvider({
  reply: (input) => {
    const last = input.messages[input.messages.length - 1]
    if (last?.role === 'tool') return `resultado: ${last.results.map((r) => r.content).join(' | ')}`
    if (last?.role === 'user' && last.content.includes('borra')) return { toolCalls: [{ name: 'borrar', args: { n: last.content.length } }] }
    return `eco: ${last?.content ?? ''}`
  },
})
let toolRuns = 0
ai.plug(aiPlugin({
  __provider: model,
  tools: { borrar: { description: 'Borra', title: 'Borrar pedido', confirm: true, handler: () => { toolRuns++; return 'borrado' } } },
  toolConfirm: { timeout: '60ms' },
}))

/* ----------------------------------------------------------------- probing */

function sizes() {
  const b = core
  const rt = b.runtime
  const s = {
    'rt.active': rt.active.size,
    'rt.dormant': rt.dormant.size,
    'rt.preserveOnAbort': rt.preserveOnAbort.size,
    'dispatcher.queues': b.dispatcher.queues.size,
    'scheduler.tasks': b.scheduler.tasks.size,
    'idle.timers': [...b.idle.watches].reduce((n, w) => n + w.timers.size, 0),
    'idle.handedOff': b.idle.handedOff.size,
    'handoffs.states': b.handoffs.states.size,
    'dedupe.entries': b.inboundDedupe?.remembered ?? 0,
    'welcome.cached': b.welcome.welcomed.size,
    'externalSends': b.externalSends.last.size,
    'i18n.reported': b.i18n.reported.size,
    'chatWrites': b.chatWrites.size,
    'users.locks': b.users.locks.size,
    'inflightSends': b.inflightSends.size,
    'inflightEvents': b.inflightEvents.size,
    'core.listeners': b.eventNames().reduce((n, e) => n + b.listenerCount(e), 0),
    'ai.rt.active': ai.runtime.active.size,
    'ai.rt.preserveOnAbort': ai.runtime.preserveOnAbort.size,
    'ai.queues': ai.dispatcher.queues.size,
    'ai.ledger.chats': ai.tools.ai?.ledger?.chats?.size ?? 0,
    'ai.listeners': ai.eventNames().reduce((n, e) => n + ai.listenerCount(e), 0),
  }
  return s
}

function resources() {
  const counts = {}
  for (const r of process.getActiveResourcesInfo()) counts[r] = (counts[r] ?? 0) + 1
  return counts
}

async function heapAfterGc() {
  for (let i = 0; i < 3; i++) { globalThis.gc(); await sleep(5) }
  return process.memoryUsage().heapUsed
}

async function settle(maxMs = 5000) {
  const until = Date.now() + maxMs
  while (Date.now() < until) {
    const busy = core.isBusy() || ai.isBusy()
      || core.listConversations().length > 0 || ai.listConversations().length > 0
      || core.dispatcher.queues.size > 0 || ai.dispatcher.queues.size > 0
      || core.scheduler.tasks.size > 0
    if (!busy) return true
    await sleep(10)
  }
  return false
}

function clearRecorders() {
  for (const p of [coreProvider, aiProvider]) { p.outbox.length = 0; p.edits.length = 0; p.acks.length = 0; p.deleted.length = 0; p.drafts.length = 0 }
  model.calls.length = 0
}

/* ---------------------------------------------------------------- scenarios */

let seq = 0
const id = () => `soak-${++seq}`

async function dmScenario(chat, i, round) {
  const send = (text, extra = {}) => coreProvider.incoming(text, { from: chat, id: id(), ...extra })
  switch (i % 8) {
    case 0: { // flow, happy path (+ duplicate delivery of the answer)
      send('registro'); await sleep(5)
      send('Ana'); await sleep(5)
      const dup = id()
      coreProvider.incoming('30', { from: chat, id: dup }); coreProvider.incoming('30', { from: chat, id: dup })
      break
    }
    case 1: // flow, invalid then valid (retry)
      send('registro'); await sleep(5); send('Luis'); await sleep(5)
      send('x', { type: 'image' }); await sleep(3); send('abc'); await sleep(3); send('41')
      break
    case 2: // flow abandoned → timeout
      send('registro')
      break
    case 3: // conversation with c.idle, answered after the idle fired
      send('soporte'); await sleep(30); send('ayuda')
      break
    case 4: // conversation with c.idle, never answered (timeout)
      send('soporte')
      break
    case 5: // handoff while a flow is active, message, then resume
      send('registro'); await sleep(5)
      await core.handoff(chat, { reason: 'soak' })
      send('hola humano'); await sleep(5)
      await core.resume(chat)
      send('eco')
      break
    case 6: // sticky language: reported once, then omitted
      send('eco', { language: round % 2 ? 'en' : 'es' }); await sleep(3); send('eco'); await sleep(3); send('/save')
      break
    case 7: // streaming + catch-all + /reset mid-flow
      send('cuento'); await sleep(10); send('registro'); await sleep(3); send('/reset'); send('nada')
      break
  }
}

async function groupScenario(g, round) {
  const from = `group-${g}`
  const tasks = []
  for (let p = 0; p < P; p++) {
    const sender = `member-${g}-${p}`
    tasks.push((async () => {
      coreProvider.incoming('registro', { from, sender, isGroup: true, id: id() })
      await sleep(5)
      if ((p + round) % 3 === 0) return // abandon → timeout
      coreProvider.incoming(`P${p}`, { from, sender, isGroup: true, id: id() }); await sleep(5)
      coreProvider.incoming(String(20 + p), { from, sender, isGroup: true, id: id() })
    })())
  }
  await Promise.all(tasks)
}

const lastButtons = (chat) => {
  for (let i = aiProvider.outbox.length - 1; i >= 0; i--) {
    const m = aiProvider.outbox[i]
    if (m.chatId === chat && m.content.kind === 'buttons') return m.content
  }
  return undefined
}

async function aiScenario(chat, i) {
  const send = (text) => aiProvider.incoming(text, { from: chat, id: id() })
  send('borra mi pedido')
  // The confirmation goes out after the model + typing: wait for the buttons.
  let b
  for (let t = 0; t < 40 && !(b = lastButtons(chat)); t++) await sleep(5)
  switch (i % 6) {
    case 0: if (b) aiProvider.interaction(b.buttons[0].id, { from: chat }); break // yes
    case 1: if (b) aiProvider.interaction(b.buttons[1].id, { from: chat }); break // no
    case 2: send('sí, por favor'); break // typed
    case 3: break // timeout
    case 4: send('/reset'); break // reset while pending
    case 5: // answer, then a stale press of the same buttons
      if (b) { aiProvider.interaction(b.buttons[0].id, { from: chat }); await sleep(20); aiProvider.interaction(b.buttons[1].id, { from: chat }) }
      break
  }
  await sleep(5)
  send('hola')
}

/* ---------------------------------------------------------------------- run */

const lag = monitorEventLoopDelay({ resolution: 10 })
lag.enable()
await core.start()
await ai.start()

const dmChats = Array.from({ length: N }, (_, i) => `dm-${i}`)
const aiChats = Array.from({ length: AI_N }, (_, i) => `ai-${i}`)
const samples = []
let baselineHeap
const t0 = Date.now()

async function round(r) {
  clearRecorders()
  const startIn = core.metrics().messages.in + ai.metrics().messages.in
  const started = Date.now()
  lag.reset()
  const fresh = Array.from({ length: FRESH }, (_, i) => `fresh-${r}-${i}`)
  await Promise.all([
    ...dmChats.map((c, i) => dmScenario(c, i, r)),
    ...fresh.map((c, i) => dmScenario(c, i, r)),
    ...Array.from({ length: G }, (_, g) => groupScenario(g, r)),
    ...aiChats.map((c, i) => aiScenario(c, i)),
  ])
  void core.broadcast(dmChats.slice(0, 200), 'promo', { batchSize: 50, concurrency: 4, delayBetween: 1 })
  core.metrics()
  const settled = await settle()
  const elapsed = Date.now() - started
  const msgs = core.metrics().messages.in + ai.metrics().messages.in - startIn
  clearRecorders()
  const heap = await heapAfterGc()
  const sample = {
    round: r,
    settled,
    elapsedMs: elapsed,
    msgsIn: msgs,
    throughput: Math.round((msgs / elapsed) * 1000),
    heapMB: +(heap / 1048576).toFixed(2),
    lagP99ms: +(lag.percentile(99) / 1e6).toFixed(1),
    lagMaxMs: +(lag.max / 1e6).toFixed(1),
    resources: resources(),
    sizes: sizes(),
  }
  samples.push(sample)
  log(`round ${r}: ${msgs} msgs in ${elapsed} ms (${sample.throughput}/s) heap=${sample.heapMB} MB lag p99=${sample.lagP99ms} ms settled=${settled}`)
  log('  timers:', sample.resources.Timeout ?? 0, ' sizes:', JSON.stringify(sample.sizes))
  return heap
}

let r = 0
await round(r++) // warm-up (JIT, stores, caches fill)
baselineHeap = await heapAfterGc()
while (DURATION_MS !== undefined ? Date.now() - t0 < DURATION_MS : r <= ROUNDS) await round(r++)
const finalHeap = await heapAfterGc()

// Fresh chats grow the MemoryStore by design (chat, contact, message log, ctx.user). Erase
// them: what the heap keeps afterwards is growth the runtime itself holds on to.
let afterEraseHeap
if (FRESH > 0) {
  const store = core.getStore()
  for (let k = 0; k < r; k++) {
    for (let i = 0; i < FRESH; i++) {
      const chat = `fresh-${k}-${i}`
      await store.deleteChat(chat)
      await store.deleteContact(chat)
      await core.user(chat).clear().catch(() => {})
    }
  }
  afterEraseHeap = await heapAfterGc()
}

// Stop UNDER LOAD: conversations waiting, pacer sleeping, idle timers armed, streams,
// broadcast and AI confirmations in flight. `drain` must not leave its own timer behind.
const metrics = core.metrics()
const burst = Promise.all([
  ...dmChats.map((c, i) => dmScenario(c, i, r)),
  ...Array.from({ length: G }, (_, g) => groupScenario(g, r)),
  ...aiChats.map((c, i) => aiScenario(c, i)),
]).catch(() => {})
void core.broadcast(dmChats, 'promo', { batchSize: 20, delayBetween: 50 })
await sleep(25)
const stopStarted = Date.now()
await Promise.all([core.stop({ drain: true }), ai.stop({ drain: true })])
const stopMs = Date.now() - stopStarted
// The harness's own scenario sleeps end with the burst: whatever is still armed then is the bots'.
await burst
const afterBurst = resources()
const sizesAfterBurst = sizes()
const origins = args['trace-timers'] ? timerOrigins() : undefined
await sleep(500)
lag.disable()
const afterStop = { stopMs, afterBurst, sizesAfterBurst, resources: resources(), sizes: sizes(), heapMB: +((await heapAfterGc()) / 1048576).toFixed(2) }

const steady = samples.slice(1)
const growthPerRoundKB = steady.length > 1
  ? Math.round(((steady.at(-1).heapMB - steady[0].heapMB) * 1024) / (steady.length - 1))
  : 0
const report = {
  config: { chats: N, groups: G, participants: P, aiChats: AI_N, fresh: FRESH, rounds: r, durationMs: Date.now() - t0 },
  baselineHeapMB: +(baselineHeap / 1048576).toFixed(2),
  finalHeapMB: +(finalHeap / 1048576).toFixed(2),
  heapGrowthPerRoundKB: growthPerRoundKB,
  afterEraseHeapMB: afterEraseHeap === undefined ? undefined : +(afterEraseHeap / 1048576).toFixed(2),
  errors,
  toolRuns,
  conversations: metrics.conversations,
  samples,
  afterStop,
}
if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
else {
  log('\n=== summary ===')
  log(`heap: baseline ${report.baselineHeapMB} MB → final ${report.finalHeapMB} MB (${growthPerRoundKB} KB/round)`)
  if (report.afterEraseHeapMB !== undefined) log(`heap after erasing the ${FRESH * r} fresh chats from the store: ${report.afterEraseHeapMB} MB`)
  log('conversations:', JSON.stringify(metrics.conversations))
  log(`errors: ${errors}  toolRuns: ${toolRuns}`)
  log(`stop under load took ${stopMs} ms; active resources once the load ended:`, JSON.stringify(afterBurst))
  log(`  conversations live after stop: core=${sizesAfterBurst['rt.active']} ai=${sizesAfterBurst['ai.rt.active']}`)
  if (origins) for (const [stack, n] of origins) log(`  ${n}x ${stack}`)
  log('500 ms later — active resources:', JSON.stringify(afterStop.resources))
  log('after stop — sizes:', JSON.stringify(afterStop.sizes))
}
const leftTimers = Math.max(afterBurst.Timeout ?? 0, afterStop.resources.Timeout ?? 0)
if (leftTimers > 0) {
  log(`WARNING: ${leftTimers} timer(s) still active after stop()`)
  process.exitCode = 2
}
