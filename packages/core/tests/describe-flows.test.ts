import { describe, it, expect } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { NamespacedStore } from '../src/store/NamespacedStore.js'
import type { IStore } from '../src/store/IStore.js'
import { flow, type CompiledFlow, type CompiledStep } from '../src/flows/FlowBuilder.js'
import { ConversationRuntime } from '../src/conversations/ConversationRuntime.js'
import { describeFlows, type FlowGraph } from '../src/flows/describe.js'
import { describeTrigger, isDurableStore, type TriggerInfo } from '../src/flows/inventory.js'
import * as core from '../src/index.js'

const mkBot = (cfg: Partial<ConstructorParameters<typeof Bot>[0]> = {}) => new Bot({ provider: new MockProvider(), ...cfg })
const lines = (...l: string[]) => l.join('\n')

/** The rich fixture used by the snapshot-style tests below. */
function richBot(): Bot {
  const bot = mkBot()
  const sub = flow('sub').say('📱 iPhone — $999')
  bot.use(
    flow('checkout')
      .timeout('2m')
      .persistent()
      .say('🛒 Bienvenido')
      .ask('¿Tu nombre?', 'name')
      .do(function saveUser() {})
      .media('https://example.com/cat.png', 'Un gato')
      .choose('¿Categoría?', {
        tech: { label: 'Electrónica', then: sub },
        otro: { label: 'Otro', then: (_ctx, c) => { c.state.extra = true } },
        si: 'Sí',
        no: 'No',
      }, 'cat')
      .goto('soporte')
      .say('nunca'),
  )
  bot.conversation('soporte', async () => {})
  bot.use(flow(['menu', 'Menú']).say(() => 'hola').ask('¿Edad?', 'age', { timeout: '30s' }).goto('nope'))
  return bot
}

describe('describeFlows — Mermaid', () => {
  it('renders every flow as a subgraph, conversations as one node, gotos as dotted edges (snapshot)', () => {
    expect(describeFlows(richBot())).toBe(lines(
      'flowchart TD',
      '  subgraph f0 ["flow: checkout (timeout 2m, persistent)"]',
      '    f0_in(["▶ #34;checkout#34;"])',
      '    f0_s0["say: 🛒 Bienvenido"]',
      '    f0_s1[/"ask: ¿Tu nombre? → name"/]',
      '    f0_s2("do: saveUser()")',
      '    f0_s3["media: https://example.com/cat.png — Un gato"]',
      '    f0_s4{"choose: ¿Categoría? → cat"}',
      '    subgraph f0_s4_o0 ["then: sub"]',
      '      f0_s4_o0_s0["say: 📱 iPhone — $999"]',
      '    end',
      '    f0_s4_o1("then: (action)")',
      '    f0_s5{{"goto: soporte"}}',
      '    f0_s6["say: nunca"]',
      '    f0_end(("end"))',
      '    f0_in --> f0_s0',
      '    f0_s0 --> f0_s1',
      '    f0_s1 --> f0_s2',
      '    f0_s2 --> f0_s3',
      '    f0_s3 --> f0_s4',
      '    f0_s4 -->|"1) Electrónica"| f0_s4_o0_s0',
      '    f0_s4 -->|"2) Otro"| f0_s4_o1',
      '    f0_s4_o0_s0 --> f0_s5',
      '    f0_s4_o1 --> f0_s5',
      '    f0_s4 -->|"3) Sí / 4) No"| f0_s5',
      '    f0_s6 --> f0_end',
      '  end',
      '  f1[["conversation: soporte<br/>▶ #34;soporte#34;"]]',
      '  subgraph f2 ["flow: menu"]',
      '    f2_in(["▶ #34;menu#34;, #34;Menú#34;"])',
      '    f2_s0["say: (dynamic)"]',
      '    f2_s1[/"ask: ¿Edad? → age ⏱ 30s"/]',
      '    f2_s2{{"goto: nope"}}',
      '    f2_in --> f2_s0',
      '    f2_s0 --> f2_s1',
      '    f2_s1 --> f2_s2',
      '  end',
      '  x0>"missing: nope"]',
      '  f0_s5 -.-> f1',
      '  f2_s2 -.-> x0',
    ))
  })

  it('bot.describe() defaults to Mermaid and matches describeFlows(bot)', () => {
    const bot = richBot()
    expect(bot.describe()).toBe(describeFlows(bot))
    expect(bot.describe({ format: 'mermaid' })).toBe(describeFlows(bot))
  })

  it('supports a left-to-right layout', () => {
    const bot = mkBot()
    bot.use(flow('a').say('x'))
    expect(bot.describe({ direction: 'LR' }).split('\n')[0]).toBe('flowchart LR')
  })

  it('rejects an unknown direction instead of writing it into the diagram', () => {
    const bot = mkBot()
    expect(() => bot.describe({ direction: 'TD\nclick f0 call alert()' as 'TD' })).toThrow(TypeError)
  })

  it('renders an empty bot as a bare flowchart header', () => {
    expect(mkBot().describe()).toBe('flowchart TD')
  })

  it('renders an opaque async conversation as a single node with its triggers', () => {
    const bot = mkBot()
    bot.conversation('soporte', async () => {}, { trigger: ['help', /ayuda/i] })
    expect(bot.describe()).toBe(lines(
      'flowchart TD',
      '  f0[["conversation: soporte<br/>▶ #34;help#34;, /ayuda/i"]]',
    ))
  })

  it('leaves steps after an unconditional goto without incoming edges', () => {
    const bot = mkBot()
    bot.use(flow('a').goto('b').say('dead'))
    bot.use(flow('b').say('ok'))
    const out = bot.describe()
    expect(out).toContain('    f0_s1["say: dead"]')
    expect(out).not.toMatch(/--> f0_s1\b/)
    expect(out).toContain('    f0_s1 --> f0_end')
    expect(out).toContain('  f0_s0 -.-> f1_in')
  })

  it('uses the route trigger for when(trigger, flow) and lists every route on the entry node', () => {
    const bot = mkBot()
    const f = flow('a').say('x')
    bot.use(f)
    bot.when(/^comprar/i, f)
    bot.when({ pattern: 'factura', match: 'contains', scope: 'dm' }, f)
    expect(bot.describe()).toContain('    f0_in(["▶ #34;a#34;<br/>▶ /^comprar/i<br/>▶ contains #34;factura#34; (dm only)"])')
  })

  it('drops unsubscribed routes and marks flows without any trigger', () => {
    const bot = mkBot()
    const off = bot.when('b', flow('a').say('x'))
    off()
    expect(bot.describe()).toContain('    f0_in(["▶ (no trigger)"])')
  })

  it('escapes labels so user text cannot break out of the node or inject directives', () => {
    const bot = mkBot()
    const evil = 'a "quoted" <b>bold</b> & #tag `code` 100% | pipe\nnew line %%{init: {"theme":"dark"}}%% "]; click f0 call alert() ;["'
    bot.use(flow('x"y').say(evil))
    const out = bot.describe({ maxLabelLength: 500 })
    expect(out).toContain(
      '    f0_s0["say: a #34;quoted#34; #60;b#62;bold#60;/b#62; #38; #35;tag #96;code#96; 100#37; #124; pipe new line ' +
      '#37;#37;{init: {#34;theme#34;:#34;dark#34;}}#37;#37; #34;]; click f0 call alert() ;[#34;"]',
    )
    expect(out).toContain('    f0_in(["▶ #34;x\\#34;y#34;"])')
    expect(out).not.toContain('%%')
    // every node line carries exactly two raw double quotes: the label delimiters
    for (const line of out.split('\n').filter((l) => /^\s+f\d/.test(l) && !l.includes('->'))) {
      expect(line.split('"').length - 1).toBe(2)
    }
  })

  it('collapses whitespace and truncates long labels without splitting emoji', () => {
    const bot = mkBot()
    bot.use(flow('a').say('line one\n\n  line   two').say('😀'.repeat(12)).say('a'.repeat(100)))
    const out = bot.describe({ maxLabelLength: 5 })
    expect(out).toContain('    f0_s0["say: line…"]')
    expect(out).toContain('    f0_s1["say: 😀😀😀😀…"]')
    expect(out).toContain('    f0_s2["say: aaaa…"]')
    const full = bot.describe()
    expect(full).toContain('    f0_s0["say: line one line two"]')
    expect(full).toContain(`    f0_s2["say: ${'a'.repeat(59)}…"]`)
  })

  it('renders triggers: predicates, flow scope and never-matching triggers', () => {
    const bot = mkBot()
    bot.when(function isLong(ctx: { body: string }) { return ctx.body.length > 100 }, flow('long').say('x'))
    bot.use(flow('soporte').scope('dm').say('x'))
    bot.use(flow([]).id('empty').say('x'))
    bot.when((ctx) => ctx.isGroup, flow('grp').say('x'))
    const out = bot.describe()
    expect(out).toContain('    f0_in(["▶ (predicate: isLong)"])')
    expect(out).toContain('    f1_in(["▶ #34;soporte#34; (dm only)"])')
    expect(out).toContain('    f2_in(["▶ [] (never matches)"])')
    expect(out).toContain('    f3_in(["▶ (predicate)"])')
  })

  it('renders unknown (future) step kinds generically and treats an `end` step as terminal', () => {
    const compiled: CompiledFlow = {
      id: 'z',
      trigger: 'z',
      steps: [
        { kind: 'guard' } as unknown as CompiledStep,
        { kind: 'say', text: 'ok' },
        { kind: 'end' } as unknown as CompiledStep,
        { kind: 'say', text: 'after end' },
      ],
      opts: {},
    }
    const out = describeFlows([compiled])
    expect(out).toContain('    f0_s0["guard"]')
    expect(out).toContain('    f0_s0 --> f0_s1')
    expect(out).toContain('    f0_s2(("end"))')
    expect(out).toContain('    f0_s1 --> f0_s2')
    expect(out).not.toMatch(/f0_s2 -->/)
    expect(out).not.toMatch(/--> f0_s3\b/)
  })

  it('does not recurse forever on a hand-built cyclic sub-flow', () => {
    const a: CompiledFlow = { id: 'a', trigger: 'a', steps: [], opts: {} }
    a.steps.push({ kind: 'choose', prompt: 'p', options: { again: { label: 'Again', then: a } } })
    const out = describeFlows([a])
    expect(out).toContain('    f0_s0_o0("then: a (recursive)")')
  })

  it('accepts plain FlowBuilder / CompiledFlow arrays (no Bot needed)', () => {
    const out = describeFlows([flow('a').say('x').goto('b'), flow('b').say('y').compile()])
    expect(out).toContain('  subgraph f0 ["flow: a"]')
    expect(out).toContain('  subgraph f1 ["flow: b"]')
    expect(out).toContain('  f0_s1 -.-> f1_in')
  })
})

describe('describeFlows — JSON graph', () => {
  it('returns a plain, serializable graph (full structure)', () => {
    const bot = mkBot()
    bot.use(flow('a').ask('q', 'k').goto('b'))
    bot.use(flow('b').say('x'))
    const graph = bot.describe({ format: 'json' })
    const trig = (v: string): TriggerInfo => ({ label: `"${v}"`, patterns: [{ type: 'text', value: v }], match: 'equals', scope: 'all', predicate: false })
    expect(graph).toEqual({
      version: 1,
      flows: [
        { id: 'f0', name: 'a', kind: 'flow', entry: 'f0_in', triggers: [trig('a')], persistent: false },
        { id: 'f1', name: 'b', kind: 'flow', entry: 'f1_in', triggers: [trig('b')], persistent: false },
      ],
      groups: [],
      nodes: [
        { id: 'f0_in', kind: 'entry', label: '▶ "a"', flow: 'f0' },
        { id: 'f0_s0', kind: 'ask', label: 'ask: q → k', flow: 'f0', path: 'steps[0]', text: 'q', stateKey: 'k', timeoutMs: 300_000, timeoutSource: 'builtin' },
        { id: 'f0_s1', kind: 'goto', label: 'goto: b', flow: 'f0', path: 'steps[1]', target: 'b' },
        { id: 'f1_in', kind: 'entry', label: '▶ "b"', flow: 'f1' },
        { id: 'f1_s0', kind: 'say', label: 'say: x', flow: 'f1', path: 'steps[0]', text: 'x' },
        { id: 'f1_end', kind: 'end', label: 'end', flow: 'f1' },
      ],
      edges: [
        { from: 'f0_in', to: 'f0_s0', kind: 'next' },
        { from: 'f0_s0', to: 'f0_s1', kind: 'next' },
        { from: 'f1_in', to: 'f1_s0', kind: 'next' },
        { from: 'f1_s0', to: 'f1_end', kind: 'next' },
        { from: 'f0_s1', to: 'f1_in', kind: 'goto' },
      ],
    } satisfies FlowGraph)
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph)
  })

  it('uses the same node ids as the Mermaid output and one edge per choose option', () => {
    const bot = richBot()
    const graph = describeFlows(bot, { format: 'json' })
    const mermaid = describeFlows(bot)
    for (const node of graph.nodes) expect(mermaid).toContain(`${node.id}`)
    expect(graph.flows.map((f) => [f.id, f.name, f.kind, f.entry])).toEqual([
      ['f0', 'checkout', 'flow', 'f0_in'],
      ['f1', 'soporte', 'conversation', 'f1'],
      ['f2', 'menu', 'flow', 'f2_in'],
    ])
    expect(graph.flows[0]).toMatchObject({ timeoutMs: 120_000, persistent: true })
    const options = graph.edges.filter((e) => e.from === 'f0_s4' && e.kind === 'option')
    expect(options.map((e) => [e.option, e.to, e.label])).toEqual([
      ['tech', 'f0_s4_o0_s0', '1) Electrónica'],
      ['otro', 'f0_s4_o1', '2) Otro'],
      ['si', 'f0_s5', '3) Sí'],
      ['no', 'f0_s5', '4) No'],
    ])
    expect(graph.edges).toContainEqual({ from: 'f0_s4_o0_s0', to: 'f0_s5', kind: 'return' })
    expect(graph.groups).toEqual([{ id: 'f0_s4_o0', label: 'then: sub', flow: 'f0', subflow: 'sub' }])
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    expect(byId.get('f0_s1')).toMatchObject({ kind: 'ask', stateKey: 'name', timeoutMs: 120_000, timeoutSource: 'flow' })
    expect(byId.get('f2_s1')).toMatchObject({ kind: 'ask', timeoutMs: 30_000, timeoutSource: 'step' })
    expect(byId.get('f0_s2')).toMatchObject({ kind: 'do', action: 'saveUser' })
    expect(byId.get('f0_s3')).toMatchObject({ kind: 'media', media: { source: 'https://example.com/cat.png', caption: 'Un gato' } })
    expect(byId.get('f0_s4')).toMatchObject({
      kind: 'choose',
      text: '¿Categoría?',
      stateKey: 'cat',
      options: [
        { key: 'tech', label: 'Electrónica', index: 1, then: 'flow', thenFlow: 'sub' },
        { key: 'otro', label: 'Otro', index: 2, then: 'action' },
        { key: 'si', label: 'Sí', index: 3 },
        { key: 'no', label: 'No', index: 4 },
      ],
    })
    expect(byId.get('f0_s4_o0_s0')).toMatchObject({ group: 'f0_s4_o0', path: 'steps[4].options["tech"].then.steps[0]' })
    expect(byId.get('f2_s0')).toMatchObject({ kind: 'say', dynamic: true })
    expect(byId.get('f1')).toMatchObject({ kind: 'conversation', label: 'conversation: soporte\n▶ "soporte"' })
    expect(byId.get('x0')).toMatchObject({ kind: 'missing', target: 'nope' })
    expect(byId.get('x0')?.flow).toBeUndefined()
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph)
  })

  it('reports the bot-level default timeout as the wait source', () => {
    const bot = mkBot({ conversation: { timeout: '45s' } })
    bot.use(flow('a').ask('q', 'k'))
    const node = bot.describe({ format: 'json' }).nodes.find((n) => n.kind === 'ask')
    expect(node).toMatchObject({ timeoutMs: 45_000, timeoutSource: 'bot' })
  })
})

describe('flow inventory', () => {
  it('records registrations, routes and bot config for describe/lint', () => {
    const bot = mkBot({ conversation: { timeout: '1m' } })
    const fn = async () => {}
    bot.use(flow('a').say('x'))
    const handler = () => {}
    bot.when('hola', handler)
    bot.conversation('c', fn, { trigger: 'ayuda' })
    const off = bot.when('b', flow('b').say('y'))
    off()
    const inv = bot.flowInventory()
    expect(inv.registrations.map((r) => [r.name, Boolean(r.flow), r.fn === fn])).toEqual([
      ['a', true, false],
      ['c', false, true],
      ['b', true, false],
    ])
    expect(inv.routes.map((r) => [r.trigger, r.target])).toEqual([
      ['a', 'a'],
      ['hola', undefined],
      ['ayuda', 'c'],
    ])
    expect(inv.defaultTimeoutMs).toBe(60_000)
    expect(inv.durableStore).toBe(false)
  })

  it('detects whether the configured store survives a restart', () => {
    expect(mkBot().flowInventory().durableStore).toBe(false)
    expect(mkBot({ storeConfig: { file: './never-written.json' } }).flowInventory().durableStore).toBe(true)
    expect(mkBot({ store: new MemoryStore() }).flowInventory().durableStore).toBe(false)
    expect(mkBot({ store: new MemoryStore({ file: './never-written.json' }) }).flowInventory().durableStore).toBe(true)
    const ns = { tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'p', connectionId: 'c' }
    expect(isDurableStore(new NamespacedStore(new MemoryStore(), ns))).toBe(false)
    expect(isDurableStore(new NamespacedStore(new MemoryStore({ file: 'x.json' }), ns))).toBe(true)
    // Any other IStore (SQLite, Redis, …) is assumed durable — no false positives.
    expect(isDurableStore({} as IStore)).toBe(true)
    expect(new MemoryStore().durable).toBe(false)
    expect(new MemoryStore({ file: 'x.json' }).durable).toBe(true)
  })

  it('ConversationRuntime keeps the registration history (last registration is live)', () => {
    const rt = new ConversationRuntime()
    const fn = async () => {}
    const compiled = flow('x').say('a').compile()
    rt.register('x', fn)
    rt.registerCompiled(compiled)
    expect(rt.listRegistrations()).toEqual([{ name: 'x', fn }, { name: 'x', flow: compiled }])
  })

  it('FlowBuilder.media() tags its step so introspection can tell it apart from .do()', () => {
    const step = flow('x').media('pic.png', 'cap').compile().steps[0]
    expect(step).toMatchObject({ kind: 'do', media: { source: 'pic.png', caption: 'cap' } })
  })

  it('describeTrigger mirrors the dispatcher matching semantics', () => {
    expect(describeTrigger('hola')).toEqual({ label: '"hola"', patterns: [{ type: 'text', value: 'hola' }], match: 'equals', scope: 'all', predicate: false })
    expect(describeTrigger(/x/gi)).toMatchObject({ label: '/x/gi', patterns: [{ type: 'regex', source: 'x', flags: 'gi' }] })
    expect(describeTrigger({ pattern: ['a', /b/], match: 'startsWith', scope: 'group' }).label).toBe('startsWith "a", /b/ (group only)')
    expect(describeTrigger({ pattern: /b/, match: 'contains' }).label).toBe('/b/')
    expect(describeTrigger([]).label).toBe('[] (never matches)')
    expect(describeTrigger(() => true)).toMatchObject({ label: '(predicate)', patterns: [], predicate: true })
  })

  it('exports the describe/lint API from the package entry point', () => {
    expect(typeof core.describeFlows).toBe('function')
    expect(typeof core.lintFlows).toBe('function')
    expect(typeof core.describeTrigger).toBe('function')
  })
})
