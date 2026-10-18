import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

import { rules } from '../src/index.js'

// RuleTester drives the test framework through these hooks.
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } })

const rule = (name: string) => {
  const r = rules[name]
  if (!r) throw new Error('missing rule ' + name)
  return r
}

tester.run('no-v1-api', rule('no-v1-api'), {
  valid: [
    "bot.use(flow('hola').say('Hola').ask('¿Nombre?', 'name', { timeout: '5m' }))",
    "bot.conversation('x', async (c) => { await c.ask('?', { timeout: '1m' }); c.end('bye') })",
    'const capture = true',
    '({ capture: false })',
    "function addAnswer() {} addAnswer('not a method call')",
  ],
  invalid: [
    { code: "addKeyword('hola').addAnswer('Hola!')", errors: [{ messageId: 'call', data: { name: 'addAnswer', replacement: "flow(...).say(text) / .ask(text, 'stateKey')" } }] },
    { code: "flow('x').addAction(async () => {})", errors: [{ messageId: 'call' }] },
    { code: "addKeyword('x').addAnswer('¿Nombre?', { capture: true }, async () => {})", errors: [{ messageId: 'call' }, { messageId: 'capture' }] },
    { code: "async function h({ flowDynamic }) { await flowDynamic('hola') }", errors: [{ messageId: 'call' }] },
    { code: 'const go = (ctx, { gotoFlow }) => gotoFlow(menu)', errors: [{ messageId: 'call' }] },
    { code: "helpers.endFlow('bye')", errors: [{ messageId: 'call' }] },
    { code: "({ 'capture': true })", errors: [{ messageId: 'capture' }] },
  ],
})

tester.run('no-await-runtime-enter', rule('no-await-runtime-enter'), {
  valid: [
    'void runtime.enter(handle, msg).catch((err) => logger.error({ err }))',
    'async function f() { void this.runtime.enter(x).catch(onError) }',
    'async function f() { await door.enter() }',
    'async function f() { await runtime.wait(x) }',
    'runtime.enter(x).catch(onError)',
    {
      code: 'async function f() { await engine.enter(x) }',
      options: [{ receiverPattern: 'runtime$' }],
    },
  ],
  invalid: [
    { code: 'async function f() { await runtime.enter(handle, msg) }', errors: [{ messageId: 'awaited', data: { receiver: 'runtime' } }] },
    { code: 'async function f() { await this.runtime.enter(x) }', errors: [{ messageId: 'awaited' }] },
    { code: 'async function f() { await bot.conversationRuntime.enter(x) }', errors: [{ messageId: 'awaited', data: { receiver: 'conversationRuntime' } }] },
    { code: 'async function f() { await runtime.enter(x).catch(onError) }', errors: [{ messageId: 'awaited' }] },
    { code: 'async function f() { return runtime.enter(x) }', errors: [{ messageId: 'awaited' }] },
    { code: "bot.when('hola', (ctx) => runtime.enter(x))", errors: [{ messageId: 'awaited' }] },
    {
      code: 'async function f() { await engine.enter(x) }',
      options: [{ receiverPattern: '^engine$' }],
      errors: [{ messageId: 'awaited', data: { receiver: 'engine' } }],
    },
  ],
})

tester.run('no-async-plugin-install', rule('no-async-plugin-install'), {
  valid: [
    "definePlugin({ name: 'p', install(ctx) { ctx.bot.when('a', h) } })",
    "const p = { name: 'p', install: (ctx) => { void warmup().catch(() => {}) } }",
    // Not a plugin (no `name`, not definePlugin): left alone.
    'const installer = { async install() {} }',
    'class Installer { async install() {} }',
    "class P { name = 'p'; install() {} }",
  ],
  invalid: [
    { code: "definePlugin({ name: 'p', async install(ctx) { await ctx.store.ready() } })", errors: [{ messageId: 'async' }] },
    { code: 'definePlugin({ install: async () => {} })', errors: [{ messageId: 'async' }] },
    { code: "const myPlugin = { name: 'x', install: async function () {} }", errors: [{ messageId: 'async' }] },
    { code: "export default (cfg) => ({ name: 'x', async install(ctx) {} })", errors: [{ messageId: 'async' }] },
    { code: "class MyPlugin { name = 'my'; async install(ctx) {} }", errors: [{ messageId: 'async' }] },
  ],
})

tester.run('no-empty-trigger', rule('no-empty-trigger'), {
  valid: [
    "flow('hola')",
    "addKeyword(['hola', 'buenas'])",
    "bot.when(/^hola/i, h)",
    "bot.when({ pattern: 'precio', match: 'contains' }, h)",
    'bot.when(trigger, h)',
    "bot.conversation('x', fn, { trigger: 'jugar' })",
    "bot.conversation('x', fn)",
    'flow(`hola ${name}`)',
  ],
  invalid: [
    { code: "flow('')", errors: [{ messageId: 'empty', data: { reason: 'an empty string' } }] },
    { code: "addKeyword('   ')", errors: [{ messageId: 'empty' }] },
    { code: 'addKeyword([])', errors: [{ messageId: 'empty', data: { reason: 'an empty array' } }] },
    { code: "bot.when(['', ' '], h)", errors: [{ messageId: 'empty', data: { reason: 'an array of empty strings' } }] },
    { code: "bot.when({ pattern: '', match: 'contains' }, h)", errors: [{ messageId: 'empty' }] },
    { code: 'bot.when(``, h)', errors: [{ messageId: 'empty' }] },
    { code: "bot.conversation('x', fn, { trigger: '' })", errors: [{ messageId: 'empty' }] },
  ],
})

tester.run('require-timeout-on-ask', rule('require-timeout-on-ask'), {
  valid: [
    "flow('a').ask('?', 'k', { timeout: '5m' })",
    "flow('a').ask('?', 'k').timeout('10m')",
    "flow('a').timeout('10m').say('hi').ask('?', 'k')",
    "addKeyword('a').ask('?', 'k').say('ok').timeout(60000)",
    "flow('a').ask('?', 'k', opts)",
    "bot.conversation('x', async (c) => { await c.ask('?', { timeout: '2m' }) })",
    "bot.conversation('x', async (c) => { await c.ask('?', WAIT) })",
    "bot.conversation('x', async (c) => { await c.ask('?', { ...WAIT }) })",
    // Not in the default method list.
    "bot.conversation('x', async (c) => { await c.waitText() })",
    "flow('a').choose('?', { 1: 'a' }, 'k')",
    // Calls that are not member calls are ignored.
    'ask("?")',
  ],
  invalid: [
    { code: "flow('a').ask('?', 'k')", errors: [{ messageId: 'missing', data: { method: 'ask', flowHint: " or add `.timeout('10m')` to the flow" } }] },
    { code: "flow('a').ask('?', 'k', { validate: (t) => true })", errors: [{ messageId: 'missing' }] },
    { code: "bot.conversation('x', async (c) => { await c.ask('?') })", errors: [{ messageId: 'missing', data: { method: 'ask', flowHint: '' } }] },
    { code: "bot.conversation('x', async (c) => { await c.ask('?', { retries: 2 }) })", errors: [{ messageId: 'missing' }] },
    {
      code: "flow('a').ask('?', 'k').timeout('10m')",
      options: [{ allowFlowTimeout: false }],
      errors: [{ messageId: 'missing', data: { method: 'ask', flowHint: '' } }],
    },
    {
      code: "bot.conversation('x', async (c) => { await c.waitText(); await c.waitMedia(['image']); await c.choose('?', { 1: 'a' }) })",
      options: [{ methods: ['waitText', 'waitMedia', 'choose'] }],
      errors: [{ messageId: 'missing' }, { messageId: 'missing' }, { messageId: 'missing' }],
    },
    {
      code: "flow('a').choose('?', { 1: 'a' }, 'k')",
      options: [{ methods: ['choose'] }],
      errors: [{ messageId: 'missing', data: { method: 'choose', flowHint: " or add `.timeout('10m')` to the flow" } }],
    },
  ],
})

tester.run('prefer-ctx-user-over-global-state', rule('prefer-ctx-user-over-global-state'), {
  valid: [
    "bot.when('hola', async (ctx) => { await ctx.user.set('name', 'Ana') })",
    // A local map inside the handler is not module-level state.
    "bot.when('x', async (ctx) => { const seen = new Map(); seen.set(ctx.from, 1) })",
    // Keyed by something else.
    "const cache = new Map(); bot.when('x', async (ctx) => { cache.get(ctx.body) })",
    // Different context name (not configured).
    "const users = new Map(); bot.when('x', async (m) => { users.set(m.from, 1) })",
    'const o = { globalState: 1 }; o.globalState',
  ],
  invalid: [
    {
      code: "const users = new Map(); bot.when('x', async (ctx) => { users.set(ctx.from, { step: 1 }) })",
      errors: [{ messageId: 'moduleMap', data: { name: 'users', key: 'ctx.from' } }],
    },
    {
      code: "const scores = {}; bot.when('x', async (ctx) => { scores[ctx.sender] = (scores[ctx.sender] ?? 0) + 1 })",
      errors: [{ messageId: 'moduleMap' }, { messageId: 'moduleMap' }],
    },
    {
      code: "let carts = new Map(); export function h(ctx) { return carts.get(ctx.senderId) }",
      errors: [{ messageId: 'moduleMap', data: { name: 'carts', key: 'ctx.senderId' } }],
    },
    {
      code: "const users = new Map(); bot.when('x', async (m) => { users.delete(m.from) })",
      options: [{ contextNames: ['m'] }],
      errors: [{ messageId: 'moduleMap', data: { name: 'users', key: 'm.from' } }],
    },
    {
      code: "addKeyword('x').addAction(async (ctx, { globalState }) => { await globalState.update({ a: 1 }) })",
      errors: [{ messageId: 'globalState' }, { messageId: 'globalState' }],
    },
  ],
})
