/**
 * Per-key mutual exclusion for the user-data service (`ctx.user` read-modify-writes).
 */

/**
 * KeyedMutex — FIFO async mutual exclusion per string key (internal).
 *
 * `run(key, task)` starts `task` only after every task previously queued under
 * the same key has settled; tasks under different keys run concurrently. A
 * rejected task never blocks the queue. Idle keys are dropped, so memory stays
 * proportional to the keys with work in flight.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(settled, settled)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }

  /** Number of keys with queued or running work. */
  get size(): number {
    return this.tails.size
  }
}

function settled(): void {}
