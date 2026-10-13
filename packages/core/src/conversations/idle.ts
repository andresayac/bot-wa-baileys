/**
 * `c.idle()` / `c.idleClear()` — per-conversation inactivity watchdog.
 *
 * The watchdog fires its callback once when `duration` passes without an inbound message
 * reaching the conversation's key; every inbound message (even one the pending wait filters
 * out) reschedules it, and after it fired the next inbound message re-arms it. It is disarmed
 * by `c.idleClear()`, by a new `c.idle()` call, and automatically when the conversation ends,
 * is aborted (`/reset`, `bot.abortConversation`) or the bot stops — so it never leaks timers.
 *
 * The callback runs OUTSIDE the conversation's call stack, so control calls are routed back
 * into it: `c.end(farewell)`, `c.goto(name)` (and any other conversation control error) end or
 * redirect the conversation at its pending wait — or at its next wait/`say` if it is busy.
 * `c.retry()` re-prompts the pending wait. Any other error is reported through the runtime's
 * `onError` (the bot `'error'` event) and the conversation keeps going.
 */

import type { ConversationHandle, ConversationRuntime, RuntimeMessage } from './ConversationRuntime.js'
import { ConversationCancelled, ConversationError } from './errors.js'
import { parseDuration } from '../utils/duration.js'

/**
 * Callback of `c.idle()`. Runs on a timer, outside the conversation's flow; it may reply,
 * call `c.end(farewell)` / `c.goto(name)` to finish the conversation, or `c.retry()` to
 * re-prompt the pending question. Thrown errors are reported, never unhandled.
 */
export type IdleCallback = () => unknown | Promise<unknown>

/** The idle half of the conversation controls. */
export interface IdleControls {
  idle(duration: string | number, callback: IdleCallback): void
  idleClear(): void
}

/** Build the idle controls for one live conversation. Internal — used by `createControls`. */
export function createIdleControls(rt: ConversationRuntime, handle: ConversationHandle, ctx: RuntimeMessage): IdleControls {
  let disarm: (() => void) | undefined

  const idleClear = (): void => {
    const d = disarm
    disarm = undefined
    d?.()
  }

  const idle = (duration: string | number, callback: IdleCallback): void => {
    const ms = parseDuration(duration)
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new RangeError(`c.idle() needs a positive, finite duration — got ${JSON.stringify(duration)}`)
    }
    rt.assertAlive(handle)                    // never arm a timer for a conversation that is gone
    idleClear()

    let timer: NodeJS.Timeout | undefined
    let disposed = false

    const run = async (): Promise<void> => {
      try {
        await callback()
      } catch (error) {
        if (error instanceof ConversationCancelled) return          // the conversation already ended
        if (error instanceof ConversationError) { rt.interrupt(handle, error); return }   // end/goto/retry…
        rt.reportError(error, ctx)
      }
    }
    const fire = (): void => {
      timer = undefined                        // once per idle period: the next inbound re-arms it
      void run()
    }
    const arm = (): void => {
      if (disposed) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, ms)
    }
    const dispose = (): void => {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      unobserve()
      if (disarm === dispose) disarm = undefined
    }
    const unobserve = rt.observe(handle, { inbound: arm, end: dispose })

    disarm = dispose
    arm()
  }

  return { idle, idleClear }
}
