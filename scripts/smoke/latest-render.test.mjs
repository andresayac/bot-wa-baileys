// Run with: pnpm test:scripts
// The render token of docs/.vitepress/theme/Mermaid.vue: a stale render (one started
// before a theme toggle or a source change) must never overwrite the newer one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latestOnly } from '../../docs/.vitepress/theme/latest.mjs'

const tick = () => new Promise((r) => setTimeout(r, 0))

test('only the most recent call may commit its result', async () => {
  const latest = latestOnly()
  const committed = []
  const run = async (label, delayMs) => {
    const isCurrent = latest.begin()
    await new Promise((r) => setTimeout(r, delayMs))
    if (isCurrent()) committed.push(label)
  }
  // The light render is slow and finishes after the dark one started later.
  await Promise.all([run('light', 20), run('dark', 1)])
  assert.deepEqual(committed, ['dark'])
})

test('a single render commits', async () => {
  const latest = latestOnly()
  const isCurrent = latest.begin()
  await tick()
  assert.equal(isCurrent(), true)
})

test('cancel() invalidates the render in flight (component unmounted)', async () => {
  const latest = latestOnly()
  const isCurrent = latest.begin()
  latest.cancel()
  await tick()
  assert.equal(isCurrent(), false)
})
