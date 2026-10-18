/**
 * Flow DSL wave: `.use(subFlow)`, `choose` children + `goto` back, `.guard()`, schema validation
 * (zod-compatible `safeParse`, no zod dependency), full `.media(kind, …)`, per-step delays and
 * typed flow state. `expectTypeOf` / `@ts-expect-error` lines are enforced by `pnpm typecheck`.
 */
import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { ConversationRuntime } from '../src/conversations/ConversationRuntime.js'
import { createControls } from '../src/conversations/controls.js'
import { flowToConversation } from '../src/conversations/interpreter.js'
import {
  flow,
  describeFlows,
  lintFlows,
  type FlowStateOf,
  type SchemaLike,
  type SchemaParseResult,
  type ConversationControls,
  RetryUnavailableError,
} from '../src/index.js'

/** Texts passed to a `reply` mock (controls also pass pacing options as a 2nd argument). */
const texts = (fn: { mock: { calls: unknown[][] } }): unknown[] => fn.mock.calls.map((c) => c[0])

/* ---------------------------------------------------------------------------
 * A tiny zod look-alike: the real zod v3 SafeParseReturnType shape, no dependency.
 * ------------------------------------------------------------------------ */

interface FakeIssue { message: string; path: Array<string | number> }
class FakeZodError { constructor(readonly issues: FakeIssue[]) {} get message() { return JSON.stringify(this.issues) } }
type FakeSafeParse<O> = { success: true; data: O; error?: never } | { success: false; error: FakeZodError; data?: never }
class FakeSchema<O> {
  constructor(private parse: (input: unknown) => { ok: true; value: O } | { ok: false; message: string }) {}
  safeParse(data: unknown, _params?: { path?: string[] }): FakeSafeParse<O> {
    const r = this.parse(data)
    return r.ok ? { success: true, data: r.value } : { success: false, error: new FakeZodError([{ message: r.message, path: [] }]) }
  }
}
const z = {
  number: (min: number, message: string) => new FakeSchema<number>((i) => {
    const n = Number(i)
    if (typeof i !== 'string' || i.trim() === '' || !Number.isFinite(n)) return { ok: false, message: 'Debe ser un número' }
    return n >= min ? { ok: true, value: n } : { ok: false, message }
  }),
  email: (message: string) => new FakeSchema<string>((i) =>
    typeof i === 'string' && /^\S+@\S+\.\S+$/.test(i) ? { ok: true, value: i.toLowerCase() } : { ok: false, message }),
  enum: <const T extends readonly string[]>(values: T) => new FakeSchema<T[number]>((i) =>
    values.includes(String(i).toUpperCase()) ? { ok: true, value: String(i).toUpperCase() as T[number] } : { ok: false, message: 'Invalid enum value' }),
}

const msg = (body: string, type = 'text') => ({
  from: 'a@s', sender: 'a@s', body, type, isGroup: false, reply: vi.fn(async (_t: string) => {}),
})
const makeRt = () => new ConversationRuntime({ controlsFactory: (rt, handle, ctx) => createControls(rt, handle, ctx) })

/* ============================================================================
 * .use(subFlow) and choose children
 * ========================================================================== */

describe('flow().use(subFlow)', () => {
  it('runs the sub-flow inline, merges its state and returns to the parent', async () => {
    const { bot, chat } = await createTestBot()
    const direccion = flow('direccion').ask('¿Calle?', 'calle').ask('¿Ciudad?', 'ciudad')
    bot.use(
      flow('pedido')
        .say('Vamos con el envío')
        .use(direccion)
        .say((_ctx, c) => `Envío a ${c.state.calle}, ${c.state.ciudad}`),
    )
    await chat.send('pedido')
    await chat.expectReply('¿Calle?')
    await chat.send('Calle 1')
    await chat.expectReply('¿Ciudad?')
    await chat.send('Bogotá')
    await chat.expectReply('Envío a Calle 1, Bogotá')
    expect(chat.replies()).toEqual(['Vamos con el envío', '¿Calle?', '¿Ciudad?', 'Envío a Calle 1, Bogotá'])
  })

  it('snapshots the sub-flow at .use() time and supports nested use', async () => {
    const rt = makeRt()
    const inner = flow('inner').say('inner')
    const middle = flow('middle').say('middle-in').use(inner).say('middle-out')
    const f = flow('outer').use(middle).say('outer-out').compile()
    inner.say('added later')   // must not leak into the already-used snapshot
    const start = msg('outer')
    await rt.enter(flowToConversation(f), start)
    expect(start.reply.mock.calls.map((c) => c[0])).toEqual(['middle-in', 'inner', 'middle-out', 'outer-out'])
  })

  it('c.retry() inside a used sub-flow rewinds to the sub-flow ask', async () => {
    const rt = makeRt()
    const sub = flow('sub').ask('¿Código?', 'code').do((_ctx, c) => { if (c.state.code !== 'ok') c.retry('Código inválido') })
    const f = flow('p').use(sub).say((_ctx, c) => `listo ${c.state.code}`).compile()
    const start = msg('p')
    const run = rt.enter(flowToConversation(f), start)
    await vi.waitFor(() => expect(texts(start.reply)).toContain('¿Código?'))
    rt.deliver(msg('mal'))
    await vi.waitFor(() => expect(texts(start.reply)).toContain('Código inválido'))
    rt.deliver(msg('ok'))
    await run
    expect(start.reply.mock.calls.at(-1)?.[0]).toBe('listo ok')
  })

  it('c.retry() in a parent step after .use() re-runs the returned sub-flow', async () => {
    const { bot, chat } = await createTestBot()
    const errors: unknown[] = []
    bot.on('error', (e) => { errors.push(e) })
    bot.use(
      flow('reg')
        .say('hola')
        .use(flow('sub').ask('¿Email?', 'email'))
        .do((_ctx, c) => { if (!String(c.state.email).includes('@')) c.retry('mal email') })
        .say((_ctx, c) => `ok ${String(c.state.email)}`),
    )
    await chat.send('reg')
    await chat.expectReply('¿Email?')
    await chat.send('nope')
    await chat.expectReply('mal email')
    await chat.send('a@b.co')
    await chat.expectReply('ok a@b.co')
    expect(chat.replies()).toEqual(['hola', '¿Email?', 'mal email', 'ok a@b.co'])
    expect(errors).toEqual([])
  })

  it('a retry after .use() shares the sub-flow wait budget', async () => {
    const onError = vi.fn()
    const rt = new ConversationRuntime({ controlsFactory: (r, handle, ctx) => createControls(r, handle, ctx), onError })
    const sub = flow('sub').ask('¿Email?', 'email', { retries: 2 })
    const f = flow('p').use(sub).do((_ctx, c) => { c.retry('mal') }).compile()
    const start = msg('p')
    const run = rt.enter(flowToConversation(f), start)
    await vi.waitFor(() => expect(texts(start.reply)).toContain('¿Email?'))
    rt.deliver(msg('x'))
    await vi.waitFor(() => expect(texts(start.reply)).toContain('mal'))
    rt.deliver(msg('y'))
    await run
    // Two retries consume the sub-flow ask's budget of 2 → the "too many attempts" ending.
    expect(onError).not.toHaveBeenCalled()
    expect(start.reply.mock.calls.map((c) => c[0])).toEqual(['¿Email?', 'mal', '❌ Demasiados intentos. Conversación terminada.'])
  })

  it('a retry after a wait-less .use() step is still unavailable', async () => {
    const onError = vi.fn()
    const rt = new ConversationRuntime({ controlsFactory: (r, handle, ctx) => createControls(r, handle, ctx), onError })
    const f = flow('p').use(flow('sub').say('hi')).do((_ctx, c) => { c.retry('x') }).compile()
    await rt.enter(flowToConversation(f), msg('p'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(RetryUnavailableError)
  })
})

describe('choose() children and going back', () => {
  it('a then sub-flow shares c.state with the parent', async () => {
    const rt = makeRt()
    const datos = flow('datos').ask('¿Nombre?', 'nombre')
    const f = flow('menu')
      .choose('Elige:', { registro: { label: 'Registro', then: datos }, nada: 'Nada' }, 'opcion')
      .say((_ctx, c) => `${c.state.opcion}:${String(c.state.nombre)}`)
      .compile()
    const start = msg('menu')
    const run = rt.enter(flowToConversation(f), start)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalled())
    rt.deliver(msg('1'))
    await vi.waitFor(() => expect(texts(start.reply)).toContain('¿Nombre?'))
    rt.deliver(msg('Ana'))
    await run
    expect(start.reply.mock.calls.at(-1)?.[0]).toBe('registro:Ana')
  })

  it('an option goto leaves the sub-menu and goes back to the main menu', async () => {
    const { bot, chat } = await createTestBot()
    const main = flow('menu').id('menu').choose('Menú principal', { juegos: { label: 'Juegos', goto: 'juegos' }, salir: 'Salir' })
      .say('Adiós')
    const juegos = flow([]).id('juegos')
      .choose('Juegos', { triqui: { label: 'Triqui', then: flow([]).say('Jugando triqui') }, volver: { label: 'Volver', goto: main } })
      .say('fin juegos')
    bot.use([main, juegos])
    await chat.send('menu')
    await chat.expectReply('Menú principal')
    await chat.send('1')
    await chat.expectReply('Juegos')
    await chat.send('2')   // volver → goto menu
    await chat.expectReply('Menú principal')
    await chat.send('2')
    await chat.expectReply('Adiós')
    expect(chat.replies()).not.toContain('fin juegos')
  })

  it('an option with then + goto runs the then first, then jumps', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow([]).id('destino').say('en destino'))
    bot.use(flow('ir').choose('¿Ir?', { si: { label: 'Sí', then: (_ctx, c) => c.say('saliendo'), goto: 'destino' } }).say('nunca'))
    await chat.send('ir')
    await chat.send('1')
    await chat.expectReply('saliendo')
    await chat.expectReply('en destino')
    expect(chat.replies()).not.toContain('nunca')
  })
})

/* ============================================================================
 * .guard()
 * ========================================================================== */

describe('flow().guard()', () => {
  it('continues when the predicate passes', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('soporte').guard(() => true, 'cerrado').say('¿En qué te ayudo?'))
    await chat.send('soporte')
    await chat.expectReply('¿En qué te ayudo?')
  })

  it('sends the message and ends the conversation when it fails', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('soporte').guard(async () => false, 'Fuera de horario, vuelve mañana').say('¿En qué te ayudo?'))
    await chat.send('soporte')
    await chat.expectReply('Fuera de horario')
    await new Promise((r) => setTimeout(r, 20))
    expect(chat.replies()).toEqual(['Fuera de horario, vuelve mañana'])
    // The conversation is over: a new message is not captured by it.
    bot.when('otra', (ctx) => ctx.reply('libre'))
    await chat.send('otra')
    await chat.expectReply('libre')
  })

  it('redirects to another conversation (with an optional message)', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow([]).id('no-permiso').say('No tienes permiso'))
    bot.use(flow('admin').guard((ctx) => ctx.sender === 'admin', { redirect: 'no-permiso', message: 'Verificando…' }).say('Panel'))
    await chat.send('admin')
    await chat.expectReply('Verificando…')
    await chat.expectReply('No tienes permiso')
    expect(chat.replies()).not.toContain('Panel')
  })

  it('reads typed state and supports a dynamic message; no message ends silently', async () => {
    const rt = makeRt()
    const f = flow('edad')
      .ask('¿Edad?', 'edad', { schema: z.number(0, 'no') })
      .guard((_ctx, c) => c.state.edad >= 18, (_ctx, c) => `Con ${c.state.edad} no puedes`)
      .say('bienvenido')
      .compile()
    const start = msg('edad')
    const run = rt.enter(flowToConversation(f), start)
    await vi.waitFor(() => expect(texts(start.reply)).toContain('¿Edad?'))
    rt.deliver(msg('15'))
    await run
    expect(start.reply.mock.calls.at(-1)?.[0]).toBe('Con 15 no puedes')

    const silent = flow('s').guard(() => 0).say('nope').compile()
    const s = msg('s')
    await rt.enter(flowToConversation(silent), s)
    expect(s.reply).not.toHaveBeenCalled()
  })
})

/* ============================================================================
 * Schema validation
 * ========================================================================== */

describe('schema validation in ask()/waitText()', () => {
  it('stores the parsed value and re-prompts with the issue message', async () => {
    const { bot, chat } = await createTestBot()
    const seen: unknown[] = []
    bot.use(
      flow('registro')
        .ask('¿Tu email?', 'email', { schema: z.email('Email inválido') })
        .ask('¿Tu edad?', 'edad', { schema: z.number(18, 'Debes ser mayor') })
        .do((_ctx, c) => { seen.push(c.state.email, c.state.edad, typeof c.state.edad) }),
    )
    await chat.send('registro')
    await chat.expectReply('¿Tu email?')
    await chat.send('nope')
    await chat.expectReply('Email inválido')
    await chat.send('ANA@X.CO')
    await chat.expectReply('¿Tu edad?')
    await chat.send('abc')
    await chat.expectReply('Debe ser un número')
    await chat.send('12')
    await chat.expectReply('Debes ser mayor')
    await chat.send('30')
    await vi.waitFor(() => expect(seen).toEqual(['ana@x.co', 30, 'number']))
  })

  it('otherwise wins over the schema message; validate runs first', async () => {
    const rt = makeRt()
    const f = flow('pais')
      .ask('¿País?', 'pais', {
        schema: z.enum(['CO', 'MX']),
        otherwise: 'País no soportado. Opciones: CO, MX',
        validate: (b) => b.length === 2 || 'Usa el código de 2 letras',
      })
      .compile()
    const start = msg('pais')
    const run = rt.enter(async (c, ctx) => {
      await flowToConversation(f)(c, ctx)
      expect((c as ConversationControls).state.pais).toBe('MX')
    }, start)
    await vi.waitFor(() => expect(texts(start.reply)).toContain('¿País?'))
    rt.deliver(msg('Colombia'))
    await vi.waitFor(() => expect(texts(start.reply)).toContain('Usa el código de 2 letras'))
    rt.deliver(msg('AR'))
    await vi.waitFor(() => expect(texts(start.reply)).toContain('País no soportado. Opciones: CO, MX'))
    rt.deliver(msg('mx'))
    await run
  })

  it('c.ask / c.waitText return the parsed value in async conversations', async () => {
    const { bot, chat } = await createTestBot()
    bot.conversation('calc', async (c, ctx) => {
      const a = await c.ask('¿A?', { schema: z.number(0, 'positivo') })
      expectTypeOf(a).toEqualTypeOf<number>()
      await ctx.reply('¿B?')
      const b = await c.waitText({ schema: z.number(0, 'positivo') })
      expectTypeOf(b).toEqualTypeOf<number>()
      const plain = () => c.waitText({ timeout: '1m' })
      expectTypeOf(plain).returns.toEqualTypeOf<Promise<string>>()
      await ctx.reply(`= ${a + b}`)
    }, { trigger: 'calc' })
    await chat.send('calc')
    await chat.expectReply('¿A?')
    await chat.send('-1')
    await chat.expectReply('positivo')
    await chat.send('2')
    await chat.expectReply('¿B?')
    await chat.send('3')
    await chat.expectReply('= 5')
  })

  it('accepts any safeParse object, prefers safeParseAsync and never shows a JSON error dump', async () => {
    const sync = vi.fn((): SchemaParseResult<string> => ({ success: true, data: 'sync' }))
    const asyncSchema: SchemaLike<string> = {
      safeParse: sync,
      safeParseAsync: async (i) => (i === 'si' ? { success: true, data: 'async' } : { success: false, error: { message: '[{"code":"custom"}]' } }),
    }
    const rt = makeRt()
    const f = flow('x').ask('¿?', 'v', { schema: asyncSchema }).say((_ctx, c) => `v=${c.state.v}`).compile()
    const start = msg('x')
    const run = rt.enter(flowToConversation(f), start)
    await vi.waitFor(() => expect(texts(start.reply)).toContain('¿?'))
    rt.deliver(msg('no'))
    await vi.waitFor(() => expect(texts(start.reply)).toContain('❌ Entrada inválida, intenta de nuevo.'))
    rt.deliver(msg('si'))
    await run
    expect(start.reply.mock.calls.at(-1)?.[0]).toBe('v=async')
    expect(sync).not.toHaveBeenCalled()
  })

  it('schema rejections share the retries budget', async () => {
    const { bot, chat } = await createTestBot({ conversation: { retriesMessage: 'Demasiados intentos' } })
    bot.use(flow('n').ask('¿N?', 'n', { schema: z.number(0, 'mal'), retries: 2 }).say('ok'))
    await chat.send('n')
    await chat.send('x')
    await chat.expectReply('Debe ser un número')
    await chat.send('y')
    await chat.expectReply('Demasiados intentos')
  })
})

/* ============================================================================
 * .media(kind, source, caption?, opts?)
 * ========================================================================== */

describe('flow().media()', () => {
  it('sends every kind through the matching ctx helper', async () => {
    const { bot, provider, chat } = await createTestBot()
    bot.use(
      flow('demo')
        .media('image', 'https://x.test/a.png')
        .media('video', './demo.mp4', 'Mira esto', { ptv: true })
        .media('audio', './nota.ogg')
        .media('voice', './voz.ogg', 'nota de voz')
        .media('document', './factura.pdf', 'Tu factura', { filename: 'factura.pdf' })
        .media('sticker', { path: './s.webp' })
        .media('location', { lat: 4.71, lng: -74.07 }, 'Bogotá')
        .media('legacy.png', 'legado')
        .media('image', (_ctx, c) => `https://x.test/${String(c.state.foto ?? 'dyn')}.png`),
    )
    await chat.send('demo')
    await vi.waitFor(() => expect(provider.outbox.length).toBeGreaterThanOrEqual(10))
    expect(provider.outbox.map((m) => m.content)).toEqual([
      { kind: 'image', media: 'https://x.test/a.png', caption: undefined },
      { kind: 'video', media: './demo.mp4', caption: 'Mira esto', ptv: true, gifPlayback: undefined },
      { kind: 'audio', media: './nota.ogg' },
      { kind: 'voice', media: './voz.ogg' },
      { kind: 'text', text: 'nota de voz' },
      { kind: 'document', media: './factura.pdf', filename: 'factura.pdf', caption: 'Tu factura' },
      { kind: 'sticker', media: { path: './s.webp' }, pack: undefined, author: undefined },
      { kind: 'location', lat: 4.71, lng: -74.07, name: 'Bogotá' },
      { kind: 'image', media: 'legacy.png', caption: 'legado' },
      { kind: 'image', media: 'https://x.test/dyn.png', caption: undefined },
    ])
  })

  it('rejects a location source for a file kind at runtime', async () => {
    const rt = makeRt()
    const ctx = { ...msg('m'), photo: vi.fn(async () => {}) }
    const f = flow('m').media('image', (() => ({ lat: 1, lng: 2 })) as unknown as () => string).compile()
    const onError = vi.fn()
    const rt2 = new ConversationRuntime({ onError, controlsFactory: (r, h, c) => createControls(r, h, c) })
    await rt2.enter(flowToConversation(f), ctx)
    expect(onError).toHaveBeenCalled()
    expect(ctx.photo).not.toHaveBeenCalled()
    void rt
  })
})

/* ============================================================================
 * Delays
 * ========================================================================== */

describe('per-step delays', () => {
  it('say/media/ask { delay } and .delay() pause before the step', async () => {
    vi.useFakeTimers()
    try {
      const rt = makeRt()
      const ctx = { ...msg('d'), photo: vi.fn(async () => {}) }
      const f = flow('d')
        .say('uno')
        .say('dos', { delay: '2s' })
        .delay(1000)
        .media('image', 'x.png', undefined, { delay: 500 })
        .ask('¿tres?', 'tres', { delay: '1s' })
        .compile()
      const run = rt.enter(flowToConversation(f), ctx)
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.reply.mock.calls.map((c) => c[0])).toEqual(['uno'])
      await vi.advanceTimersByTimeAsync(1999)
      expect(ctx.reply).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(ctx.reply.mock.calls.at(-1)?.[0]).toBe('dos')
      await vi.advanceTimersByTimeAsync(1499)
      expect(ctx.photo).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(ctx.photo).toHaveBeenCalledWith('x.png', undefined)
      await vi.advanceTimersByTimeAsync(1000)
      expect(ctx.reply.mock.calls.at(-1)?.[0]).toBe('¿tres?')
      rt.deliver(msg('3'))
      await vi.advanceTimersByTimeAsync(0)
      await run
    } finally {
      vi.useRealTimers()
    }
  })

  it('a conversation aborted during a delay sends nothing afterwards', async () => {
    vi.useFakeTimers()
    try {
      const rt = makeRt()
      const ctx = { ...msg('d'), photo: vi.fn(async () => {}) }
      const f = flow('d').media('image', 'late.png', undefined, { delay: '1s' }).say('tarde', { delay: 10 }).compile()
      const run = rt.enter(flowToConversation(f), ctx)
      await vi.advanceTimersByTimeAsync(10)
      rt.abort(rt.keyFor(ctx))
      await vi.advanceTimersByTimeAsync(2000)
      await run
      expect(ctx.photo).not.toHaveBeenCalled()
      expect(texts(ctx.reply)).not.toContain('tarde')
    } finally {
      vi.useRealTimers()
    }
  })

  it('abort/abortAll during a delay cancels the timer and unwinds right away', async () => {
    vi.useFakeTimers()
    try {
      const rt = makeRt()
      const ctx = msg('d')
      const after = vi.fn()
      const f = flow('d').say('hi').delay('1h').do(after).compile()
      let settled = false
      const run = rt.enter(flowToConversation(f), ctx).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(50)
      expect(vi.getTimerCount()).toBe(1)
      rt.abortAll()
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      await run
      expect(after).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bot.stop() during a delay leaves no timer behind', async () => {
    vi.useFakeTimers()
    try {
      const { bot, chat } = await createTestBot()
      const after = vi.fn()
      bot.use(flow('d').say('hi').delay('3s').do(after))
      const sent = chat.send('d')
      await vi.advanceTimersByTimeAsync(50)
      await sent
      expect(chat.replies()).toEqual(['hi'])
      await bot.stop()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(after).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an invalid delay at build time', () => {
    expect(() => flow('x').say('a', { delay: '2 minutos' })).toThrow(/Invalid duration/)
    expect(() => flow('x').delay(-5)).toThrow(/Invalid flow delay/)
    // Longer than a Node timer can hold (2^31-1 ms): it would otherwise fire after ~1 ms.
    expect(() => flow('x').delay('600h')).toThrow(/Invalid flow delay/)
    expect(() => flow('x').say('a', { delay: 2_147_483_648 })).toThrow(/Invalid flow delay/)
    expect(() => flow('x').delay(2_147_483_647)).not.toThrow()
  })
})

/* ============================================================================
 * Typed state
 * ========================================================================== */

describe('typed flow state', () => {
  it('infers c.state progressively from ask/choose/use without casts', () => {
    const direccion = flow('direccion').ask('¿Calle?', 'calle').ask('¿Piso?', 'piso', { schema: z.number(0, 'x') })
    expectTypeOf<FlowStateOf<typeof direccion>>().toEqualTypeOf<{ calle: string; piso: number }>()

    const registro = flow<{ plan: 'free' | 'pro' }>('registro')
      .ask('¿Nombre?', 'nombre')
      .ask('¿Edad?', 'edad', { schema: z.number(18, 'x') })
      .choose('¿País?', { co: 'Colombia', mx: 'México' }, 'pais')
      .choose('¿Seguro?', { si: 'Sí', no: 'No' })
      .use(direccion)
      .do((_ctx, c) => {
        expectTypeOf(c.state.nombre).toEqualTypeOf<string>()
        expectTypeOf(c.state.edad).toEqualTypeOf<number>()
        expectTypeOf(c.state.plan).toEqualTypeOf<'free' | 'pro'>()
        expectTypeOf(c.state.pais).toEqualTypeOf<'co' | 'mx'>()
        expectTypeOf(c.state.choice).toEqualTypeOf<'si' | 'no'>()
        expectTypeOf(c.state.piso).toEqualTypeOf<number>()
        expectTypeOf(c.state.otraCosa).toEqualTypeOf<unknown>()
        // @ts-expect-error — edad is a number, not a string
        c.state.edad.toUpperCase()
        c.state.extra = 1   // undeclared keys stay writable (unknown)
      })
      .say((_ctx, c) => `${c.state.nombre} tiene ${c.state.edad + 1}`)
      .guard((_ctx, c) => c.state.edad > 0)

    // Re-asking a key replaces its type instead of intersecting it.
    const again = flow('x').ask('a', 'v').ask('b', 'v', { schema: z.number(0, 'x') })
    expectTypeOf<FlowStateOf<typeof again>>().toEqualTypeOf<{ v: number }>()

    // A non-literal (`string`) key cannot be tracked: earlier keys keep their types.
    const dynKey: string = 'dyn'
    const dynamic = flow('dyn')
      .ask('edad?', 'edad', { schema: z.number(0, 'x') })
      .ask('q', dynKey)
      .choose('p', { a: 'A' }, dynKey)
      .do((_ctx, c) => { expectTypeOf(c.state.edad).toEqualTypeOf<number>() })
    expectTypeOf<FlowStateOf<typeof dynamic>>().toEqualTypeOf<{ edad: number }>()

    // Typed builders are accepted everywhere a flow is.
    expect(() => registro.compile()).not.toThrow()
    const typedHandler = flow('t').ask('a', 'a').choose('p', { x: { label: 'X', then: registro }, y: { label: 'Y', goto: registro } })
    expect(typedHandler.compile().steps).toHaveLength(2)
  })

  it('typed builders register with bot.use / bot.when', async () => {
    const { bot, chat } = await createTestBot()
    const typed = flow('edad').ask('¿Edad?', 'edad', { schema: z.number(0, 'x') }).say((_ctx, c) => `doble ${c.state.edad * 2}`)
    bot.use(typed)
    bot.when('edad2', typed)
    await chat.send('edad')
    await chat.send('21')
    await chat.expectReply('doble 42')
  })
})

/* ============================================================================
 * Introspection: describe / lint
 * ========================================================================== */

describe('describe/lint for the new step kinds', () => {
  const sub = flow('sub').ask('¿Ciudad?', 'ciudad', { timeout: '1m' })
  const main = flow('main')
    .timeout('2m')
    .guard(function esHorario() { return true }, { redirect: 'cerrado' })
    .say('hola', { delay: '2s' })
    .delay(500)
    .ask('¿Edad?', 'edad', { schema: z.number(0, 'x') })
    .media('document', './f.pdf', 'Factura')
    .media('location', { lat: 1, lng: 2, name: 'Sede' })
    .use(sub)
    .choose('Menú', { otra: { label: 'Otra', goto: 'otra' }, fin: 'Fin' })
    .say('bye')
  const cerrado = flow([]).id('cerrado').say('cerrado')
  const otra = flow([]).id('otra').say('otra')

  it('draws guard, delay, media kinds, use groups and option gotos', () => {
    const graph = describeFlows([main, cerrado, otra], { format: 'json' })
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
    expect(nodes.get('f0_s0')).toMatchObject({ kind: 'guard', action: 'esHorario', redirect: 'cerrado' })
    expect(nodes.get('f0_s1')).toMatchObject({ kind: 'say', delayMs: 2000 })
    expect(nodes.get('f0_s2')).toMatchObject({ kind: 'delay', delayMs: 500 })
    expect(nodes.get('f0_s3')).toMatchObject({ kind: 'ask', schema: true, stateKey: 'edad' })
    expect(nodes.get('f0_s4')).toMatchObject({ kind: 'media', media: { type: 'document', source: './f.pdf', caption: 'Factura' } })
    expect(nodes.get('f0_s5')).toMatchObject({ kind: 'media', media: { type: 'location', source: '1, 2 (Sede)' } })
    expect(nodes.get('f0_s6')).toMatchObject({ kind: 'use', subflow: 'sub' })
    expect(nodes.get('f0_s6_u_s0')).toMatchObject({ kind: 'ask', stateKey: 'ciudad', path: 'steps[6].flow.steps[0]' })
    expect(graph.groups).toContainEqual(expect.objectContaining({ id: 'f0_s6_u', via: 'use', subflow: 'sub' }))
    expect(nodes.get('f0_s7')?.options?.[0]).toMatchObject({ key: 'otra', goto: 'otra' })
    expect(nodes.get('f0_s7_g0')).toMatchObject({ kind: 'goto', target: 'otra' })
    expect(graph.edges).toContainEqual({ from: 'f0_s6', to: 'f0_s6_u_s0', kind: 'next' })
    expect(graph.edges).toContainEqual({ from: 'f0_s6_u_s0', to: 'f0_s7', kind: 'return' })
    expect(graph.edges).toContainEqual({ from: 'f0_s0', to: 'f1_in', kind: 'goto' })
    expect(graph.edges).toContainEqual({ from: 'f0_s7_g0', to: 'f2_in', kind: 'goto' })
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'f0_s7', to: 'f0_s8', kind: 'option', option: 'fin' }))

    const mermaid = describeFlows([main, cerrado, otra])
    expect(mermaid).toContain('f0_s0{{"guard: esHorario() ✗→ cerrado"}}')
    expect(mermaid).toContain('f0_s1["say: hola ⏳ 2s"]')
    expect(mermaid).toContain('f0_s2("delay: 500ms")')
    expect(mermaid).toContain('f0_s4["media (document): ./f.pdf — Factura"]')
    expect(mermaid).toContain('subgraph f0_s6_u ["use: sub"]')
    expect(mermaid).toContain('f0_s0 -.-> f1_in')
  })

  it('lint follows guard redirects and option gotos', () => {
    const ok = lintFlows([main, cerrado, otra])
    expect(ok.filter((d) => d.code === 'goto-target-missing')).toEqual([])
    expect(ok.filter((d) => d.code === 'unreachable-flow' && d.severity === 'warning')).toEqual([])

    const broken = lintFlows([main])
    const missing = broken.filter((d) => d.code === 'goto-target-missing')
    expect(missing.map((d) => d.path)).toEqual(['steps[0]', 'steps[7].options["otra"].goto'])
    expect(missing[0].message).toContain('guard redirect "cerrado"')
  })

  it('lint sees asks inside a used sub-flow', () => {
    const f = flow('a').use(flow('b').ask('¿x?', 'x'))
    const d = lintFlows([f]).find((x) => x.code === 'missing-timeout')
    expect(d).toMatchObject({ path: 'steps[0].flow.steps[0]' })
  })
})
