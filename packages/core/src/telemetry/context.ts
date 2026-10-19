/**
 * The core's trace context: which span the current async chain runs under, carried with
 * AsyncLocalStorage (separate from the dispatcher slot and the durability cause).
 *
 * Same "box" pattern as `durability/causation.ts`: ALS follows the awaiter, not the
 * resolver, so a conversation started by message 1 would keep seeing message 1's span
 * after `c.ask()` is answered by message 2. Each conversation runs in its own mutable
 * box instead, and delivering message N re-points it at the turn started for N.
 *
 * Nothing here is reached unless `BotConfig.telemetry` is set: without it no box is
 * ever entered and {@link activeBox} is a cheap `undefined`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import type { BotSpan } from './types.js'

/** A mutable pointer at the span the current async chain works under. */
export interface TraceBox {
  span: BotSpan
  /** Set on a conversation's own box (flow step events go to its current turn). */
  conversation?: boolean
}

const als = new AsyncLocalStorage<TraceBox>()

/** The box of the current async chain, if any. */
export function activeBox(): TraceBox | undefined { return als.getStore() }

/** Run `fn` with `box` as the current box (synchronously; returns `fn`'s value unchanged). */
export function enterBox<T>(box: TraceBox, fn: () => T): T { return als.run(box, fn) }

/**
 * A DSL flow step starts: a `flow.step` event on the conversation's current turn. No-op
 * outside a traced conversation (tracing off, or a flow run directly).
 */
export function traceFlowStep(flowId: string, index: number, kind: string): void {
  const box = als.getStore()
  if (!box?.conversation) return
  box.span.addEvent('flow.step', { 'bot.flow.id': flowId, 'bot.flow.step.index': index, 'bot.flow.step.kind': kind })
}
