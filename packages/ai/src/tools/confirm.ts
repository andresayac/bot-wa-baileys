import type { ConversationControls } from '@bot-wa/core'
import type { ToolConfirmation, ToolConfirmer } from './types.js'

/** Answers accepted as "yes" by default (compared normalized: lowercase, no accents/punctuation). */
export const DEFAULT_YES = ['si', 's', 'yes', 'y', 'ok', 'okay', 'confirmo', 'confirmar', 'dale', 'claro', 'de acuerdo', 'acepto', '1']

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** True when `answer` is one of the accepted "yes" words (accent/case-insensitive). */
export function isAffirmative(answer: string, yes: readonly string[] = DEFAULT_YES): boolean {
  const a = normalize(answer)
  return a.length > 0 && yes.some((y) => normalize(y) === a)
}

export interface ConfirmWithOptions {
  /** Accepted "yes" answers (default {@link DEFAULT_YES}). */
  yes?: readonly string[]
  /** Wait timeout (`'2m'`, ms). On expiry the conversation's timeout handling applies and the turn is cancelled. */
  timeout?: number | string
}

/**
 * Build a {@link ToolConfirmer} that asks through a live conversation's controls.
 * Use it when calling the AI from inside your own `bot.conversation()` /
 * `flow().do()` — e.g. `ctx.tools.ai.replyInChat(key, text, { ctx, confirm: confirmWith(c) })`.
 * Waiting with `c.ask` never blocks the chat FIFO: the user's answer is delivered
 * to the conversation by the runtime.
 */
export function confirmWith(c: Pick<ConversationControls, 'ask'>, opts: ConfirmWithOptions = {}): ToolConfirmer {
  return async (req): Promise<ToolConfirmation> => {
    // A control error (timeout / cancel / replaced conversation) propagates as-is out of
    // the tool loop and up the conversation, so the runtime handles it as usual.
    const answer = await c.ask(req.prompt, opts.timeout !== undefined ? { timeout: opts.timeout } : undefined)
    return isAffirmative(answer, opts.yes) ? 'approved' : 'denied'
  }
}
