import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

import botWa, { configs, rules } from '../src/index.js'

const V1_BOT = `
import { addKeyword, definePlugin } from '@bot-wa/core'
const users = new Map()
export const welcome = addKeyword('').addAnswer('¿Nombre?', { capture: true }, async (ctx, { flowDynamic, globalState }) => {
  users.set(ctx.from, ctx.body)
  await flowDynamic('Hola')
})
export const plugin = definePlugin({ name: 'p', async install() {} })
export async function start(runtime, h, m) { await runtime.enter(h, m) }
`

const V2_BOT = `
import { Bot, defineBot, flow, isMainModule } from '@bot-wa/core'
const createBot = defineBot((provider) => {
  const bot = new Bot({ provider })
  bot.when('hola', async (ctx) => { await ctx.user.set('seen', true); await ctx.reply('¡Hola!') })
  bot.use(flow('menu').ask('¿1 o 2?', 'choice').say((_ctx, c) => 'Elegiste ' + c.state.choice).timeout('5m'))
  bot.conversation('juego', async (c, ctx) => { const a = await c.ask('¿Listo?', { timeout: '2m' }); await ctx.reply(a) }, { trigger: 'jugar' })
  return bot
})
export default createBot
if (isMainModule(import.meta)) { /* connect the real provider */ }
`

function lint(code: string, config = configs.recommended) {
  const linter = new Linter({ configType: 'flat' })
  return linter.verify(code, [{ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } }, config], 'bot.js')
}

describe('plugin shape', () => {
  it('exposes meta, the six rules and flat configs', () => {
    expect(botWa.meta.name).toBe('eslint-plugin-bot-wa')
    expect(botWa.meta.namespace).toBe('bot-wa')
    expect(Object.keys(rules).sort()).toEqual([
      'no-async-plugin-install',
      'no-await-runtime-enter',
      'no-empty-trigger',
      'no-v1-api',
      'prefer-ctx-user-over-global-state',
      'require-timeout-on-ask',
    ])
    for (const rule of Object.values(rules)) {
      expect(rule.meta?.docs?.description).toBeTruthy()
      expect(rule.meta?.messages).toBeTruthy()
    }
    // Every rule is enabled in both presets, and the presets register the plugin itself.
    for (const preset of [configs.recommended, configs.strict]) {
      expect(preset.plugins?.['bot-wa']).toBe(botWa)
      expect(Object.keys(preset.rules ?? {}).sort()).toEqual(Object.keys(rules).map((r) => 'bot-wa/' + r).sort())
    }
    expect(botWa.configs.recommended).toBe(configs.recommended)
  })
})

describe('recommended preset', () => {
  it('flags a v1-style bot', () => {
    const ids = lint(V1_BOT).map((m) => m.ruleId)
    expect(ids).toContain('bot-wa/no-v1-api')
    expect(ids).toContain('bot-wa/no-empty-trigger')
    expect(ids).toContain('bot-wa/no-async-plugin-install')
    expect(ids).toContain('bot-wa/no-await-runtime-enter')
    expect(ids).toContain('bot-wa/prefer-ctx-user-over-global-state')
    const fatal = lint(V1_BOT).filter((m) => m.fatal)
    expect(fatal).toEqual([])
  })

  it('accepts an idiomatic v2 bot', () => {
    expect(lint(V2_BOT)).toEqual([])
    expect(lint(V2_BOT, configs.strict)).toEqual([])
  })

  it('reports require-timeout-on-ask as a warning (severity 1) in recommended, error in strict', () => {
    const code = "import { flow } from '@bot-wa/core'\nexport const f = flow('a').ask('?', 'k')\n"
    expect(lint(code).map((m) => [m.ruleId, m.severity])).toEqual([['bot-wa/require-timeout-on-ask', 1]])
    expect(lint(code, configs.strict).map((m) => [m.ruleId, m.severity])).toEqual([['bot-wa/require-timeout-on-ask', 2]])
  })
})
