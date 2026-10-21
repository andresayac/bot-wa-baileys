// Child process for the hand-over integration test: joins as replica "dying" with Redis
// coordination, checkpoints and durability; enters the `signup` flow, answers its first
// question and then sits in a validator that never returns. It prints "answered" once the
// answer is recorded in the checkpoint; the parent then kills it (no cleanup runs).
// Usage: node handover-child.mjs <redisUrl> <prefix> <chatId>
import { Bot, flow } from '@botmesh/core'
import { MockProvider } from '@botmesh/core/testing'
import { RedisCoordinator, RedisDurability, RedisStore } from '../../lib/index.js'

const [url, prefix, chatId] = process.argv.slice(2)
const noop = () => {}
const logger = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, level: 'silent' }
logger.child = () => logger

const provider = new MockProvider()
const store = new RedisStore({ url, prefix })
const bot = new Bot({
  provider,
  store,
  logger,
  coordination: { coordinator: new RedisCoordinator({ url, prefix, replicaId: 'dying', leaseMs: 1_000, maxPollMs: 20 }) },
  durability: { journal: new RedisDurability({ url, prefix }), instanceId: 'dying', pollMs: 50, inbox: { leaseMs: 1_000 } },
})
bot.use(flow('signup').persistent()
  .say('hi')
  .ask('name?', 'name', { validate: () => new Promise(() => {}) })   // never settles on this replica
  .ask('email?', 'email')
  .say((_ctx, c) => `done ${String(c.state.name)} ${String(c.state.email)}`))
await bot.start()

provider.incoming('signup', { from: chatId, id: 'child-1' })
while (!provider.outbox.some((m) => m.content.kind === 'text' && m.content.text === 'name?')) await sleep(10)
provider.incoming('Ana', { from: chatId, id: 'child-2' })
for (;;) {
  const cps = await store.listCheckpoints()
  if (cps.some(([, cp]) => cp.answer !== undefined)) break
  await sleep(10)
}
process.stdout.write('answered\n')
setInterval(() => {}, 60_000)

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
