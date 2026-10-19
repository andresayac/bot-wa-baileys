/**
 * A real process crash: a child bot journals a message to a FileDurability journal, sends
 * the first of two replies and is killed (by this test, which started it). A new bot on the
 * same journal replays the message: the reply that went out is not sent again, the missing
 * one is, and the journal lock of the dead process is taken over.
 */
import { fork } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Bot, FileDurability } from '../src/index.js'
import { MockProvider } from '../src/testing/index.js'

const child = fileURLToPath(new URL('./fixtures/durable-child.mjs', import.meta.url))
const built = existsSync(fileURLToPath(new URL('../lib/durability/file.js', import.meta.url)))

describe.skipIf(!built)('durability across a killed process', () => {
  it('replays the in-flight message without re-sending what went out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-proc-'))
    const file = join(dir, 'journal.json')
    try {
      const proc = fork(child, [file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
      const sent = await new Promise<string[]>((resolve, reject) => {
        proc.once('message', (m) => resolve((m as { sent: string[] }).sent))
        proc.once('exit', (code) => reject(new Error(`child exited early (${code})`)))
      })
      expect(sent).toEqual(['uno'])
      const exited = new Promise((r) => proc.once('exit', r))
      proc.kill('SIGKILL')
      await exited

      const journal = await FileDurability.open(file) // stale lock of the dead pid is taken over
      const provider = new MockProvider()
      const bot = new Bot({ provider, durability: { journal, instanceId: 'proc-1' } })
      const runs: string[] = []
      bot.when('hola', async (ctx) => { runs.push(ctx.body); await ctx.reply('uno'); await ctx.reply('dos') })
      await bot.start()
      await vi.waitFor(async () => expect((await bot.durability!.inbox.list())[0]?.state).toBe('done'))
      expect(runs).toEqual(['hola'])
      expect(provider.outbox.map((m) => (m.content as { text: string }).text)).toEqual(['dos'])
      expect((await bot.durability!.outbox.list()).map((r) => r.state)).toEqual(['sent', 'sent'])
      await bot.stop()
      await journal.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
