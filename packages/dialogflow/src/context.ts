/**
 * DialogflowContext — per-message detectIntent results, keyed by the message
 * context object (so the result never leaks between messages), plus the
 * session mapping (one Dialogflow session per chat, or per participant).
 */

import type { MessageContext } from '@botmesh/core'
import { DialogflowClient, toSessionId, type DialogflowClientConfig, type DialogflowResult } from './client.js'

/** The bits of a message context the session mapping reads. */
export type SessionSubject = Pick<MessageContext, 'from' | 'sender' | 'isGroup'>

export interface DialogflowContextOptions {
  /** One session per chat (default) or, in groups, per participant. */
  sessionScope?: 'chat' | 'participant'
  /** Custom session key (overrides `sessionScope`). It is hashed before use. */
  sessionKey?: (ctx: SessionSubject) => string
  /** Minimum confidence for routing (default `0`). */
  minConfidence?: number
  /** Language per message (default: the client's `languageCode`). */
  languageFor?: (ctx: MessageContext) => string | undefined
  /** Extra `queryParams` per message. */
  queryParams?: (ctx: MessageContext) => Record<string, unknown> | undefined
}

export class DialogflowContext {
  readonly client: DialogflowClient
  readonly minConfidence: number
  private readonly results = new WeakMap<object, DialogflowResult>()
  private readonly routed = new Map<string, number>()

  constructor(
    clientOrConfig: DialogflowClient | DialogflowClientConfig,
    private readonly options: DialogflowContextOptions = {},
  ) {
    this.client = clientOrConfig instanceof DialogflowClient ? clientOrConfig : new DialogflowClient(clientOrConfig)
    this.minConfidence = options.minConfidence ?? 0
  }

  /** The raw (un-hashed) session key of a message. */
  sessionKeyFor(ctx: SessionSubject): string {
    if (this.options.sessionKey) return this.options.sessionKey(ctx)
    if (ctx.isGroup && this.options.sessionScope === 'participant') return `${ctx.from}\u0000${ctx.sender}`
    return ctx.from
  }

  /** The Dialogflow session id of a message (hashed session key). */
  sessionIdFor(ctx: SessionSubject): string {
    return toSessionId(this.sessionKeyFor(ctx))
  }

  /** Run detectIntent for this message, remember the result on it and return it. */
  async detect(ctx: MessageContext): Promise<DialogflowResult> {
    const result = await this.client.detectIntent(this.sessionIdFor(ctx), ctx.body, {
      languageCode: this.options.languageFor?.(ctx),
      queryParams: this.options.queryParams?.(ctx),
    })
    this.results.set(ctx, result)
    return result
  }

  /** The result the plugin's hook stored for this message context, if any. */
  resultFor(ctx: object): DialogflowResult | undefined {
    return this.results.get(ctx)
  }

  /** Store a result for a context (used by `detect`; handy in tests). */
  setResult(ctx: object, result: DialogflowResult): void {
    this.results.set(ctx, result)
  }

  /** True when the result matched an intent with enough confidence. */
  matches(result: DialogflowResult | undefined, intents: readonly string[], minConfidence = this.minConfidence): result is DialogflowResult {
    return !!result && result.intent !== null && intents.includes(result.intent) && result.confidence >= minConfidence
  }

  /** Register an intent as handled by a route (the fulfillment auto-reply skips it). */
  markRouted(intent: string): () => void {
    this.routed.set(intent, (this.routed.get(intent) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const n = (this.routed.get(intent) ?? 1) - 1
      if (n <= 0) this.routed.delete(intent)
      else this.routed.set(intent, n)
    }
  }

  isRouted(intent: string): boolean {
    return this.routed.has(intent)
  }
}
