/**
 * HookSystem — middleware pipeline inspired by Koa (chains of `next()`).
 *
 * Phases per event:
 *   before(msg, next)  → run in order; can mutate / abort; pass via next()
 *   handler(msg)       → core handler (the flow matcher / user callback)
 *   after(msg)         → cleanup / metrics
 *   error(msg, err)    → if anything else throws
 *
 * Plugins register handlers with `bot.before('message', ...)` etc.
 */

import type { HookEvent, HookHandler, HookPhase } from '../core/types'
import { randomId } from '../utils/timers'

export interface RegisteredHook {
  id: string
  event: HookEvent
  phase: HookPhase
  handler: HookHandler
  priority: number
}

export class HookSystem {
  private hooks = new Map<`${HookEvent}:${HookPhase}`, RegisteredHook[]>()

  /** Register a hook. Returns an unsubscribe function. */
  register(
    event: HookEvent,
    phase: HookPhase,
    handler: HookHandler,
    priority = 0
  ): () => void {
    const key = `${event}:${phase}` as const
    const entry: RegisteredHook = { id: randomId('hook'), event, phase, handler, priority }
    const arr = this.hooks.get(key) ?? []
    arr.push(entry)
    arr.sort((a, b) => b.priority - a.priority) // higher priority first
    this.hooks.set(key, arr)
    return () => this.unregister(entry.id)
  }

  /** Remove a hook by id. */
  unregister(id: string): void {
    for (const [key, arr] of this.hooks.entries()) {
      const filtered = arr.filter((h) => h.id !== id)
      if (filtered.length === 0) this.hooks.delete(key)
      else this.hooks.set(key, filtered)
    }
  }

  /** Get all registered hooks for an event+phase. */
  list(event: HookEvent, phase: HookPhase): RegisteredHook[] {
    return [...(this.hooks.get(`${event}:${phase}` as const) ?? [])]
  }

  /** True if any hook exists for the event/phase. */
  has(event: HookEvent, phase?: HookPhase): boolean {
    if (phase) return this.hooks.has(`${event}:${phase}` as const)
    return ['before', 'after', 'error'].some((p) =>
      this.hooks.has(`${event}:${p as HookPhase}` as const)
    )
  }

  /**
   * Run the `before` pipeline. Handlers may call `next()` to pass control.
   * If a handler doesn't call next() (and doesn't `abort()`), the chain stops.
   * Throws `AbortSignal` if a handler aborts.
   */
  async runBefore<T>(event: HookEvent, ctx: T & { abort(): void }): Promise<boolean> {
    const hooks = this.list(event, 'before')
    let aborted = false

    // Wrap abort so we can detect it without mutating the original method
    const ctxAny = ctx as any
    const userAbort = ctxAny.abort?.bind(ctxAny)
    ctxAny.abort = () => { aborted = true; userAbort?.() }

    let index = -1
    const dispatch = async (i: number): Promise<void> => {
      if (aborted) return
      if (i >= hooks.length) return
      if (i <= index) throw new Error('next() called multiple times')
      index = i
      const handler = hooks[i].handler as any
      let calledNext = false
      const next = async () => {
        calledNext = true
        await dispatch(i + 1)
      }
      await handler(ctxAny, next)
      if (!calledNext && !aborted && i < hooks.length - 1) return
    }

    try {
      await dispatch(0)
    } finally {
      // Restore original abort if there was one
      if (userAbort) ctxAny.abort = userAbort
      else delete ctxAny.abort
    }
    return !aborted
  }

  /** Run the `after` pipeline. Errors are reported but don't propagate. */
  async runAfter<T>(event: HookEvent, ctx: T): Promise<void> {
    const hooks = this.list(event, 'after')
    for (const h of hooks) {
      try {
        await (h.handler as any)(ctx)
      } catch (err) {
        // After hooks shouldn't break the flow; surface but continue
        console.error(`[hooks] after-${event} handler ${h.id} threw:`, err)
      }
    }
  }

  /** Run the `error` pipeline. If no error handler registered, rethrow. */
  async runError<T>(event: HookEvent, ctx: T, error: unknown): Promise<void> {
    const hooks = this.list(event, 'error')
    if (hooks.length === 0) throw error
    for (const h of hooks) {
      try {
        await (h.handler as any)(ctx, error)
      } catch (err) {
        console.error(`[hooks] error-${event} handler ${h.id} threw:`, err)
      }
    }
  }

  /** Remove every hook. Useful for tests and teardown. */
  clear(): void {
    this.hooks.clear()
  }
}
