import type { Bot, MessageContext } from '@bot-wa/core'
import { isAffirmative } from './confirm.js'
import type { ToolConfirmation, ToolConfirmer } from './types.js'

export interface SuspendingConfirmer {
  confirm: ToolConfirmer
  /** Resolves the first time a confirmation is requested (the handler may then return). */
  suspended: Promise<void>
}

/**
 * Confirmer for the autoreply (a catch-all handler running INSIDE the chat's FIFO).
 *
 * Waiting for the user's answer from the handler would deadlock the queue (the
 * answer is queued behind the handler). So, on the first confirmation, it enters
 * a short conversation via the runtime (fire-and-forget) that asks the question,
 * and signals `suspended` so the handler returns and frees the queue. The
 * dispatcher then delivers the user's next message to that conversation, which
 * resolves the confirmation; the tool loop resumes detached from the queue.
 * Any control error (timeout, `/reset`, replaced conversation) resolves to
 * `cancelled` and keeps propagating so the runtime handles it as usual.
 */
export function suspendingConfirmer(
  bot: Pick<Bot, 'enterConversation'>,
  mctx: MessageContext,
  opts: { yes?: readonly string[]; timeout?: number | string } = {},
): SuspendingConfirmer {
  let signalSuspended!: () => void
  const suspended = new Promise<void>((resolve) => { signalSuspended = resolve })
  const confirm: ToolConfirmer = (req) => new Promise<ToolConfirmation>((resolve) => {
    bot.enterConversation(async (c) => {
      let answer: string
      try {
        answer = await c.ask(req.prompt, opts.timeout !== undefined ? { timeout: opts.timeout } : undefined)
      } catch (err) {
        resolve('cancelled')
        throw err
      }
      resolve(isAffirmative(answer, opts.yes) ? 'approved' : 'denied')
    }, mctx)
    signalSuspended()
  })
  return { confirm, suspended }
}
