import { describe, it, expect } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { flow, type CompiledFlow, type CompiledStep } from '../src/flows/FlowBuilder.js'
import { lintFlows, type LintCode, type LintDiagnostic } from '../src/flows/lint.js'

const mkBot = (cfg: Partial<ConstructorParameters<typeof Bot>[0]> = {}) => new Bot({ provider: new MockProvider(), ...cfg })
const codes = (d: LintDiagnostic[]) => d.map((x) => x.code)
const only = (d: LintDiagnostic[], code: LintCode) => d.filter((x) => x.code === code)
/** Lint while ignoring the advisory missing-timeout infos, to keep assertions focused. */
const lint = (source: Parameters<typeof lintFlows>[0]) => lintFlows(source, { rules: { 'missing-timeout': false } })

describe('lintFlows — goto targets', () => {
  it('flags a goto to a flow that does not exist (error, with node id and path)', () => {
    const d = lint([flow('a').say('x').goto('nope')])
    expect(d).toEqual([
      expect.objectContaining({ code: 'goto-target-missing', severity: 'error', flow: 'a', nodeId: 'f0_s1', path: 'steps[1]' }),
    ])
    expect(d[0].message).toContain('"nope"')
  })

  it('checks gotos inside choose then sub-flows', () => {
    const d = lint([flow('a').choose('p', { x: { label: 'X', then: flow('sub').goto('ghost') }, y: 'Y' })])
    expect(only(d, 'goto-target-missing')).toEqual([
      expect.objectContaining({ flow: 'a', nodeId: 'f0_s0_o0_s0', path: 'steps[0].options["x"].then.steps[0]' }),
    ])
  })

  it('catches goto(builder) to an anonymous flow whose id changes on every compile', () => {
    const bot = mkBot()
    const anon = flow(/^precio/i).say('x')
    bot.use(anon)
    bot.use(flow('a').goto(anon))
    const [diag] = only(lint(bot), 'goto-target-missing')
    expect(diag.message).toMatch(/\.id\(/)
  })

  it('accepts gotos to registered flows and conversations', () => {
    const bot = mkBot()
    bot.use(flow('a').goto('b'))
    bot.use(flow('b').goto('c'))
    bot.conversation('c', async () => {})
    expect(lint(bot)).toEqual([])
  })
})

describe('lintFlows — unreachable steps', () => {
  it('flags the first step after an unconditional goto and counts the rest', () => {
    const d = lint([flow('a').say('ok').goto('b').say('never').say('never 2'), flow('b').say('x')])
    expect(d).toEqual([
      expect.objectContaining({ code: 'unreachable-step', severity: 'warning', flow: 'a', nodeId: 'f0_s2', path: 'steps[2]' }),
    ])
    expect(d[0].message).toContain('goto "b"')
    expect(d[0].message).toContain('1 more step')
  })

  it('flags steps after a choose whose every option jumps away', () => {
    const d = lint([
      flow('a')
        .choose('p', { x: { label: 'X', then: flow('s1').goto('b') }, y: { label: 'Y', then: flow('s2').goto('b') } })
        .say('dead'),
      flow('b').say('x'),
    ])
    expect(only(d, 'unreachable-step')).toEqual([expect.objectContaining({ nodeId: 'f0_s1', path: 'steps[1]' })])
  })

  it('does not flag steps after a choose with at least one option that continues', () => {
    const d = lint([
      flow('a').choose('p', { x: { label: 'X', then: flow('s1').goto('b') }, y: 'Y' }).say('alive'),
      flow('b').say('x'),
    ])
    expect(only(d, 'unreachable-step')).toEqual([])
  })

  it('flags unreachable steps inside a then sub-flow', () => {
    const d = lint([flow('a').choose('p', { x: { label: 'X', then: flow('s').goto('b').say('dead') } }), flow('b').say('x')])
    expect(only(d, 'unreachable-step')).toEqual([
      expect.objectContaining({ nodeId: 'f0_s0_o0_s1', path: 'steps[0].options["x"].then.steps[1]' }),
    ])
  })

  it('treats a future `end` step kind as terminal', () => {
    const compiled: CompiledFlow = {
      id: 'a', trigger: 'a', opts: {},
      steps: [{ kind: 'end' } as unknown as CompiledStep, { kind: 'say', text: 'x' }],
    }
    expect(only(lint([compiled]), 'unreachable-step')).toEqual([expect.objectContaining({ nodeId: 'f0_s1' })])
  })
})

describe('lintFlows — timeouts', () => {
  it('reports ask/choose that fall back to the built-in timeout as info', () => {
    const d = lintFlows([flow('a').ask('q', 'k').choose('p', { x: 'X' })])
    expect(d).toEqual([
      expect.objectContaining({ code: 'missing-timeout', severity: 'info', nodeId: 'f0_s0', path: 'steps[0]' }),
      expect.objectContaining({ code: 'missing-timeout', severity: 'info', nodeId: 'f0_s1', path: 'steps[1]' }),
    ])
    expect(d[0].message).toContain('5m')
  })

  it('is satisfied by a flow timeout, a step timeout or a bot-wide default', () => {
    expect(lintFlows([flow('a').timeout('1m').ask('q', 'k')])).toEqual([])
    expect(lintFlows([flow('a').ask('q', 'k', { timeout: '30s' })])).toEqual([])
    const bot = mkBot({ conversation: { timeout: '2m' } })
    bot.use(flow('a').ask('q', 'k').choose('p', { x: 'X' }))
    expect(bot.lint()).toEqual([])
  })

  it('explains that inline then sub-flows do not inherit the parent flow timeout', () => {
    const d = lintFlows([flow('a').timeout('1m').choose('p', { x: { label: 'X', then: flow('sub').ask('q', 'k') } })])
    expect(d).toEqual([expect.objectContaining({ code: 'missing-timeout', nodeId: 'f0_s0_o0_s0' })])
    expect(d[0].message).toContain('do not inherit')
  })

  it('reports waits that never expire (timeout 0)', () => {
    expect(codes(lintFlows([flow('a').timeout(0).ask('q', 'k')]))).toEqual(['wait-never-expires'])
    expect(codes(lintFlows([flow('a').ask('q', 'k', { timeout: 0 })]))).toEqual(['wait-never-expires'])
    const bot = mkBot({ conversation: { timeout: 0 } })
    bot.use(flow('a').ask('q', 'k'))
    expect(bot.lint()).toEqual([expect.objectContaining({ code: 'wait-never-expires', severity: 'info' })])
  })

  it('flags a step timeout that the runtime cannot parse (error)', () => {
    const d = lintFlows([flow('a').ask('q', 'k', { timeout: '2 minutos' })])
    expect(d).toEqual([expect.objectContaining({ code: 'invalid-timeout', severity: 'error', nodeId: 'f0_s0' })])
    expect(d[0].message).toContain('2 minutos')
  })
})

describe('lintFlows — triggers', () => {
  it('flags addKeyword([]) as an empty trigger and the flow as unreachable', () => {
    const bot = mkBot()
    bot.use(flow([]).id('orphan').say('x'))
    const d = lint(bot)
    expect(d).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'empty-trigger', severity: 'warning', flow: 'orphan', trigger: '[] (never matches)' }),
      expect.objectContaining({ code: 'unreachable-flow', severity: 'warning', flow: 'orphan', nodeId: 'f0_in' }),
    ]))
    expect(d).toHaveLength(2)
  })

  it('downgrades an empty trigger to info for a goto-only flow', () => {
    const bot = mkBot()
    bot.use(flow([]).id('step2').say('x'))
    bot.use(flow('start').goto('step2'))
    expect(lint(bot)).toEqual([expect.objectContaining({ code: 'empty-trigger', severity: 'info', flow: 'step2' })])
  })

  it("flags '' / whitespace triggers that match empty-body (media) messages", () => {
    const bot = mkBot()
    bot.use(flow('').id('blank').say('x'))
    bot.use(flow('   ').id('spaces').say('x'))
    bot.when({ pattern: '', match: 'contains' }, flow('every').say('x'))
    bot.when(['hola', ''], flow('mixed').say('x'))
    bot.when([], () => {})
    bot.when(new RegExp(''), flow('re').say('x'))
    const d = only(lint(bot), 'empty-trigger')
    expect(d.map((x) => [x.flow, x.severity])).toEqual([
      ['blank', 'warning'],
      ['spaces', 'warning'],
      ['every', 'warning'],
      ['mixed', 'warning'],
      [undefined, 'warning'],
      ['re', 'warning'],
    ])
    expect(d[0].message).toMatch(/empty/)
    expect(d[2].message).toMatch(/every message/)
    expect(d[4].message).toMatch(/never runs/)
  })

  it('flags a flow shadowed by an earlier route with the same trigger', () => {
    const bot = mkBot()
    bot.use(flow('hola').say('a'))
    bot.use(flow(['Hola ', 'hi']).id('other').say('b'))
    const d = only(lint(bot), 'duplicate-trigger')
    expect(d).toEqual([expect.objectContaining({ severity: 'warning', flow: 'other', trigger: '"Hola ", "hi"' })])
    expect(d[0].message).toContain('"hola"')
  })

  it('flags flows shadowed by a when() handler and handlers shadowed by a flow', () => {
    const bot = mkBot()
    bot.when('menu', () => {})
    bot.use(flow('menu').say('x'))
    bot.use(flow('precios').say('x'))
    bot.when('precios', () => {})
    const d = only(lint(bot), 'duplicate-trigger')
    expect(d.map((x) => x.flow)).toEqual(['menu', undefined])
  })

  it('ignores two plain handlers on one trigger (ctx.pass() chains are legitimate)', () => {
    const bot = mkBot()
    bot.when('hola', () => {})
    bot.when('hola', () => {})
    expect(lint(bot)).toEqual([])
  })

  it('respects scopes, strategies and regex identity', () => {
    const bot = mkBot()
    bot.use(flow('x').scope('dm').say('a'))
    bot.use(flow('x').id('x-group').scope('group').say('b'))
    bot.use(flow('y').scope('dm').say('a'))
    bot.use(flow('y').id('y-all').say('b'))
    bot.when({ pattern: 'z', match: 'contains' }, flow('z-contains').say('a'))
    bot.use(flow('z').say('b'))
    bot.when(/^\d+$/, flow('n1').say('a'))
    bot.when(/^\d+$/, flow('n2').say('b'))
    const d = only(lint(bot), 'duplicate-trigger')
    expect(d.map((x) => x.flow)).toEqual(['n2'])
  })

  it('follows dispatch order (specificity first, then registration order)', () => {
    const bot = mkBot()
    bot.when({ pattern: ['hola'], match: 'contains' }, flow('first').say('a'))
    bot.when({ pattern: ['hola', /zzz/], match: 'contains' }, flow('second').say('b'))
    const d = only(lint(bot), 'duplicate-trigger')
    expect(d.map((x) => x.flow)).toEqual(['first'])
    expect(d[0].message).toContain('"second"')
  })

  it('flags the same flow registered twice', () => {
    const bot = mkBot()
    const f = flow('a').say('x')
    bot.use(f)
    bot.use(f)
    expect(codes(lint(bot))).toEqual(['duplicate-trigger'])
  })
})

describe('lintFlows — reachability', () => {
  it('flags a conversation whose only route was unsubscribed', () => {
    const bot = mkBot()
    const off = bot.conversation('c', async () => {})
    off()
    expect(lint(bot)).toEqual([expect.objectContaining({ code: 'unreachable-flow', flow: 'c', nodeId: 'f0' })])
  })

  it('propagates reachability through gotos, but not through unreachable ones', () => {
    const bot = mkBot()
    bot.use(flow('a').goto('b').goto('c'))
    bot.use(flow('b').say('x'))
    bot.use(flow([]).id('c').goto('d'))
    bot.use(flow([]).id('d').say('x'))
    const d = lint(bot)
    expect(only(d, 'unreachable-flow').map((x) => x.flow)).toEqual(['c', 'd'])
    expect(only(d, 'unreachable-step').map((x) => x.nodeId)).toEqual(['f0_s1'])
  })

  it('does not warn about [] flows a .do() action may enter with c.goto() (and they really are entered)', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('menu').timeout('1m').ask('a o b?', 'pick').do((_ctx, c) => { c.goto(c.state.pick === 'a' ? 'ventas' : 'soporte') }))
    bot.use(flow([]).id('ventas').say('bienvenido a ventas'))
    bot.use(flow([]).id('soporte').say('bienvenido a soporte'))

    expect(bot.lint({ minSeverity: 'warning' })).toEqual([])
    const d = bot.lint()
    expect(d.map((x) => [x.code, x.severity, x.flow])).toEqual([
      ['unreachable-flow', 'info', 'ventas'],
      ['unreachable-flow', 'info', 'soporte'],
      ['empty-trigger', 'info', 'ventas'],
      ['empty-trigger', 'info', 'soporte'],
    ])
    for (const x of d) {
      expect(x.message).toContain('c.goto(')
      expect(x.message).not.toMatch(/can never start/)
    }

    await chat.send('menu')
    await chat.expectReply('a o b?')
    await chat.send('a')
    await chat.expectReply('bienvenido a ventas')
    await bot.stop()
  })

  it('does not warn about flows an async conversation may enter with c.goto()', () => {
    const bot = mkBot()
    bot.conversation('menu', async (c) => { c.goto('ventas') })
    bot.use(flow([]).id('ventas').say('x'))
    bot.conversation('legacy', async () => {}, { trigger: [] })
    expect(bot.lint({ minSeverity: 'warning' })).toEqual([])
    expect(only(bot.lint(), 'unreachable-flow').map((x) => [x.flow, x.severity])).toEqual([['ventas', 'info'], ['legacy', 'info']])
  })

  it('counts choose then actions and dynamic texts as code that may call c.goto()', () => {
    const viaThen = mkBot()
    viaThen.use(flow('menu').choose('p', { x: { label: 'X', then: (_ctx, c) => { c.goto('target') } } }))
    viaThen.use(flow([]).id('target').say('x'))
    expect(viaThen.lint({ minSeverity: 'warning' })).toEqual([])

    const viaText = mkBot()
    viaText.use(flow('menu').say((_ctx, c) => c.goto('target')))
    viaText.use(flow([]).id('target').say('x'))
    expect(viaText.lint({ minSeverity: 'warning' })).toEqual([])
  })

  it('still warns when the only code that could call c.goto() can never run', () => {
    const bot = mkBot()
    // .media() is not user code; the .do() sits after an unconditional goto; 'island' itself is unreachable.
    bot.use(flow('start').media('https://example.com/a.png').goto('next').do((_ctx, c) => { c.goto('orphan') }))
    bot.use(flow('next').say('x'))
    bot.use(flow([]).id('orphan').say('x'))
    bot.use(flow([]).id('island').do((_ctx, c) => { c.goto('orphan') }))
    bot.conversation('gone', async (c) => { c.goto('orphan') })()
    const d = lint(bot)
    expect(only(d, 'unreachable-flow').map((x) => [x.flow, x.severity])).toEqual([
      ['orphan', 'warning'],
      ['island', 'warning'],
      ['gone', 'warning'],
    ])
    expect(only(d, 'empty-trigger').map((x) => [x.flow, x.severity])).toEqual([['orphan', 'warning'], ['island', 'warning']])
  })
})

describe('lintFlows — persistence, choices and id collisions', () => {
  it('flags persistent() flows when only the RAM store is configured', () => {
    const bot = mkBot()
    bot.use(flow('reg').persistent().say('x'))
    expect(lint(bot)).toEqual([expect.objectContaining({ code: 'persistent-memory-store', severity: 'warning', flow: 'reg', nodeId: 'f0_in' })])
    const injected = mkBot({ store: new MemoryStore() })
    injected.use(flow('reg').persistent().say('x'))
    expect(codes(lint(injected))).toEqual(['persistent-memory-store'])
  })

  it('accepts persistent() with a durable store, and stays silent when the store is unknown', () => {
    const withFile = mkBot({ storeConfig: { file: './never-written.json' } })
    withFile.use(flow('reg').persistent().say('x'))
    expect(lint(withFile)).toEqual([])
    expect(lint([flow('reg').persistent().say('x')])).toEqual([])
  })

  it('flags choose() options with duplicate keys or labels', () => {
    const d = lint([flow('a').choose('p', { si: 'Sí', SI: 'Yes', a: 'Same', b: 'same ' })])
    expect(only(d, 'duplicate-choice')).toHaveLength(2)
    expect(only(d, 'duplicate-choice').every((x) => x.nodeId === 'f0_s0' && x.severity === 'warning')).toBe(true)
  })

  it('flags ambiguous choose() options (numeric keys off their position, key/label clashes)', () => {
    expect(codes(lint([flow('a').choose('p', { 0: 'Zero', 1: 'One' })]))).toEqual(['ambiguous-choice'])
    expect(codes(lint([flow('a').choose('p', { yes: 'No', no: 'Yes' })]))).toEqual(['ambiguous-choice', 'ambiguous-choice'])
    expect(lint([flow('a').choose('p', { 1: 'Bad', 2: 'Good' })])).toEqual([])
  })

  it('flags an empty choose() (error)', () => {
    expect(lint([flow('a').choose('p', {})])).toEqual([expect.objectContaining({ code: 'empty-choice', severity: 'error' })])
  })

  it('flags two different flows registered under the same id', () => {
    const bot = mkBot()
    bot.use(flow('hola').say('A'))
    bot.use(flow(['Hola', 'hi']).say('B'))
    const d = lint(bot)
    expect(only(d, 'flow-id-collision')).toEqual([expect.objectContaining({ severity: 'warning', flow: 'hola', nodeId: 'f0_in' })])
    const mixed = mkBot()
    mixed.conversation('menu', async () => {})
    mixed.use(flow('Menu').say('x'))
    expect(codes(lint(mixed))).toContain('flow-id-collision')
  })
})

describe('lintFlows — options and Bot integration', () => {
  it('sorts by severity, filters by minSeverity and toggles rules', () => {
    const source = [flow('a').ask('q', 'k').goto('nope').say('dead')]
    expect(codes(lintFlows(source))).toEqual(['goto-target-missing', 'unreachable-step', 'missing-timeout'])
    expect(codes(lintFlows(source, { minSeverity: 'warning' }))).toEqual(['goto-target-missing', 'unreachable-step'])
    expect(codes(lintFlows(source, { minSeverity: 'error' }))).toEqual(['goto-target-missing'])
    expect(codes(lintFlows(source, { rules: { 'unreachable-step': false } }))).toEqual(['goto-target-missing', 'missing-timeout'])
  })

  it('bot.lint() equals lintFlows(bot) and returns plain data', () => {
    const bot = mkBot()
    bot.use(flow('a').ask('q', 'k').goto('nope'))
    expect(bot.lint()).toEqual(lintFlows(bot))
    expect(JSON.parse(JSON.stringify(bot.lint()))).toEqual(bot.lint())
  })

  it('reports nothing for an empty bot', () => {
    expect(mkBot().lint()).toEqual([])
  })
})
