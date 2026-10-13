import type { Trigger, TriggerScope, WaitOptions } from '../core/types.js'
import type { RuntimeMessage } from '../conversations/ConversationRuntime.js'
import type { ConversationControls } from '../conversations/controls.js'
import { normalizeText } from '../core/matching.js'
import { parseDuration } from '../utils/duration.js'

export type DynamicText = (ctx: RuntimeMessage, c: ConversationControls) => string | Promise<string>
export type FlowAction = (ctx: RuntimeMessage, c: ConversationControls) => unknown | Promise<unknown>

export type CompiledStep =
  | { kind: 'say'; text: string | DynamicText }
  | { kind: 'ask'; text: string | DynamicText; stateKey: string; opts?: WaitOptions }
  | {
      kind: 'do'
      fn: FlowAction
      /** Set by `.media()` so introspection (`describeFlows`/`lintFlows`) can tell a media send from an opaque action. */
      media?: { source: string; caption?: string }
    }
  | { kind: 'choose'; prompt: string; options: Record<string, { label: string; then?: CompiledFlow | FlowAction }>; stateKey?: string; opts?: WaitOptions }
  | { kind: 'goto'; target: string }

export interface CompiledFlow {
  id: string
  trigger: Trigger
  steps: CompiledStep[]
  opts: { timeoutMs?: number; persistent?: boolean; scope?: TriggerScope }
}

export function isCompiledFlow(x: unknown): x is CompiledFlow {
  return typeof x === 'object' && x !== null && 'steps' in x && 'trigger' in x && 'id' in x
}

export function flow(trigger: Trigger): FlowBuilder { return new FlowBuilder(trigger) }
/** Alias para migración desde bot-whatsapp/BuilderBot. */
export const addKeyword = flow

export class FlowBuilder {
  private steps: CompiledStep[] = []
  private _id?: string
  private _timeoutMs?: number
  private _persistent = false
  private _scope?: TriggerScope

  constructor(private trigger: Trigger) {}

  say(text: string | DynamicText): this { this.steps.push({ kind: 'say', text }); return this }

  ask(text: string | DynamicText, stateKey: string, opts?: WaitOptions): this {
    this.steps.push({ kind: 'ask', text, stateKey, opts }); return this
  }

  do(fn: FlowAction): this { this.steps.push({ kind: 'do', fn }); return this }

  media(source: string, caption?: string): this {
    this.steps.push({
      kind: 'do',
      fn: async (ctx) => { await (ctx as RuntimeMessage & { photo?(s: string, c?: string): Promise<unknown> }).photo?.(source, caption) },
      media: { source, caption },
    })
    return this
  }

  /**
   * Present a numbered menu and capture the selection. The picked option KEY is stored in
   * `c.state[stateKey]` (defaults to `c.state.choice`), so a later `.say`/`.do` can read it.
   */
  choose(
    prompt: string,
    options: Record<string, string | { label: string; then?: FlowBuilder | CompiledFlow | FlowAction }>,
    stateKey?: string,
  ): this {
    const compiled: Record<string, { label: string; then?: CompiledFlow | FlowAction }> = {}
    for (const [key, value] of Object.entries(options)) {
      if (typeof value === 'string') compiled[key] = { label: value }
      else compiled[key] = {
        label: value.label,
        then: value.then instanceof FlowBuilder ? value.then.compile() : value.then,
      }
    }
    this.steps.push({ kind: 'choose', prompt, options: compiled, stateKey })
    return this
  }

  goto(target: string | FlowBuilder): this {
    this.steps.push({ kind: 'goto', target: typeof target === 'string' ? target : target.compile().id })
    return this
  }

  timeout(d: string | number): this { this._timeoutMs = parseDuration(d); return this }
  persistent(): this { this._persistent = true; return this }
  scope(s: TriggerScope): this { this._scope = s; return this }
  id(explicit: string): this { this._id = explicit; return this }

  compile(): CompiledFlow {
    const id = this._id ?? deriveId(this.trigger)
    if (!id) {
      if (this._persistent) throw new Error('persistent() flows need a string trigger or an explicit .id("name")')
    }
    return {
      // Anonymous flows (no string trigger / explicit id) get a content hash PLUS a monotonic
      // counter so two structurally-identical anonymous flows can never collide on the same id
      // (which previously misrouted one flow's trigger into the other).
      id: id ?? `flow_${Math.abs(hashSteps(this.steps))}_${anonCounter++}`,
      trigger: applyScope(this.trigger, this._scope),
      steps: [...this.steps],   // copy: later builder mutations must not leak into a compiled flow
      opts: { timeoutMs: this._timeoutMs, persistent: this._persistent, scope: this._scope },
    }
  }
}

function applyScope(trigger: Trigger, scope: TriggerScope | undefined): Trigger {
  if (!scope) return trigger
  if (typeof trigger === 'function') {
    return (ctx) => {
      if (scope === 'dm' && ctx.isGroup) return false
      if (scope === 'group' && !ctx.isGroup) return false
      return trigger(ctx)
    }
  }
  if (typeof trigger === 'object' && trigger !== null && !(trigger instanceof RegExp) && !Array.isArray(trigger) && 'pattern' in trigger) {
    return { ...trigger, scope }
  }
  return { pattern: trigger, scope }
}

/** Module-level monotonic counter — guarantees unique anonymous flow ids per process. */
let anonCounter = 0

function deriveId(trigger: Trigger): string | undefined {
  if (typeof trigger === 'string') return normalizeText(trigger)
  if (Array.isArray(trigger)) {
    const s = trigger.find((t): t is string => typeof t === 'string')
    return s ? normalizeText(s) : undefined
  }
  if (typeof trigger === 'object' && trigger !== null && !(trigger instanceof RegExp) && 'pattern' in trigger) {
    return deriveId(trigger.pattern as Trigger)
  }
  return undefined
}

function hashSteps(steps: CompiledStep[]): number {
  // Hash structure AND content so distinct flows hash distinctly. Functions can't be hashed
  // meaningfully, so they contribute the literal 'fn'; the anonymous-id counter guarantees
  // uniqueness regardless. Included: kind, text, stateKey, choose option keys, goto target.
  const s = steps
    .map((step) => {
      const parts: string[] = [step.kind]
      switch (step.kind) {
        case 'say':
          parts.push(typeof step.text === 'string' ? step.text : 'fn')
          break
        case 'ask':
          parts.push(typeof step.text === 'string' ? step.text : 'fn', step.stateKey)
          break
        case 'choose':
          parts.push(step.prompt, Object.keys(step.options).join(','))
          break
        case 'goto':
          parts.push(step.target)
          break
        case 'do':
          parts.push('fn')
          break
      }
      return parts.join('~')
    })
    .join('|')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
