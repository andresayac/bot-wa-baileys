/**
 * KeyedQueue — run async tasks one at a time per key (FIFO), concurrently across keys.
 *
 * The Bot routes its own chat upserts through one of these: every store merges a chat
 * record with a non-atomic read-modify-write, so two overlapping upserts of the same
 * chat (an inbound message and a `handoff`/`resume` write, say) could otherwise drop
 * one of the fields. A failed task never blocks the tasks queued behind it.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>()

  /** Run `task` after every task previously queued under `key` has settled. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    return result
  }

  /** Number of keys with queued or running tasks (diagnostics/tests). */
  get size(): number {
    return this.tails.size
  }
}
