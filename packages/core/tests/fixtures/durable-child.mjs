// Child process for durability-process.test.ts: journals one inbound message to a
// FileDurability journal, sends the first of two replies, reports it to the parent and
// then hangs until the parent kills it (a crash mid-handler).
import { Bot, FileDurability } from '../../lib/index.js'
import { MockProvider } from '../../lib/testing/index.js'

const file = process.argv[2]
const noop = () => {}
const logger = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, level: 'silent', child: () => logger }
const journal = await FileDurability.open(file)
const provider = new MockProvider()
const bot = new Bot({ provider, logger, durability: { journal, instanceId: 'proc-1' } })
bot.when('hola', async (ctx) => {
  await ctx.reply('uno')
  process.send?.({ sent: provider.outbox.map((m) => m.content.text) })
  await new Promise(() => {})
})
await bot.start()
provider.incoming('hola', { from: 'u1', id: 'm1' })
setInterval(() => {}, 1_000) // stay alive until killed
