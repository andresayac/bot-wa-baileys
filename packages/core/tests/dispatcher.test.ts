import { describe, it, expect, vi } from 'vitest'
import { Dispatcher } from '../src/core/Dispatcher.js'
import { ConversationRuntime } from '../src/conversations/ConversationRuntime.js'
import { createControls } from '../src/conversations/controls.js'

function makeCtx(body: string, over: Record<string, unknown> = {}) {
  const ctx: any = {
    from: 'a@s.whatsapp.net', sender: 'a@s.whatsapp.net', body, type: 'text', isGroup: false,
    reply: vi.fn(async () => {}),
    _passed: false, _aborted: false,
    pass() { this._passed = true }, abort() { this._aborted = true },
    ...over,
  }
  return ctx
}
const noopHooks = {
  runBefore: vi.fn(async () => true),
  runAfter: vi.fn(async () => {}),
  runError: vi.fn(async () => {}),
}
function makeDispatcher(rt?: ConversationRuntime) {
  const runtime = rt ?? new ConversationRuntime({ controlsFactory: (r, k, c) => createControls(r, k, c) })
  const emitted: Array<[string, unknown]> = []
  // emit() now returns "had listeners" (mirrors EventEmitter.emit / Bot.emit). This harness
  // records emissions but registers no real listeners, so it returns false — matching a bot
  // with no 'command:unknown' listener, where an unknown command falls through to the catch-all.
  const d = new Dispatcher({ hooks: { ...noopHooks }, runtime, emit: (e, p) => { emitted.push([e, p]); return false } })
  return { d, runtime, emitted }
}

describe('Dispatcher', () => {
  it('exactly one handler runs — no double replies (transcript bug)', async () => {
    const { d } = makeDispatcher()
    const hello = vi.fn(); const fallback = vi.fn()
    d.matcher('hola', hello)
    d.catchAll(fallback)
    await d.dispatch(makeCtx('hola'))
    expect(hello).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('equals matching does not fire for /hola', async () => {
    const { d } = makeDispatcher()
    const hello = vi.fn(); const fallback = vi.fn()
    d.matcher('hola', hello)
    d.catchAll(fallback)
    await d.dispatch(makeCtx('/hola'))
    expect(hello).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('commands beat active conversations (/reset escapes)', async () => {
    const { d, runtime } = makeDispatcher()
    const reset = vi.fn((ctx: any) => { runtime.abort(runtime.keyFor(ctx)) })
    d.command('reset', reset)
    const start = makeCtx('start')
    const entry = runtime.enter(async (c) => { await c.waitAny() }, start)
    await d.dispatch(makeCtx('/reset'))
    expect(reset).toHaveBeenCalledOnce()
    await entry
    expect(runtime.hasActive(runtime.keyFor(start))).toBe(false)
  })

  it('active conversation consumes before matchers', async () => {
    const { d, runtime } = makeDispatcher()
    const buy = vi.fn()
    d.matcher('comprar', buy)
    const start = makeCtx('start')
    const got: string[] = []
    const entry = runtime.enter(async (c) => { got.push((await c.waitAny()).body) }, start)
    await d.dispatch(makeCtx('comprar'))          // dentro de conversación: es la RESPUESTA
    await entry
    expect(got).toEqual(['comprar'])
    expect(buy).not.toHaveBeenCalled()
  })

  it('specificity: equals wins over contains regardless of registration order', async () => {
    const { d } = makeDispatcher()
    const contains = vi.fn(); const equals = vi.fn()
    d.matcher({ pattern: 'ayuda', match: 'contains' }, contains)
    d.matcher('ayuda', equals)
    await d.dispatch(makeCtx('ayuda'))
    expect(equals).toHaveBeenCalledOnce()
    expect(contains).not.toHaveBeenCalled()
  })

  it('ctx.pass() lets the next handler run', async () => {
    const { d } = makeDispatcher()
    const first = vi.fn((ctx: any) => ctx.pass())
    const second = vi.fn()
    d.matcher('x', first)
    d.matcher({ pattern: 'x', match: 'contains' }, second)
    await d.dispatch(makeCtx('x'))
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('unknown /command feeds an active conversation WITHOUT emitting command:unknown (no double reply)', async () => {
    const { d, runtime, emitted } = makeDispatcher()
    const start = makeCtx('start')
    const got: string[] = []
    const entry = runtime.enter(async (c) => { got.push((await c.waitAny()).body) }, start)
    await d.dispatch(makeCtx('/xyz'))
    // Previously this always emitted 'command:unknown' even with an active conversation,
    // which made a real 'command:unknown' listener (e.g. slashCommandsPlugin) reply
    // "Comando desconocido" AND the conversation consume "/xyz" as its answer — a double
    // behavior. With an active conversation, the emit must not happen at all.
    expect(emitted.some(([e]) => e === 'command:unknown')).toBe(false)
    await entry
    expect(got).toEqual(['/xyz'])
  })

  it('active conversation: unknown /command is never emitted, even when a listener would consume it', async () => {
    const runtime = new ConversationRuntime({ controlsFactory: (r, k, c) => createControls(r, k, c) })
    const emitted: Array<[string, unknown]> = []
    // Simulates a real bot with a 'command:unknown' listener attached (emit returns true).
    const d = new Dispatcher({ hooks: { ...noopHooks }, runtime, emit: (e, p) => { emitted.push([e, p]); return true } })
    const start = makeCtx('start')
    const got: string[] = []
    const entry = runtime.enter(async (c) => { got.push((await c.waitAny()).body) }, start)
    await d.dispatch(makeCtx('/typo'))
    expect(emitted.some(([e]) => e === 'command:unknown')).toBe(false)
    await entry
    expect(got).toEqual(['/typo'])
  })

  it('no active conversation: unknown /command DOES emit command:unknown', async () => {
    const runtime = new ConversationRuntime({ controlsFactory: (r, k, c) => createControls(r, k, c) })
    const emitted: Array<[string, unknown]> = []
    const d = new Dispatcher({ hooks: { ...noopHooks }, runtime, emit: (e, p) => { emitted.push([e, p]); return true } })
    const fallback = vi.fn()
    d.catchAll(fallback)
    await d.dispatch(makeCtx('/typo'))
    expect(emitted.some(([e]) => e === 'command:unknown')).toBe(true)
    // handled === true (a listener existed) and no active conversation -> dispatch stops here.
    expect(fallback).not.toHaveBeenCalled()
  })

  it('constructor throws on an empty commandPrefix (P3)', () => {
    const runtime = new ConversationRuntime()
    expect(() => new Dispatcher({ hooks: { ...noopHooks }, runtime, commandPrefix: '', emit: () => false }))
      .toThrow(/commandPrefix/)
  })

  it('messages of same chat are serialized (FIFO)', async () => {
    const { d } = makeDispatcher()
    const order: string[] = []
    d.matcher({ pattern: 'msg', match: 'startsWith' }, async (ctx) => {
      if (ctx.body === 'msg-1') await new Promise((r) => setTimeout(r, 30))
      order.push(ctx.body)
    })
    await Promise.all([d.dispatch(makeCtx('msg-1')), d.dispatch(makeCtx('msg-2'))])
    expect(order).toEqual(['msg-1', 'msg-2'])
  })
})
