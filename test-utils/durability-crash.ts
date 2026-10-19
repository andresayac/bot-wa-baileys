/**
 * Crash-recovery matrix for durability backends (`BotConfig.durability`).
 *
 * Bot A runs a script (a two-reply handler, then a persistent two-question flow) on a
 * {@link crashable} view of the backend and "dies" at a chosen point: a journal write
 * that never returns, or a handler that kills it mid-way. A is abandoned (never stopped,
 * its provider delivers nothing more). Bot B then starts on the SAME backend and store
 * with the same `instanceId` — a restarted process — and the transport redelivers the
 * message that was in flight plus the rest of the script.
 *
 * Asserted for every point: every inbound record ends `done`, nothing is left
 * pending/sending in the outbox, and every expected reply was delivered exactly once
 * across A's and B's providers. The one exception is the ambiguous window (the process
 * died between calling the provider and recording it): `'skip'` never duplicates (at most
 * once), `'resend'` never loses (at least once), and both report `'durability:ambiguous'`.
 *
 * Dependencies are injected so the same matrix runs from core (against src) and from the
 * store packages (against their real-server backends).
 */
import { describe, it, expect } from 'vitest'

/* Structural slices of the core API (keeps this file free of runtime imports). */
interface JournalLike {
  inbox: { list(f?: { state?: string }): Promise<Array<{ id: string; state: string }>> }
  outbox: { list(f?: { state?: string }): Promise<Array<{ key: string; state: string; content: unknown }>> }
}
type Backend = JournalLike & { start?(): Promise<void>; stop?(): Promise<void>; scope?(name: string): Backend }
interface CrashableLike extends Backend {
  readonly crashed: boolean
  readonly whenCrashed: Promise<void>
  crash(): void
  crashBefore(op: string, nth?: number): void
  crashAfter(op: string, nth?: number): void
}
interface ProviderLike {
  outbox: Array<{ chatId: string; content: { kind: string; text?: string } }>
  incoming(text: string, opts?: { from?: string; id?: string }): void
}
interface CtxLike { body: string; reply(text: string): Promise<unknown> }
interface FlowLike { persistent(): FlowLike; ask(q: string, key: string): FlowLike; say(t: (ctx: unknown, c: { state: Record<string, unknown> }) => string): FlowLike }
interface BotLike {
  start(): Promise<void>
  stop(): Promise<void>
  on(event: string, fn: (p: never) => void): unknown
  when(trigger: string, handler: unknown): unknown
  readonly durability?: { readonly scope?: string }
}

export interface CrashMatrixDeps {
  Bot: new (config: Record<string, unknown>) => BotLike
  MemoryStore: new () => unknown
  MockProvider: new () => ProviderLike
  CrashableProvider: new (backend: { crashed: boolean }) => ProviderLike
  crashable(backend: Backend): CrashableLike
  flow(name: string): FlowLike
}

export interface CrashMatrixHarness {
  /** A fresh backend (not started: the bots start it) and its teardown. */
  make(): Promise<{ backend: Backend; teardown: () => Promise<void> }>
}

/** Where bot A dies. `nth` counts calls of that journal operation across the whole script. */
export interface CrashPoint {
  name: string
  arm?: { when: 'before' | 'after'; op: string; nth: number }
  /** Kill A inside the 'hola' handler, between its two replies. */
  midHandler?: boolean
  /** The ambiguous window: the expected count of `ambiguousText` depends on the policy. */
  ambiguousText?: string
}

const CHAT = 'u1'
const SCRIPT: Array<[body: string, id: string]> = [['hola', 'm1'], ['pedido', 'm2'], ['Ana', 'm3'], ['Lima', 'm4']]
const EXPECTED = ['hola!', '¿qué tal?', '¿Nombre?', '¿Ciudad?', 'Listo Ana de Lima']

/**
 * Journal call order for the script: inbox.append #1..#4 = m1..m4; outbox.put #1..#5 =
 * the five replies in EXPECTED order (markSent likewise); inbox.ack #1..#4 = m1..m4.
 */
export const CRASH_POINTS: CrashPoint[] = [
  { name: 'before the inbound is journaled', arm: { when: 'before', op: 'inbox.append', nth: 3 } },
  { name: 'right after the inbound is journaled', arm: { when: 'after', op: 'inbox.append', nth: 3 } },
  { name: 'mid-handler (between two replies)', midHandler: true },
  { name: 'after the outbox record, before the provider call', arm: { when: 'after', op: 'outbox.put', nth: 4 }, ambiguousText: '¿Ciudad?' },
  { name: 'after the provider send, before it is recorded', arm: { when: 'before', op: 'outbox.markSent', nth: 4 }, ambiguousText: '¿Ciudad?' },
  { name: 'after the send is recorded', arm: { when: 'after', op: 'outbox.markSent', nth: 4 } },
  { name: 'after the conversation checkpoint, before the ack', arm: { when: 'before', op: 'inbox.ack', nth: 3 } },
  { name: 'after the ack', arm: { when: 'after', op: 'inbox.ack', nth: 3 } },
  { name: 'first reply of the flow, before recorded', arm: { when: 'before', op: 'outbox.markSent', nth: 3 }, ambiguousText: '¿Nombre?' },
  { name: 'last reply, after recorded', arm: { when: 'after', op: 'outbox.markSent', nth: 5 } },
]

function silentLogger(): unknown {
  const noop = () => {}
  const l: Record<string, unknown> = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, level: 'silent' }
  l.child = () => l
  return l
}

async function until(cond: () => Promise<boolean> | boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const never = () => new Promise<never>(() => {})
const textsOf = (p: ProviderLike) => p.outbox.filter((m) => m.chatId === CHAT).map((m) => m.content.text ?? m.content.kind)

/** Run one crash scenario; resolves with the delivered texts (A ∪ B) and the ambiguous count. */
export async function runCrashScenario(
  deps: CrashMatrixDeps,
  harness: CrashMatrixHarness,
  point: CrashPoint,
  policy: 'skip' | 'resend',
): Promise<{ delivered: string[]; ambiguous: number; inboxStates: string[]; outboxStates: string[] }> {
  const { backend: shared, teardown } = await harness.make()
  const store = new deps.MemoryStore()
  const durability = (journal: Backend) => ({
    journal, instanceId: 'replica-1', pollMs: 20,
    outbox: { onAmbiguous: policy, backoff: () => 5 },
    inbox: { backoff: () => 5 },
  })
  let ambiguous = 0

  const a = deps.crashable(shared)
  if (point.arm) (point.arm.when === 'before' ? a.crashBefore : a.crashAfter).call(a, point.arm.op, point.arm.nth)
  const pa = new deps.CrashableProvider(a)
  const define = (bot: BotLike, isA: boolean) => {
    bot.on('error', () => {})
    bot.on('durability:ambiguous', () => { ambiguous++ })
    bot.when('hola', async (ctx: CtxLike) => {
      await ctx.reply('hola!')
      if (isA && point.midHandler) { a.crash(); return never() }
      await ctx.reply('¿qué tal?')
    })
    bot.when('pedido', deps.flow('pedido').persistent()
      .ask('¿Nombre?', 'name')
      .ask('¿Ciudad?', 'city')
      .say((_ctx, c) => `Listo ${String(c.state.name)} de ${String(c.state.city)}`))
  }

  const botA = new deps.Bot({ provider: pa, store, logger: silentLogger(), durability: durability(a) })
  define(botA, true)
  await botA.start()
  // The bot keeps its records in its namespace's view of the backend.
  const scope = botA.durability?.scope
  const view = scope !== undefined && shared.scope ? shared.scope(scope) : shared

  // Drive A one message at a time until it dies.
  let inFlight = -1
  for (let i = 0; i < SCRIPT.length; i++) {
    const [body, id] = SCRIPT[i]
    pa.incoming(body, { from: CHAT, id })
    const done = until(async () => a.crashed || (await view.inbox.list({ state: 'done' })).length >= i + 1, `A to process ${id}`)
    await Promise.race([done, a.whenCrashed])
    if (a.crashed) { inFlight = i; break }
  }
  expect(a.crashed, `the crash point "${point.name}" never fired`).toBe(true)

  // Restart: B on the same backend + store, same instanceId; the transport redelivers.
  const pb = new deps.MockProvider()
  const botB = new deps.Bot({ provider: pb, store, logger: silentLogger(), durability: durability(shared) })
  define(botB, false)
  await botB.start()
  const settledAll = async () => {
    const open = (await view.inbox.list()).filter((r) => r.state !== 'done')
    const sending = (await view.outbox.list()).filter((r) => r.state === 'pending' || r.state === 'sending' || r.state === 'failed')
    return open.length === 0 && sending.length === 0
  }
  for (let i = inFlight; i < SCRIPT.length; i++) {
    const [body, id] = SCRIPT[i]
    pb.incoming(body, { from: CHAT, id })
    await until(async () => (await view.inbox.list({ state: 'done' })).length >= i + 1 && await settledAll(), `B to process ${id}`)
  }
  await new Promise((r) => setTimeout(r, 30)) // let any stray duplicate surface

  const result = {
    delivered: [...textsOf(pa), ...textsOf(pb)],
    ambiguous,
    inboxStates: (await view.inbox.list()).map((r) => r.state),
    outboxStates: (await view.outbox.list()).map((r) => r.state),
  }
  await botB.stop()
  await teardown()
  return result
}

/** The full matrix: every crash point × both ambiguity policies. */
export function runCrashRecoveryMatrix(name: string, deps: CrashMatrixDeps, harness: CrashMatrixHarness, points: CrashPoint[] = CRASH_POINTS): void {
  describe(`${name} — crash recovery`, () => {
    for (const point of points) {
      for (const policy of ['skip', 'resend'] as const) {
        it(`${point.name} (${policy})`, async () => {
          const r = await runCrashScenario(deps, harness, point, policy)
          expect(r.inboxStates.every((s) => s === 'done')).toBe(true)
          expect(r.outboxStates.every((s) => s === 'sent' || s === 'unknown')).toBe(true)
          for (const text of EXPECTED) {
            const n = r.delivered.filter((t) => t === text).length
            if (text === point.ambiguousText) {
              expect(r.ambiguous).toBeGreaterThanOrEqual(1)
              if (policy === 'skip') expect(n, `${text} at most once`).toBeLessThanOrEqual(1)
              else expect(n, `${text} at least once`).toBeGreaterThanOrEqual(1)
            } else {
              expect(n, `"${text}" delivered ${n} times: ${JSON.stringify(r.delivered)}`).toBe(1)
            }
          }
          expect(r.delivered.filter((t) => !EXPECTED.includes(t))).toEqual([])
        }, 20_000)
      }
    }
  })
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Seeded random crash points over every journal write of the script. */
export function randomCrashPoints(seed: number, count: number): CrashPoint[] {
  const ops: Array<[string, number]> = [['inbox.append', 4], ['outbox.put', 5], ['outbox.markSent', 5], ['inbox.ack', 4]]
  const sendOrder = EXPECTED
  const rnd = prng(seed)
  const points: CrashPoint[] = []
  for (let i = 0; i < count; i++) {
    const [op, max] = ops[Math.floor(rnd() * ops.length)]
    const nth = 1 + Math.floor(rnd() * max)
    const when = rnd() < 0.5 ? 'before' : 'after'
    // A crash between "sending" recorded and "sent" recorded is the ambiguous window.
    const ambiguous = (op === 'outbox.put' && when === 'after') || (op === 'outbox.markSent' && when === 'before')
    points.push({ name: `seed ${seed}#${i}: ${when} ${op} #${nth}`, arm: { when, op, nth }, ...(ambiguous ? { ambiguousText: sendOrder[nth - 1] } : {}) })
  }
  return points
}
