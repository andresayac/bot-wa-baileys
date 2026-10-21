import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'
import { TEMPLATES, TEMPLATE_NAMES } from 'create-botmesh'

import { configs } from '../src/index.js'

// Every project create-botmesh generates must already be clean under the plugin:
// the templates are what new users (and AI agents) copy from.
describe('create-botmesh templates pass the plugin', () => {
  const linter = new Linter({ configType: 'flat' })

  it.each(TEMPLATE_NAMES)('template "%s" has no findings under the strict config', (template) => {
    const bot = TEMPLATES[template].files('lint-me').find((f) => f.path === 'src/bot.js')
    expect(bot).toBeDefined()
    const messages = linter.verify(
      bot!.contents,
      [{ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } }, configs.strict],
      'bot.js',
    )
    expect(messages.map((m) => `${m.ruleId ?? 'parse'}:${m.line} ${m.message}`)).toEqual([])
  })
})
