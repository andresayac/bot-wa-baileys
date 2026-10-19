/**
 * Conversation hand-over between replicas (internal): the runtime-side policy types and
 * the pure helpers behind `coordination.handover` (see `ConversationRuntime`).
 *
 * - {@link isPlainJson}: whether a flow's `c.state` survives a JSON round trip unchanged,
 *   the condition to forward a flow WITHOUT `.persistent()` to another replica;
 * - {@link flowShape}: a fingerprint of a flow's steps, so a replica running a changed
 *   flow definition (rolling deploy) never resumes a forwarded flow at the wrong step.
 *
 * Nothing here runs unless `coordination` is configured.
 */
import { createHash } from 'node:crypto'
import type { CompiledFlow, CompiledStep } from '../flows/FlowBuilder.js'
import { isCompiledFlow } from '../flows/FlowBuilder.js'
import type { CheckpointAnswer } from '../core/provider.js'
import type { RuntimeMessage } from './ConversationRuntime.js'
import type { ConversationHandoverEvent, InterruptedConversation } from '../coordination/types.js'

export type { InterruptedConversation }
/** Outcome reported by the `'coordination:handover'` event. */
export type HandoverOutcome = ConversationHandoverEvent['outcome']

/** A custom fallback: return `true` when it consumed the waking message. */
export type RuntimeHandoverFallback = (info: InterruptedConversation, ctx: RuntimeMessage) => boolean | Promise<boolean>

/** The runtime's resolved hand-over policy (built by the Bot from `coordination.handover`). */
export interface RuntimeHandover {
  flows: 'forward' | 'drop'
  fallback: 'notify' | 'restart' | 'drop' | RuntimeHandoverFallback
  /** `'notify'` text; default: the localized `CORE_MESSAGES.conversationInterrupted`. */
  notifyMessage?: string
  /** Lifetime of an ephemeral checkpoint / stub after its last write (ms). */
  ttlMs: number
  /** Observability (`'coordination:handover'`). Must not throw. */
  onHandover?: (event: ConversationHandoverEvent) => void
}

/** Captures the answer of a flow step's first wait into its checkpoint, and reads it back. */
export interface AnswerCodec {
  /**
   * `undefined`: this answer cannot be recorded (too large, unknown context). `causeId`: the
   * durability cause the answer was delivered under (its inbox record id), when there is one.
   */
  capture(ctx: RuntimeMessage, causeId?: string): Omit<CheckpointAnswer, 'cause' | 'at'> | undefined
  /** `undefined`: the answer is no longer available (journal purged, decode error). */
  rehydrate(answer: CheckpointAnswer): Promise<RuntimeMessage | undefined>
}

/**
 * True when `value` is plain JSON data that a JSON round trip returns unchanged: `null`,
 * booleans, finite numbers, strings, arrays (no holes, no `undefined`) and plain objects
 * (`undefined` properties are allowed — JSON drops them, so does a checkpoint). Functions,
 * class instances (Date, Map, Buffer, …), symbols, bigints and cycles are not.
 */
export function isPlainJson(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string': case 'boolean': return true
    case 'number': return Number.isFinite(value)
    case 'object': break
    default: return false
  }
  const obj = value as object
  if (seen.has(obj)) return false
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj) || obj[i] === undefined || !isPlainJson(obj[i], seen)) return false
      }
      return true
    }
    const proto = Object.getPrototypeOf(obj) as object | null
    if (proto !== Object.prototype && proto !== null) return false
    for (const v of Object.values(obj)) {
      if (v !== undefined && !isPlainJson(v, seen)) return false
    }
    return true
  } finally {
    seen.delete(obj)
  }
}

/** Fingerprint of `flow`'s step structure (kinds, state keys, sub-flows), stable across processes. */
export function flowShape(flow: CompiledFlow): string {
  return createHash('sha256').update(describeSteps(flow, new Set())).digest('base64url').slice(0, 16)
}

function describeSteps(flow: CompiledFlow, seen: Set<CompiledFlow>): string {
  if (seen.has(flow)) return `@${flow.id}`
  seen.add(flow)
  const parts = flow.steps.map((s) => describeStep(s, seen))
  seen.delete(flow)
  return `${flow.id}[${parts.join(',')}]`
}

function describeStep(step: CompiledStep, seen: Set<CompiledFlow>): string {
  switch (step.kind) {
    case 'ask': return `ask:${step.stateKey}`
    case 'use': return `use:${describeSteps(step.flow, seen)}`
    case 'goto': return `goto:${step.target}`
    case 'choose': {
      const options = Object.entries(step.options).map(([k, v]) => {
        const then = isCompiledFlow(v.then) ? describeSteps(v.then, seen) : typeof v.then === 'function' ? 'fn' : ''
        return `${k}${then ? `>${then}` : ''}${v.goto !== undefined ? `>>${v.goto}` : ''}`
      })
      return `choose:${step.stateKey ?? 'choice'}{${options.join('|')}}`
    }
    default: return step.kind
  }
}

/** Default hand-over lifetime when neither `handover.ttl` nor `conversation.timeout` is set. */
export const DEFAULT_HANDOVER_TTL_MS = 300_000
