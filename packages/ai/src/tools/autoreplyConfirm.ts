import type { Bot, MessageContext } from '@bot-wa/core'
import { classifyConfirmation } from './confirm.js'
import type { ToolConfirmation, ToolConfirmer } from './types.js'

export interface SuspendingConfirmer {
  confirm: ToolConfirmer
  /** Resolves the first time a confirmation is requested (the handler may then return). */
  suspended: Promise<void>
  /** True once the turn has been detached from the chat's queue (a confirmation was asked). */
  isDetached(): boolean
  /** True while a confirmation question is waiting for the user's answer. */
  isWaiting(): boolean
}

export interface SuspendingConfirmerOptions {
  yes?: readonly string[]
  no?: readonly string[]
  timeout?: number | string
  /**
   * Checked before every confirmation. When it returns false the confirmation
   * resolves `cancelled` without asking (e.g. a newer turn superseded this one).
   */
  canAsk?: () => boolean
}

/**
 * Confirmer for the autoreply (a catch-all handler running INSIDE the chat's FIFO).
 *
 * Waiting for the user's answer from the handler would deadlock the queue (the
 * answer is queued behind the handler). So, on the first confirmation, it enters
 * a short conversation via the runtime (fire-and-forget) that asks the question,
 * and signals `suspended` so the handler returns and frees the queue. The
 * dispatcher then delivers the user's next message to that conversation, which
 * resolves the confirmation (once the conversation has released its key); the
 * tool loop resumes detached from the queue.
 *
 * A confirmation never replaces a conversation that is already active on the
 * chat (e.g. a flow the user started while the detached turn was running): it
 * resolves `cancelled` instead, as it does when `canAsk()` says no. Any control
 * error (timeout, `/reset`, replaced conversation) also resolves to `cancelled`
 * and keeps propagating so the runtime handles it as usual.
 */
export function suspendingConfirmer(
  bot: Pick<Bot, 'enterConversation' | 'inspectConversation'>,
  mctx: MessageContext,
  opts: SuspendingConfirmerOptions = {},
): SuspendingConfirmer {
  let signalSuspended!: () => void
  const suspended = new Promise<void>((resolve) => { signalSuspended = resolve })
  let detached = false
  let waiting = false
  const confirm: ToolConfirmer = async (req) => {
    if ((opts.canAsk && !opts.canAsk()) || bot.inspectConversation(mctx) !== undefined) return 'cancelled'
    let result: ToolConfirmation = 'cancelled'
    waiting = true
    const ended = bot.enterConversation(async (c) => {
      const answer = await c.ask(req.prompt, opts.timeout !== undefined ? { timeout: opts.timeout } : undefined)
      // Clear yes / clear no; anything else (a yes with changes too) goes back to the model.
      result = classifyConfirmation(answer, { yes: opts.yes, no: opts.no })
    }, mctx)
    detached = true
    signalSuspended()
    // Settles (never rejects) after the runtime has cleaned the conversation up, so the
    // rest of the turn never mistakes it for a conversation the user started.
    await ended
    waiting = false
    return result
  }
  return { confirm, suspended, isDetached: () => detached, isWaiting: () => waiting }
}
