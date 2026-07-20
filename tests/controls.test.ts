import { describe, it, expect, vi } from 'vitest'
import { ConversationRuntime, type RuntimeConfig } from '../src/conversations/ConversationRuntime.js'
import { createControls } from '../src/conversations/controls.js'

function makeMsg(body: string, type = 'text') {
  return { from: 'a@s.whatsapp.net', sender: 'a@s.whatsapp.net', body, type, isGroup: false, reply: vi.fn(async () => {}) }
}
function makeRt(cfg: RuntimeConfig = {}) {
  return new ConversationRuntime({ ...cfg, controlsFactory: (rt, handle, ctx) => createControls(rt, handle, ctx) })
}

describe('controls', () => {
  it('ask sends question and returns the reply body', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let name = ''
    const entry = rt.enter(async (c: any) => { name = await c.ask('¿Tu nombre?') }, start)
    await Promise.resolve()
    expect(start.reply).toHaveBeenCalledWith('¿Tu nombre?')
    rt.deliver(makeMsg('Andres'))
    await entry
    expect(name).toBe('Andres')
  })

  it('validate rejects with message and accepts retry', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let email = ''
    const entry = rt.enter(async (c: any) => {
      email = await c.ask('¿Email?', { validate: (b: string) => b.includes('@') || 'no es email' })
    }, start)
    await Promise.resolve()
    const bad = makeMsg('nope'); rt.deliver(bad)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('no es email'))
    rt.deliver(makeMsg('a@b.co'))
    await entry
    expect(email).toBe('a@b.co')
  })

  it('throws RetriesExceeded after N invalid answers', async () => {
    const rt = makeRt({ retriesMessage: 'agotado' })
    const start = makeMsg('start')
    const entry = rt.enter(async (c: any) => {
      await c.ask('¿Email?', { validate: () => 'mal', retries: 2 })
    }, start)
    await Promise.resolve()
    rt.deliver(makeMsg('x'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('mal'))
    rt.deliver(makeMsg('y'))
    await entry
    expect(start.reply).toHaveBeenCalledWith('agotado')
  })

  it('choose renders numbered menu and accepts key or index', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let picked = ''
    const entry = rt.enter(async (c: any) => {
      picked = await c.choose('Elige:', { ropa: 'Ropa', tech: 'Electrónica' })
    }, start)
    await Promise.resolve()
    expect(start.reply).toHaveBeenCalledWith('Elige:\n\n1) Ropa\n2) Electrónica')
    rt.deliver(makeMsg('2'))
    await entry
    expect(picked).toBe('tech')
  })

  it('choose re-prompts on invalid option', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let picked = ''
    const entry = rt.enter(async (c: any) => {
      picked = await c.choose('Elige:', { a: 'A', b: 'B' }, { otherwise: 'opción inválida' })
    }, start)
    await Promise.resolve()
    rt.deliver(makeMsg('zzz'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('opción inválida'))
    rt.deliver(makeMsg('a'))
    await entry
    expect(picked).toBe('a')
  })

  it('waitMedia rejects wrong type with otherwise and accepts media', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let got: any
    const entry = rt.enter(async (c: any) => { got = await c.waitMedia(['image']) }, start)
    await Promise.resolve()
    rt.deliver(makeMsg('texto', 'text'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalled())
    rt.deliver(makeMsg('', 'image'))
    await entry
    expect(got.type).toBe('image')
  })

  it('say() after abort is silenced: no output reaches the peer and the entry settles cleanly', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entry = rt.enter(async (c: any) => {
      await gate                    // parked on an external gate — no pending wait to reject
      await c.say('late')           // must be silenced by assertAlive() before it reaches ctx.reply
    }, start)
    rt.abort(rt.keyFor(start))      // cancel while parked (no pending wait exists)
    release()                       // let the conversation resume past the gate
    await entry                     // must settle without throwing and without any error reply
    expect(start.reply).not.toHaveBeenCalledWith('late')
  })
})
