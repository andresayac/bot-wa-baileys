import { describe, it, expect, vi } from 'vitest'
import { ConversationRuntime, type RuntimeConfig, type RuntimeMessage } from '../src/conversations/ConversationRuntime.js'
import { createControls, type ConversationControls } from '../src/conversations/controls.js'
import { ConversationError, RetriesExceeded } from '../src/conversations/errors.js'
import { ConversationRetry, RetryUnavailableError } from '../src/conversations/retry.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'

function makeMsg(body: string, type = 'text') {
  return { from: 'a@s.whatsapp.net', sender: 'a@s.whatsapp.net', body, type, isGroup: false, reply: vi.fn(async (_t: string) => {}) }
}
function makeRt(cfg: RuntimeConfig = {}) {
  return new ConversationRuntime({ ...cfg, controlsFactory: (rt, handle, ctx) => createControls(rt, handle, ctx) })
}
type Conv = (c: ConversationControls, ctx: RuntimeMessage) => Promise<void>
const enter = (rt: ConversationRuntime, fn: Conv, start: RuntimeMessage) => rt.enter(fn as never, start)

describe('c.retry() — async conversations (in place)', () => {
  it('re-sends the ask question and resolves with the next answer', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let letter = ''
    const entry = enter(rt, async (c) => {
      letter = await c.ask('Escribe una letra')
      while (letter.length !== 1) letter = await c.retry()
    }, start)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('Escribe una letra'))
    rt.deliver(makeMsg('abc'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledTimes(2))
    expect(start.reply).toHaveBeenNthCalledWith(2, 'Escribe una letra')
    rt.deliver(makeMsg('x'))
    await entry
    expect(letter).toBe('x')
  })

  it('retry(message) sends the message instead of the original question', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let letter = ''
    const entry = enter(rt, async (c) => {
      letter = await c.ask('Escribe una letra')
      if (letter.length !== 1) letter = await c.retry('Solo una letra')
    }, start)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledTimes(1))
    rt.deliver(makeMsg('abc'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('Solo una letra'))
    expect(start.reply).toHaveBeenCalledTimes(2)              // the question was NOT re-sent
    rt.deliver(makeMsg('z'))
    await entry
    expect(letter).toBe('z')
  })

  it('waitText (no prompt) re-waits silently, or sends only the given message', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    const got: string[] = []
    const entry = enter(rt, async (c) => {
      got.push(await c.waitText())
      got.push(await c.retry())                    // nothing to re-send
      got.push(await c.retry('otra vez'))
    }, start)
    rt.deliver(makeMsg('uno'))
    await vi.waitFor(() => expect(got).toEqual(['uno']))
    rt.deliver(makeMsg('dos'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('otra vez'))
    expect(start.reply).toHaveBeenCalledTimes(1)
    rt.deliver(makeMsg('tres'))
    await entry
    expect(got).toEqual(['uno', 'dos', 'tres'])
  })

  it('keeps the original validate/otherwise options when re-running the wait', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let email = ''
    const entry = enter(rt, async (c) => {
      email = await c.ask('¿Email?', { validate: (b) => b.includes('@') || 'no es email', retries: 10 })
      if (email.endsWith('.test')) email = await c.retry('ese dominio no vale')
    }, start)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('¿Email?'))
    rt.deliver(makeMsg('a@b.test'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('ese dominio no vale'))
    rt.deliver(makeMsg('sin-arroba'))                        // validate still applies on the re-run
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('no es email'))
    rt.deliver(makeMsg('a@b.co'))
    await entry
    expect(email).toBe('a@b.co')
  })

  it('choose: retry re-sends the menu; retry(message) swaps only the header', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    const picks: string[] = []
    const entry = enter(rt, async (c) => {
      picks.push(await c.choose('Elige:', { a: 'A', b: 'B' }))
      picks.push(await c.retry())
      picks.push(await c.retry('Esa no, elige otra:'))
    }, start)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('Elige:\n\n1) A\n2) B'))
    rt.deliver(makeMsg('1'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledTimes(2))
    expect(start.reply).toHaveBeenNthCalledWith(2, 'Elige:\n\n1) A\n2) B')
    rt.deliver(makeMsg('b'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('Esa no, elige otra:\n\n1) A\n2) B'))
    rt.deliver(makeMsg('2'))
    await entry
    expect(picks).toEqual(['a', 'b', 'b'])
  })

  it("retry('') waits again silently (ask and choose)", async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    const got: string[] = []
    const entry = enter(rt, async (c) => {
      got.push(await c.ask('¿Nombre?'))
      got.push(await c.retry(''))
      got.push(await c.choose('Elige:', { a: 'A' }))
      got.push(await c.retry(''))
    }, start)
    for (const b of ['x', 'y', '1', 'a']) rt.deliver(makeMsg(b))
    await entry
    expect(got).toEqual(['x', 'y', 'a', 'a'])
    expect(start.reply.mock.calls.map((x) => x[0])).toEqual(['¿Nombre?', 'Elige:\n\n1) A'])
  })

  it('waitMedia: retry re-waits with the same accepted types', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let got: RuntimeMessage | undefined
    const entry = enter(rt, async (c) => {
      got = await c.waitMedia(['image'])
      if (got.body === 'borrosa') got = await c.retry<RuntimeMessage>('Está borrosa, envía otra')
    }, start)
    rt.deliver(makeMsg('borrosa', 'image'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('Está borrosa, envía otra'))
    rt.deliver(makeMsg('texto', 'text'))                     // still rejected by the image filter
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('📎 Envía un archivo válido.'))
    rt.deliver(makeMsg('nítida', 'image'))
    await entry
    expect(got?.body).toBe('nítida')
  })

  it('waitAny is retryable too (it is the most recent wait)', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    const got: string[] = []
    const entry = enter(rt, async (c) => {
      await c.ask('pregunta')
      got.push((await c.waitAny()).body)
      got.push((await c.retry<RuntimeMessage>('de nuevo')).body)
    }, start)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('pregunta'))
    rt.deliver(makeMsg('respuesta'))
    rt.deliver(makeMsg('any-1'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('de nuevo'))
    expect(start.reply).toHaveBeenCalledTimes(2)              // did not re-run (re-ask) the ask
    rt.deliver(makeMsg('any-2'))
    await entry
    expect(got).toEqual(['any-1', 'any-2'])
  })

  it('manual retries share the wait\'s `retries` budget (default 3) → RetriesExceeded', async () => {
    const rt = makeRt({ retriesMessage: 'agotado' })
    const start = makeMsg('start')
    let thrown: unknown
    const entry = enter(rt, async (c) => {
      await c.waitText()
      try {
        for (;;) await c.retry('otra')
      } catch (e) { thrown = e; throw e }
    }, start)
    rt.deliver(makeMsg('1'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledTimes(1))
    rt.deliver(makeMsg('2'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledTimes(2))
    rt.deliver(makeMsg('3'))                                   // 3rd manual retry exceeds the budget
    await entry
    expect(thrown).toBeInstanceOf(RetriesExceeded)
    expect(start.reply.mock.calls.map((c) => c[0])).toEqual(['otra', 'otra', 'agotado'])
  })

  it('validate failures and manual retries are counted together', async () => {
    const rt = makeRt({ retriesMessage: 'agotado' })
    const start = makeMsg('start')
    const entry = enter(rt, async (c) => {
      await c.waitText({ validate: (b) => b !== 'mal' || 'inválido', retries: 2 })
      await c.retry('otra')                                    // 1 validate failure + 1 retry = 2 → exceeded
    }, start)
    rt.deliver(makeMsg('mal'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('inválido'))
    rt.deliver(makeMsg('bien'))
    await entry
    expect(start.reply).toHaveBeenLastCalledWith('agotado')
    expect(start.reply).not.toHaveBeenCalledWith('otra')
  })

  it('retries: Infinity allows unlimited manual retries', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let n = 0
    const entry = enter(rt, async (c) => {
      let v = await c.waitText({ retries: Infinity })
      while (v !== 'fin') { n++; v = await c.retry() }
    }, start)
    for (let i = 0; i < 6; i++) {
      rt.deliver(makeMsg(`x${i}`))
      await vi.waitFor(() => expect(n).toBe(i + 1))
    }
    rt.deliver(makeMsg('fin'))
    await entry
    expect(n).toBe(6)
  })

  it('a new wait gets a fresh budget', async () => {
    const rt = makeRt({ retriesMessage: 'agotado' })
    const start = makeMsg('start')
    const got: string[] = []
    const entry = enter(rt, async (c) => {
      await c.waitText({ retries: 2 })
      got.push(await c.retry())                               // attempts 1/2
      await c.waitText({ retries: 2 })                        // new wait → budget resets
      got.push(await c.retry())                               // attempts 1/2 again
    }, start)
    for (const b of ['a', 'b', 'c', 'd']) rt.deliver(makeMsg(b))
    await entry
    expect(got).toEqual(['b', 'd'])
    expect(start.reply).not.toHaveBeenCalledWith('agotado')
  })

  it('retry() before any wait rejects with RetryUnavailableError (→ error path)', async () => {
    const onError = vi.fn()
    const rt = makeRt({ onError, errorMessage: 'boom' })
    const start = makeMsg('start')
    let thrown: unknown
    await enter(rt, async (c) => {
      try { await c.retry() } catch (e) { thrown = e; throw e }
    }, start)
    expect(thrown).toBeInstanceOf(RetryUnavailableError)
    expect(thrown).toBeInstanceOf(ConversationError)
    expect(onError).toHaveBeenCalledOnce()
    expect(start.reply).toHaveBeenCalledWith('boom')
  })

  it('an un-awaited retry() never surfaces as an unhandled rejection', async () => {
    const rejections: unknown[] = []
    const onRej = (e: unknown) => rejections.push(e)
    process.on('unhandledRejection', onRej)
    try {
      const rt = makeRt()
      const start = makeMsg('start')
      await enter(rt, async (c) => { void c.retry() }, start) // no wait yet → rejects, nobody awaits
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      process.off('unhandledRejection', onRej)
    }
    expect(rejections).toHaveLength(0)
  })

  it('works over a real Bot conversation (async)', async () => {
    const { bot, chat } = await createTestBot()
    bot.conversation('ahorcado', async (c, ctx) => {
      let letra = await c.ask('Escribe una letra')
      while (letra.length !== 1) letra = await c.retry('❌ Solo una letra')
      await ctx.reply(`✅ ${letra}`)
    })
    await chat.send('ahorcado')
    await chat.expectReply('Escribe una letra')
    await chat.send('abc')
    await chat.expectReply('❌ Solo una letra')
    await chat.send('q')
    await chat.expectReply('✅ q')
  })
})

describe('c.retry() — flow steps (rewind)', () => {
  it('.do() calling c.retry() re-asks the previous .ask() and re-runs the .do() on the new answer', async () => {
    const { bot, chat } = await createTestBot()
    const seen: string[] = []
    bot.use(flow('juego')
      .ask('Escribe una letra', 'letra')
      .do(async (ctx, c) => {
        seen.push(String(c.state.letra))
        if (String(c.state.letra).length !== 1) c.retry('❌ Solo una letra')
      })
      .say((_ctx, c) => `✅ ${String(c.state.letra)}`))
    await chat.send('juego')
    await chat.expectReply('Escribe una letra')
    await chat.send('abc')
    await chat.expectReply('❌ Solo una letra')
    await chat.send('k')
    await chat.expectReply('✅ k')
    expect(seen).toEqual(['abc', 'k'])
    expect(chat.replies().filter((r) => r === 'Escribe una letra')).toHaveLength(1)
  })

  it('without a message the original question is re-sent', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('edad')
      .ask('¿Edad?', 'edad')
      .do(async (_ctx, c) => { if (!/^\d+$/.test(String(c.state.edad))) return c.retry() })
      .say((_ctx, c) => `edad=${String(c.state.edad)}`))
    await chat.send('edad')
    await chat.expectReply('¿Edad?')
    await chat.send('treinta')
    await chat.expectReply('¿Edad?')
    await chat.send('30')
    await chat.expectReply('edad=30')
  })

  it('steps between the ask and the do are replayed in order', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('replay')
      .ask('¿Color?', 'color')
      .say('anotado')
      .do(async (_ctx, c) => { if (c.state.color !== 'rojo') c.retry('solo rojo') })
      .say('listo'))
    await chat.send('replay')
    await chat.expectReply('¿Color?')
    await chat.send('azul')
    await chat.expectReply('anotado')
    await chat.expectReply('solo rojo')
    await chat.send('rojo')
    await chat.expectReply('anotado')
    await chat.expectReply('listo')
  })

  it('code after c.retry() in the step does not run', async () => {
    const { bot, chat } = await createTestBot()
    const after = vi.fn()
    bot.use(flow('stop')
      .ask('¿Sí?', 'r')
      .do(async (_ctx, c) => { if (c.state.r !== 'si') { c.retry('di si'); after() } })
      .say('ok'))
    await chat.send('stop')
    await chat.expectReply('¿Sí?')
    await chat.send('no')
    await chat.expectReply('di si')
    await chat.send('si')
    await chat.expectReply('ok')
    expect(after).not.toHaveBeenCalled()
  })

  it('a choose `then` action calling c.retry() re-prompts the menu', async () => {
    const { bot, chat } = await createTestBot()
    let stock = 0
    bot.use(flow('tienda')
      .choose('¿Qué quieres?', {
        pan: { label: 'Pan', then: async (_ctx, c) => { if (stock++ === 0) c.retry('Sin pan, elige otra cosa:') } },
        leche: 'Leche',
      }, 'item')
      .say((_ctx, c) => `llevas ${String(c.state.item)}`))
    await chat.send('tienda')
    await chat.expectReply('¿Qué quieres?\n\n1) Pan\n2) Leche')
    await chat.send('1')
    await chat.expectReply('Sin pan, elige otra cosa:\n\n1) Pan\n2) Leche')
    await chat.send('leche')
    await chat.expectReply('llevas leche')
  })

  it('in a .do() that made its own wait, retry() re-runs that wait in place', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('inline')
      .say('hola')
      .do(async (ctx, c) => {
        let code = await c.waitText()
        if (code !== '1234') code = await c.retry('código incorrecto')
        await ctx.reply(`código ${code}`)
      }))
    await chat.send('inline')
    await chat.expectReply('hola')
    await chat.send('0000')
    await chat.expectReply('código incorrecto')
    await chat.send('1234')
    await chat.expectReply('código 1234')
    expect(chat.replies().filter((r) => r === 'hola')).toHaveLength(1)   // no rewind/replay
  })

  it('rewinds count against the ask\'s retries budget (shared with validate)', async () => {
    const { bot, chat } = await createTestBot({ conversation: { retriesMessage: 'demasiados' } })
    bot.use(flow('budget')
      .ask('¿Clave?', 'k', { retries: 2 })
      .do(async (_ctx, c) => { if (c.state.k !== 'ok') c.retry('mal') })
      .say('dentro'))
    await chat.send('budget')
    await chat.expectReply('¿Clave?')
    await chat.send('x')
    await chat.expectReply('mal')
    await chat.send('y')
    await chat.expectReply('demasiados')
    await new Promise((r) => setTimeout(r, 20))
    expect(chat.replies()).not.toContain('dentro')
  })

  it('retry inside a sub-flow rewinds within the sub-flow, then returns to the parent', async () => {
    const { bot, chat } = await createTestBot()
    const direccion = flow('direccion-sub')
      .ask('¿Ciudad?', 'ciudad')
      .do(async (_ctx, c) => { if (String(c.state.ciudad).length < 3) c.retry('ciudad muy corta') })
    bot.use(flow('envio')
      .choose('¿Envío?', { si: { label: 'Sí', then: direccion }, no: 'No' })
      .say((_ctx, c) => `fin ${String(c.state.ciudad ?? '-')}`))
    await chat.send('envio')
    await chat.expectReply('¿Envío?')
    await chat.send('si')
    await chat.expectReply('¿Ciudad?')
    await chat.send('ab')
    await chat.expectReply('ciudad muy corta')
    await chat.send('Bogotá')
    await chat.expectReply('fin Bogotá')
  })

  it('a .do() step without any earlier prompt step fails clearly (RetryUnavailableError → error event)', async () => {
    const { bot, chat } = await createTestBot({ conversation: { errorMessage: 'falló' } })
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    bot.use(flow('nada').do(async (_ctx, c) => { c.retry() }))
    await chat.send('nada')
    await chat.expectReply('falló')
    expect(errors[0]).toBeInstanceOf(RetryUnavailableError)
  })

  it('persistent flow resumed after a restart can still rewind to its ask step', async () => {
    const store = new MemoryStore()
    const first = await createTestBot({ store })
    const gate = { block: true }
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    const build = () => flow('perfil').id('perfil').persistent()
      .ask('¿Nombre?', 'nombre')
      .do(async (_ctx, c) => {
        if (gate.block) await blocked                    // simulate a crash mid-step on the first bot
        if (String(c.state.nombre).length < 2) c.retry('nombre muy corto')
      })
      .say((_ctx, c) => `hola ${String(c.state.nombre)}`)
    first.bot.use(build())
    await first.chat.send('perfil')
    await first.chat.expectReply('¿Nombre?')
    await first.chat.send('A')                          // checkpoint → step 1 (the .do)
    await new Promise((r) => setTimeout(r, 20))
    await first.bot.stop()                              // graceful stop keeps the checkpoint
    gate.block = false
    release()

    const second = await createTestBot({ store })
    second.bot.use(build())
    await second.chat.send('despierta')                 // wakes the dormant flow at the .do step
    await second.chat.expectReply('nombre muy corto')   // no record survived → rewinds to the ask
    await second.chat.send('Ana')
    await second.chat.expectReply('hola Ana')
  })

  it('the rewind signal is a ConversationError so user try/catch can rethrow it', async () => {
    const { bot, chat } = await createTestBot()
    const caught: unknown[] = []
    bot.use(flow('trycatch')
      .ask('¿Valor?', 'v')
      .do(async (_ctx, c) => {
        try { if (c.state.v === 'mal') c.retry('de nuevo') } catch (e) {
          caught.push(e)
          if (e instanceof ConversationError) throw e
        }
      })
      .say('ok'))
    await chat.send('trycatch')
    await chat.expectReply('¿Valor?')
    await chat.send('mal')
    await chat.expectReply('de nuevo')
    await chat.send('bien')
    await chat.expectReply('ok')
    expect(caught[0]).toBeInstanceOf(ConversationRetry)
  })
})

describe('c.end(farewell) (FEATURES #15)', () => {
  it('async conversation: sends the farewell and ends', async () => {
    const { bot, chat } = await createTestBot()
    bot.conversation('juego', async (c, ctx) => {
      await ctx.reply('¿Jugamos?')
      const r = await c.waitText()
      if (r === 'cancelar') c.end('✅ Juego cancelado')
      await ctx.reply('nunca')
    })
    await chat.send('juego')
    await chat.expectReply('¿Jugamos?')
    await chat.send('cancelar')
    await chat.expectReply('✅ Juego cancelado')
    await new Promise((r) => setTimeout(r, 20))
    expect(chat.replies()).not.toContain('nunca')
  })

  it('flow .do(): c.end(farewell) after a retry loop', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('cancelar')
      .ask('¿Seguro? (si/no)', 'confirm')
      .do(async (_ctx, c) => {
        if (c.state.confirm === 'si') c.end('✅ Cancelado')
        if (c.state.confirm !== 'no') c.retry('Responde si o no')
      })
      .say('Seguimos'))
    await chat.send('cancelar')
    await chat.expectReply('¿Seguro? (si/no)')
    await chat.send('quizás')
    await chat.expectReply('Responde si o no')
    await chat.send('si')
    await chat.expectReply('✅ Cancelado')
    await new Promise((r) => setTimeout(r, 20))
    expect(chat.replies()).not.toContain('Seguimos')
  })
})
