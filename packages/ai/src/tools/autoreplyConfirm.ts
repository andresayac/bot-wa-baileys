import { parseDuration, RetriesExceeded, type Bot, type ConversationControls, type MessageContext, type MessageRef } from '@bot-wa/core'
import { AI_MESSAGES, aiText } from '../i18n.js'
import { classifyConfirmation } from './confirm.js'
import type { ToolConfirmation, ToolConfirmer, ToolConfirmRequest } from './types.js'

/**
 * Prefix of the ids (interaction data) of the Yes/No confirmation buttons:
 * `ai-confirm:<nonce>:yes` / `ai-confirm:<nonce>:no`. The nonce is unique per
 * confirmation, so a press on an older (answered, superseded, timed out)
 * confirmation never resolves a newer one.
 */
export const CONFIRM_BUTTON_PREFIX = 'ai-confirm:'

/** True when `data` (an interaction's data / a `buttons` message body) is a confirmation button id. */
export function isConfirmButtonId(data: string): boolean {
  return data.startsWith(CONFIRM_BUTTON_PREFIX)
}

/** Invalid answers (media, a sticker…) tolerated before the confirmation gives up, like `c.ask`. */
const MAX_INVALID = 3

let nonceSeq = 0
function newNonce(): string {
  return `${Date.now().toString(36)}${(++nonceSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

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
  /**
   * Ask with native Yes/No buttons when the chat's provider renders them
   * (`capabilities.buttons`). `false` always asks for a typed yes/no. Default `true`.
   */
  buttons?: boolean
}

/** The chat's provider renders native buttons (else they would degrade to numbered text). */
export function rendersButtons(ctx: Pick<MessageContext, 'capabilities'>): boolean {
  const caps = ctx.capabilities
  return caps?.buttons === true && caps.contentKinds.includes('buttons')
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
 * On a channel with native buttons the question goes out as a Yes/No buttons
 * message; a press resolves it exactly like typing yes/no (typed answers keep
 * working), the interaction is acknowledged, and once answered the buttons are
 * removed by editing the message when the provider can edit (best effort).
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
  const vocab = { yes: opts.yes, no: opts.no }
  const confirm: ToolConfirmer = async (req) => {
    if ((opts.canAsk && !opts.canAsk()) || bot.inspectConversation(mctx) !== undefined) return 'cancelled'
    let result: ToolConfirmation = 'cancelled'
    waiting = true
    const withButtons = opts.buttons !== false && rendersButtons(mctx)
    const ended = bot.enterConversation(async (c) => {
      if (withButtons) {
        result = await askWithButtons(c, mctx, req, opts.timeout, vocab)
        return
      }
      const answer = await c.ask(req.prompt, opts.timeout !== undefined ? { timeout: opts.timeout } : undefined)
      // Clear yes / clear no; anything else (a yes with changes too) goes back to the model.
      result = classifyConfirmation(answer, vocab)
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

/** A delivered message, seen through the interaction fields of a bot context. */
interface Delivered { type: string; body: string; acknowledge?(text?: string): Promise<void> }

/**
 * Ask with Yes/No buttons and wait for a press of THESE buttons or a typed answer.
 * Presses of other buttons (an older confirmation, another menu) are not taken:
 * they keep routing normally. Other messages (media…) re-ask, up to {@link MAX_INVALID}.
 */
async function askWithButtons(
  c: ConversationControls,
  mctx: MessageContext,
  req: ToolConfirmRequest,
  timeout: number | string | undefined,
  vocab: { yes?: readonly string[]; no?: readonly string[] },
): Promise<ToolConfirmation> {
  const nonce = newNonce()
  const ids = { yes: `${CONFIRM_BUTTON_PREFIX}${nonce}:yes`, no: `${CONFIRM_BUTTON_PREFIX}${nonce}:no` }
  const labels = { yes: aiText(mctx, AI_MESSAGES.buttonYes), no: aiText(mctx, AI_MESSAGES.buttonNo) }
  const text = req.buttonsPrompt ?? req.prompt
  const sent: MessageRef[] = []
  const ask = async () => {
    const msg = await mctx.buttons(text, [{ id: ids.yes, title: labels.yes }, { id: ids.no, title: labels.no }])
    if (!msg.skipped) sent.push(msg.ref)
  }
  const timeoutMs = timeout !== undefined ? parseDuration(timeout) : undefined
  let picked: 'yes' | 'no' | undefined
  try {
    await ask()
    for (let invalid = 0; ;) {
      const m = await c.waitAny({
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        // Button presses other than ours fall through to the normal routing.
        filter: (msg) => msg.type !== 'buttons' || msg.body === ids.yes || msg.body === ids.no,
      }) as Delivered
      if (m.type === 'buttons') {
        await acknowledge(m)
        picked = m.body === ids.yes ? 'yes' : 'no'
        return picked === 'yes' ? 'approved' : 'denied'
      }
      if (m.type === 'text') {
        const answer = classifyConfirmation(m.body, vocab)
        picked = answer === 'approved' ? 'yes' : answer === 'denied' ? 'no' : undefined
        return answer
      }
      if (++invalid >= MAX_INVALID) throw new RetriesExceeded()
      await ask()
    }
  } finally {
    // Answered, timed out or cancelled: take the buttons away so they cannot be pressed twice.
    await clearButtons(mctx, sent, picked ? `${text}\n\n→ ${labels[picked]}` : text)
  }
}

async function acknowledge(m: Delivered): Promise<void> {
  try { await m.acknowledge?.() } catch { /* best effort: the answer counts anyway */ }
}

/** Best effort: edit the buttons messages into plain text (no keyboard) where the provider edits. */
async function clearButtons(mctx: MessageContext, refs: readonly MessageRef[], text: string): Promise<void> {
  if (!mctx.capabilities?.edit) return
  for (const ref of refs) {
    try { await mctx.edit(ref, text, { fallback: 'skip' }) } catch { /* the buttons just stay */ }
  }
}
