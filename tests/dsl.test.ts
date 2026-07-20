import { describe, it, expect, vi } from 'vitest'
import { ConversationRuntime } from '../src/conversations/ConversationRuntime.js'
import { createControls } from '../src/conversations/controls.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { flowToConversation } from '../src/conversations/interpreter.js'

function makeMsg(body: string) {
  return { from: 'a@s.whatsapp.net', sender: 'a@s.whatsapp.net', body, type: 'text', isGroup: false, reply: vi.fn(async () => {}) }
}
const makeRt = () => new ConversationRuntime({ controlsFactory: (rt, handle, ctx) => createControls(rt, handle, ctx) })

describe('FlowBuilder + interpreter', () => {
  it('say/ask/do/say end-to-end with state', async () => {
    const rt = makeRt()
    const saved: Record<string, unknown>[] = []
    const f = flow('registrar')
      .say('📝 Vamos a registrarte')
      .ask('¿Tu nombre?', 'name')
      .do(async (_ctx, c) => { saved.push({ ...c.state }) })
      .say((_ctx, c) => `✅ Hola ${c.state.name}`)
      .compile()
    const start = makeMsg('registrar')
    const entry = rt.enter(flowToConversation(f), start)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('¿Tu nombre?'))
    rt.deliver(makeMsg('Andres'))
    await entry
    expect(saved[0]).toEqual({ name: 'Andres' })
    expect(start.reply).toHaveBeenCalledWith('✅ Hola Andres')
  })

  it('choose sub-flow returns to parent (transcript bug fix)', async () => {
    const rt = makeRt()
    const sub = flow('sub').say('📱 iPhone — $999')
    const f = flow('comprar')
      .choose('Categorías:', { tech: { label: 'Electrónica', then: sub } })
      .say('✅ ¡Gracias!')
      .compile()
    const start = makeMsg('comprar')
    const entry = rt.enter(flowToConversation(f), start)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalled())
    rt.deliver(makeMsg('1'))
    await entry
    expect(start.reply).toHaveBeenCalledWith('📱 iPhone — $999')
    expect(start.reply).toHaveBeenCalledWith('✅ ¡Gracias!')   // el padre CONTINÚA
  })

  it('validate in ask re-prompts', async () => {
    const rt = makeRt()
    const f = flow('email')
      .ask('¿Email?', 'email', { validate: (b) => b.includes('@') || 'inválido' })
      .say((_c, c) => `ok ${c.state.email}`)
      .compile()
    const start = makeMsg('email')
    const entry = rt.enter(flowToConversation(f), start)
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('¿Email?'))
    rt.deliver(makeMsg('nope'))
    await vi.waitFor(() => expect(start.reply).toHaveBeenCalledWith('inválido'))
    rt.deliver(makeMsg('a@b.co'))
    await entry
    expect(start.reply).toHaveBeenCalledWith('ok a@b.co')
  })

  it('persistent() without string id throws at compile', () => {
    expect(() => flow(/x/).persistent().compile()).toThrow(/id/)
  })
})
