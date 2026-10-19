import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { KeyedQueue } from '../src/utils/keyedQueue.js'

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('KeyedQueue', () => {
  it('runs tasks of one key in FIFO order, one at a time', async () => {
    const q = new KeyedQueue()
    const log: string[] = []
    const gate = deferred()
    const a = q.run('k', async () => { log.push('a:start'); await gate.promise; log.push('a:end'); return 1 })
    const b = q.run('k', async () => { log.push('b'); return 2 })
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['a:start'])
    gate.resolve()
    expect(await a).toBe(1)
    expect(await b).toBe(2)
    expect(log).toEqual(['a:start', 'a:end', 'b'])
  })

  it('runs different keys concurrently', async () => {
    const q = new KeyedQueue()
    const gate = deferred()
    const log: string[] = []
    const a = q.run('a', async () => { await gate.promise; log.push('a') })
    await q.run('b', async () => { log.push('b') })
    expect(log).toEqual(['b'])
    gate.resolve()
    await a
    expect(log).toEqual(['b', 'a'])
  })

  it('a rejected task never blocks the tasks queued behind it', async () => {
    const q = new KeyedQueue()
    const failed = q.run('k', async () => { throw new Error('boom') })
    const next = q.run('k', async () => 'ok')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
  })

  it('drops idle keys', async () => {
    const q = new KeyedQueue()
    await q.run('k', async () => undefined)
    await new Promise((r) => setTimeout(r, 0))
    expect(q.size).toBe(0)
  })

  it('is the single per-key FIFO helper of the core (no duplicate KeyedMutex)', () => {
    const dup = fileURLToPath(new URL('../src/user/KeyedMutex.ts', import.meta.url))
    expect(existsSync(dup)).toBe(false)
  })
})
