import type { ConversationControls, MessageContext } from '@bot-wa/core'
import { askWithButtons, rendersButtons } from './autoreplyConfirm.js'
import type { ToolConfirmation, ToolConfirmer } from './types.js'

/** Answers accepted as "yes" by default (compared normalized: lowercase, no accents/punctuation). */
export const DEFAULT_YES = [
  'si', 's', 'yes', 'y', 'ok', 'okay', 'confirmo', 'confirmar', 'dale', 'claro', 'de acuerdo', 'acepto', '1',
  'vale', 'listo', 'perfecto', 'adelante', 'hazlo', 'correcto', 'esta bien', 'sure', 'yeah', 'yep',
]

/** Answers taken as "no" by default (same normalization as {@link DEFAULT_YES}). */
export const DEFAULT_NO = ['no', 'n', 'nop', 'nope', 'nel', 'cancelar', 'cancela', 'cancelo', 'cancel', 'negativo', 'mejor no', 'para nada', 'tampoco', 'no gracias', '2', '0']

/**
 * Courtesy words that may surround a yes/no without changing it
 * ("sí, por favor", "no, gracias", "ok perfecto"). Anything else in the answer
 * makes it a modification (see {@link classifyConfirmation}).
 */
const FILLER = new Set([
  'por', 'favor', 'porfa', 'porfavor', 'gracias', 'please', 'pls', 'thanks', 'thank', 'you', 'senor', 'senora',
  'perfecto', 'listo', 'adelante', 'hazlo', 'hagale', 'correcto', 'exacto', 'vale', 'va', 'sale', 'bueno', 'genial',
  'sure', 'go', 'ahead', 'do', 'it', 'great', 'perfect', 'fine', 'right', 'correct', 'yeah', 'yep', 'yup', 'of', 'course',
  'entonces', 'asi', 'eso', 'esta', 'bien', 'muy', 'seguro', 'obvio', 'mejor', 'way', 'thx',
])

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** True when `answer` is one of the accepted "yes" words (accent/case-insensitive). */
export function isAffirmative(answer: string, yes: readonly string[] = DEFAULT_YES): boolean {
  const a = normalize(answer)
  return a.length > 0 && yes.some((y) => normalize(y) === a)
}

/** Vocabulary of {@link classifyConfirmation}. */
export interface ConfirmVocabulary {
  /** Accepted "yes" answers (default {@link DEFAULT_YES}). */
  yes?: readonly string[]
  /** Accepted "no" answers (default {@link DEFAULT_NO}). */
  no?: readonly string[]
}

/** Remove the (longest first) phrases of `words` from the token list; true when at least one matched. */
function consume(tokens: string[], words: readonly string[]): { rest: string[]; hit: boolean } {
  const phrases = words.map(normalize).filter(Boolean).map((w) => w.split(' ')).sort((a, b) => b.length - a.length)
  const rest: string[] = []
  let hit = false
  for (let i = 0; i < tokens.length;) {
    const match = phrases.find((p) => p.every((t, j) => tokens[i + j] === t))
    if (match) { hit = true; i += match.length } else { rest.push(tokens[i]!); i++ }
  }
  return { rest, hit }
}

/**
 * Classify the user's answer to a confirmation question:
 * - `'approved'` — only "yes" words and courtesy filler ("sí", "sí, por favor", "ok perfecto");
 * - `'denied'` — only "no" words and filler ("no", "no, gracias", "cancelar");
 * - `{ reply }` — anything else, including a "yes" that adds changes
 *   ("sí pero cambia a 5 unidades"): the tool is NOT run and the text goes
 *   back to the model so it can adjust the arguments and ask again.
 */
export function classifyConfirmation(answer: string, vocab: ConfirmVocabulary = {}): ToolConfirmation {
  const tokens = normalize(answer).split(' ').filter(Boolean)
  const reply = { reply: answer.trim() }
  if (tokens.length === 0) return reply
  const yes = consume(tokens, vocab.yes ?? DEFAULT_YES)
  const no = consume(tokens, vocab.no ?? DEFAULT_NO)
  const onlyFiller = (rest: string[]) => rest.every((t) => FILLER.has(t))
  if (yes.hit && !no.hit && onlyFiller(yes.rest)) return 'approved'
  if (no.hit && !yes.hit && onlyFiller(no.rest)) return 'denied'
  return reply
}

export interface ConfirmWithOptions extends ConfirmVocabulary {
  /** Wait timeout (`'2m'`, ms). On expiry the conversation's timeout handling applies and the turn is cancelled. */
  timeout?: number | string
  /**
   * Ask with native Yes/No buttons when the chat's provider renders them
   * (`capabilities.buttons`), like the autoreply does. `false` always asks for a typed
   * yes/no. Default `true`. Needs the turn's context: the `ctx` given to
   * `replyInChat(..., { ctx })` (or {@link ctx}) and controls with `waitAny`.
   */
  buttons?: boolean
  /** Context of the chat to send the buttons to. Default: the `ctx` of the AI call. */
  ctx?: MessageContext
  /**
   * On a channel that cannot edit messages (WhatsApp Cloud API, Messenger, Instagram),
   * reply a short localized `ai.tools.confirmAnswered` after a press answers. Default `false`.
   */
  answeredNotice?: boolean
}

/**
 * Build a {@link ToolConfirmer} that asks through a live conversation's controls.
 * Use it when calling the AI from inside your own `bot.conversation()` /
 * `flow().do()` — e.g. `ctx.tools.ai.replyInChat(key, text, { ctx, confirm: confirmWith(c) })`.
 * Waiting never blocks the chat FIFO: the user's answer is delivered to the
 * conversation by the runtime. The answer is classified with {@link classifyConfirmation}.
 *
 * On a channel with native buttons it asks with Yes/No buttons, with the autoreply's
 * semantics: a press answers like typing yes/no (typing keeps working), the interaction
 * is acknowledged, the buttons are edited away once answered where the provider edits,
 * and a later press of them is acknowledged and dropped (it never answers a later
 * question of your conversation; needs `aiPlugin` with tools installed).
 */
export function confirmWith(
  c: Pick<ConversationControls, 'ask'> & Partial<Pick<ConversationControls, 'waitAny'>>,
  opts: ConfirmWithOptions = {},
): ToolConfirmer {
  return async (req): Promise<ToolConfirmation> => {
    // A control error (timeout / cancel / replaced conversation) propagates as-is out of
    // the tool loop and up the conversation, so the runtime handles it as usual.
    const ctx = opts.ctx ?? req.ctx
    if (opts.buttons !== false && ctx && typeof c.waitAny === 'function' && rendersButtons(ctx)) {
      return askWithButtons({ waitAny: (o) => c.waitAny!(o) }, ctx, req, {
        timeout: opts.timeout, yes: opts.yes, no: opts.no, answeredNotice: opts.answeredNotice,
      })
    }
    const answer = await c.ask(req.prompt, opts.timeout !== undefined ? { timeout: opts.timeout } : undefined)
    return classifyConfirmation(answer, opts)
  }
}
