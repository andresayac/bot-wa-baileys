/**
 * Conversation turns as spans. A conversation is not one span (it can last days): each
 * stretch of work between two waits is a `bot.conversation.turn` span.
 *
 * - the first turn starts under the handler that entered it (`reason: start|dormant`); a
 *   `c.goto()` target's first turn starts under the turn that ran the goto (`reason: goto`);
 * - a reply re-opens it under the dispatch span of the message that answered the wait
 *   (`reason: reply`);
 * - a wait timeout, or a `c.idle()` callback firing while the conversation is parked
 *   (`ConversationRuntime.runIdle`), opens a ROOT turn linked to the first one
 *   (`reason: timeout|idle`): no message caused it. An idle turn parks again when the
 *   callback leaves the conversation on the same wait;
 * - a conversation aborted while parked (`/reset`, handoff, stop) gets a closing turn
 *   (`reason: end`) under the active span, linked to the first one;
 * - a conversation resumed from a checkpoint written by another replica or an earlier
 *   process (`reason: dormant`, or `start` for a hand-over stub restarted) starts under the
 *   waking message's dispatch and LINKS to the turn that wrote the checkpoint
 *   (`FlowCheckpoint.trace`, W3C trace context; link attribute `bot.link.reason = resume`).
 *   A link, not a parent: the waking message's own trace stays whole, and a conversation
 *   parked for hours does not stretch one trace across processes and exports;
 * - parking on a wait ends the turn (`bot.conversation.parked = true`); the end of the
 *   conversation ends the open turn with `bot.conversation.outcome`.
 *
 * The conversation runs inside its own mutable {@link ConversationTraceBox}; each turn
 * re-points it, so spans created by the conversation's code (sends, AI calls) land under
 * the turn that is running. Injected into `ConversationRuntime` only when tracing is on.
 */
import { TRACE_ATTR, SPAN_NAMES } from './attributes.js'
import type { TraceBox } from './context.js'
import type { TracingImpl } from './tracing.js'
import type { SpanContextRef, SpanLink } from './types.js'
import { fromCheckpointTrace, toCheckpointTrace, type CheckpointTrace } from './w3c.js'
import type { ConversationTraceHooks, ConversationTurnTrace } from '../conversations/ConversationRuntime.js'

/** Why a turn span started. */
export type TurnReason = 'start' | 'goto' | 'dormant' | 'reply' | 'timeout' | 'idle' | 'end'

/** The trace state of one live conversation. */
export interface ConversationTraceBox extends TraceBox {
  conversation: true
  /** A turn span is open (not parked, not ended). */
  open: boolean
  readonly id: string
  readonly name: string
  /** The first turn, linked from turns no message caused. */
  readonly first?: SpanContextRef
}

export class ConversationTracing implements ConversationTraceHooks {
  constructor(private readonly t: TracingImpl) {}

  /** A conversation was entered: its first turn starts under the active span. */
  begin(info: { id: string; name: string }, reason: 'start' | 'goto' | 'dormant', from?: CheckpointTrace): ConversationTraceBox {
    const previous = fromCheckpointTrace(from)
    const links: SpanLink[] | undefined = previous
      ? [{ context: previous, attributes: { [TRACE_ATTR.linkReason]: 'resume' } }]
      : undefined
    const span = this.t.startSpan(SPAN_NAMES.conversationTurn, {
      ...(links ? { links } : {}),
      attributes: {
        [TRACE_ATTR.conversationId]: info.id,
        [TRACE_ATTR.conversationName]: info.name,
        [TRACE_ATTR.conversationReason]: reason,
      },
    })
    const first = span.spanContext()
    return { span, conversation: true, open: true, id: info.id, name: info.name, ...(first ? { first } : {}) }
  }

  /** The W3C context of the conversation's current (or last parked) turn, for its checkpoints. */
  carry(trace: ConversationTurnTrace): CheckpointTrace | undefined {
    return toCheckpointTrace((trace as ConversationTraceBox).span.spanContext())
  }

  /** Run the conversation function inside its box (synchronous start; returns its promise unchanged). */
  run<T>(box: ConversationTurnTrace, fn: () => T): T {
    return this.t.runInBox(box as ConversationTraceBox, fn)
  }

  /** The conversation resumes: a new turn (see the module comment for its parent). */
  resume(trace: ConversationTurnTrace, reason: 'reply' | 'timeout' | 'idle' | 'end'): void {
    const box = trace as ConversationTraceBox
    if (box.open) box.span.end()
    // A reply (or an abort by a message) runs under the active span; a timer has no cause.
    const caused = reason === 'reply' || reason === 'end'
    const span = this.t.startSpan(SPAN_NAMES.conversationTurn, {
      ...(caused ? {} : { parent: null }),
      ...(reason !== 'reply' && box.first ? { links: [{ context: box.first }] } : {}),
      attributes: {
        [TRACE_ATTR.conversationId]: box.id,
        [TRACE_ATTR.conversationName]: box.name,
        [TRACE_ATTR.conversationReason]: reason,
      },
    })
    box.span = span
    box.open = true
  }

  /** The conversation blocked on a wait: its turn ends. */
  park(trace: ConversationTurnTrace): void {
    const box = trace as ConversationTraceBox
    if (!box.open) return
    box.span.setAttribute(TRACE_ATTR.conversationParked, true)
    box.span.end()
    box.open = false
  }

  /** The conversation ended: the open turn (or a closing one, when it ended while parked) gets the outcome. */
  end(trace: ConversationTurnTrace, outcome: string, goto?: string): void {
    const box = trace as ConversationTraceBox
    if (!box.open) this.resume(box, 'end')
    box.span.setAttributes({ [TRACE_ATTR.conversationOutcome]: outcome, [TRACE_ATTR.conversationGoto]: goto })
    if (outcome === 'error') box.span.setStatus({ code: 'error' })
    box.span.end()
    box.open = false
  }
}
