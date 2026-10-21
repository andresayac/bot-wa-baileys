/**
 * `AIPluginConfig.instance`: a ready-built provider used as is (public name of the old
 * `__provider` test hook, which stays honoured but is stripped from the published types).
 */
import { describe, expect, it } from 'vitest'
import { createTestBot } from '@botmesh/core/testing'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { aiPlugin } from '../src/plugin.js'

describe('aiPlugin({ instance })', () => {
  it('uses the injected provider instead of resolving one from provider/apiKey', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ instance: new MockAIProvider({ reply: 'from instance' }), humanizeTyping: false }))
    await chat.send('hola')
    await chat.expectReply('from instance')
    await bot.stop()
  })

  it('still honours the hidden __provider alias', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: 'from alias' }), humanizeTyping: false }))
    await chat.send('hola')
    await chat.expectReply('from alias')
    await bot.stop()
  })

  it('instance wins when both are given', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({
      instance: new MockAIProvider({ reply: 'instance wins' }),
      __provider: new MockAIProvider({ reply: 'alias loses' }),
      humanizeTyping: false,
    }))
    await chat.send('hola')
    await chat.expectReply('instance wins')
    expect(chat.replies()).not.toContain('alias loses')
    await bot.stop()
  })
})
