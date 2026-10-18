import type { Trigger, TriggerScope, WaitOptions } from '../core/types.js'
import type { MediaSource } from '../core/provider.js'
import type { RuntimeMessage } from '../conversations/ConversationRuntime.js'
import type { ConversationControls } from '../conversations/controls.js'
import { normalizeText } from '../core/matching.js'
import { isTypeTrigger, isWelcomeTrigger } from '../core/triggers.js'
import { parseDuration } from '../utils/duration.js'
import { MAX_TIMER_MS } from '../utils/timers.js'
import type { SchemaLike } from './schema.js'
import {
  isFlowMediaKind,
  type DynamicMediaSource,
  type FlowFileMediaKind,
  type FlowLocation,
  type FlowMediaKind,
  type FlowMediaOptions,
  type FlowMediaSource,
} from './media.js'
import type { FormDefinition, FormStepOptions } from '../forms/types.js'
import { assertFormDefinition } from '../forms/validate.js'

/* ============================================================================
 * TYPED FLOW STATE
 * ========================================================================== */

/** Empty flow state — the default of `flow<S>()`. */
export type EmptyFlowState = Record<never, never>

/**
 * Conversation controls as seen by a flow step: `c.state` carries the keys the flow captured
 * so far (`.ask(..., 'edad', { schema })` → `c.state.edad: number`) plus any other key as `unknown`.
 */
export type FlowControls<S extends object = EmptyFlowState> = ConversationControls & { state: S & Record<string, unknown> }

/**
 * `S` with key `K` set to `V` (replacing any previous type of `K`). A non-literal key
 * (`K = string`) cannot be tracked, so `S` is returned unchanged — the value stays reachable
 * as `unknown` through the open index signature of {@link FlowControls}.
 */
export type FlowStateWith<S, K extends string, V> = string extends K
  ? S
  : { [P in keyof S | K]: P extends K ? V : P extends keyof S ? S[P] : never }

/** `S` merged with `T` (keys of `T` win) — the state after `.use(subFlow)`. */
export type FlowStateMerge<S, T> = { [P in keyof S | keyof T]: P extends keyof T ? T[P] : P extends keyof S ? S[P] : never }

/** State type captured by a builder: `FlowStateOf<typeof registro>`. */
export type FlowStateOf<F> = F extends FlowBuilder<infer S> ? S : never

export type DynamicText<S extends object = EmptyFlowState> = (ctx: RuntimeMessage, c: FlowControls<S>) => string | Promise<string>
export type FlowAction<S extends object = EmptyFlowState> = (ctx: RuntimeMessage, c: FlowControls<S>) => unknown | Promise<unknown>
/** `.guard()` predicate: a falsy result stops the flow. */
export type FlowGuard<S extends object = EmptyFlowState> = (ctx: RuntimeMessage, c: FlowControls<S>) => unknown | Promise<unknown>

/** A pause before a step is sent: `'2s'`, `'500ms'`, or milliseconds. */
export type FlowDelay = string | number

/** Options of `.say(text, opts)`. */
export interface SayStepOptions { delay?: FlowDelay }

/** Options of `.ask(text, key, opts)`: every wait option plus a zod-compatible `schema` and a `delay`. */
export interface AskStepOptions<T = string> extends WaitOptions {
  /**
   * Validate (and transform) the answer with any `safeParse()` schema (zod-compatible). The parsed
   * value is stored in `c.state[key]`; a rejected answer re-prompts with `otherwise`, else the
   * schema's first issue message. Runs after `validate`.
   */
  schema?: SchemaLike<T>
  delay?: FlowDelay
}

/** Options of `.choose(prompt, options, stateKey, opts)`. */
export interface ChooseStepOptions extends WaitOptions { delay?: FlowDelay }

/** What a `.guard()` does when its predicate fails. A string / dynamic text is a farewell message (the conversation ends). */
export type GuardFailure<S extends object = EmptyFlowState> =
  | string
  | DynamicText<S>
  | {
      /** Message sent before ending (or before redirecting). */
      message?: string | DynamicText<S>
      /** Jump to another conversation instead of ending (like `c.goto(name)`). */
      redirect?: string | FlowBuilder<object>
    }

/** One option of `.choose()`: a label, or a label plus what happens when it is picked. */
export type ChooseOption<S extends object = EmptyFlowState> =
  | string
  | {
      label: string
      /** Inline sub-flow (runs and RETURNS to the parent, sharing `c.state`) or an action. */
      then?: FlowBuilder<object> | CompiledFlow | FlowAction<S>
      /** Leave this flow for another conversation (e.g. `volver: { label: 'Volver', goto: menu }`). */
      goto?: string | FlowBuilder<object>
    }

/* ============================================================================
 * COMPILED FLOWS
 * ========================================================================== */

/** Compiled `.ask()` options (`delay` is lifted to the step). */
export type CompiledAskOptions = WaitOptions & { schema?: SchemaLike<unknown> }

export interface CompiledChooseOption {
  label: string
  then?: CompiledFlow | FlowAction
  /** Target conversation when the option leaves the flow. */
  goto?: string
}

export type CompiledStep =
  | { kind: 'say'; text: string | DynamicText; delayMs?: number }
  | { kind: 'ask'; text: string | DynamicText; stateKey: string; opts?: CompiledAskOptions; delayMs?: number }
  | {
      kind: 'do'
      fn: FlowAction
      /** Legacy tag (flows compiled by older versions); `.media()` now compiles to a `media` step. */
      media?: { source: string; caption?: string }
    }
  | { kind: 'choose'; prompt: string; options: Record<string, CompiledChooseOption>; stateKey?: string; opts?: WaitOptions; delayMs?: number }
  | { kind: 'goto'; target: string }
  | { kind: 'media'; type: FlowMediaKind; source: FlowMediaSource; caption?: string; opts?: Omit<FlowMediaOptions, 'delay'>; delayMs?: number }
  | { kind: 'guard'; check: FlowGuard; message?: string | DynamicText; redirect?: string }
  | { kind: 'use'; flow: CompiledFlow }
  | { kind: 'delay'; ms: number }
  /** `.form()`: a native form, or one question per field on providers without forms. */
  | { kind: 'form'; form: FormDefinition; opts?: FormStepOptions }

export interface CompiledFlow {
  id: string
  trigger: Trigger
  steps: CompiledStep[]
  opts: { timeoutMs?: number; persistent?: boolean; scope?: TriggerScope }
}

export function isCompiledFlow(x: unknown): x is CompiledFlow {
  return typeof x === 'object' && x !== null && 'steps' in x && 'trigger' in x && 'id' in x
}

/**
 * Start a DSL flow. `S` optionally declares state the flow expects up front; `.ask()`,
 * `.choose()` and `.use()` add the keys they capture, so `c.state` is typed without casts.
 */
export function flow<S extends object = EmptyFlowState>(trigger: Trigger): FlowBuilder<S> { return new FlowBuilder<S>(trigger) }
/** Alias para migración desde bot-whatsapp/BuilderBot. */
export const addKeyword = flow

function delayOf(d: FlowDelay | undefined): number | undefined {
  if (d === undefined) return undefined
  const ms = parseDuration(d)
  // A Node timer cannot hold more than 2^31-1 ms: a longer delay would fire after ~1 ms.
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIMER_MS) {
    throw new Error(`Invalid flow delay: ${String(d)} (expected 0 to ${MAX_TIMER_MS} ms, about 24 days)`)
  }
  return ms
}

function withoutDelay<T extends { delay?: FlowDelay }>(opts: T | undefined): Omit<T, 'delay'> | undefined {
  if (!opts) return undefined
  const { delay: _delay, ...rest } = opts
  return Object.keys(rest).length ? rest : undefined
}

function targetOf(t: string | FlowBuilder<object>): string {
  return typeof t === 'string' ? t : t.compile().id
}

export class FlowBuilder<S extends object = EmptyFlowState> {
  private steps: CompiledStep[] = []
  private _id?: string
  private _timeoutMs?: number
  private _persistent = false
  private _scope?: TriggerScope

  constructor(private trigger: Trigger) {}

  private push(step: CompiledStep): void {
    this.steps.push(step)
  }

  /** Send a message. `{ delay }` pauses before sending. */
  say(text: string | DynamicText<S>, opts?: SayStepOptions): FlowBuilder<S> {
    const delayMs = delayOf(opts?.delay)
    this.push({ kind: 'say', text: text as string | DynamicText, ...(delayMs !== undefined && { delayMs }) })
    return this
  }

  /**
   * Ask a question and store the answer in `c.state[stateKey]`. With `{ schema }` the parsed
   * value is stored and typed: `.ask('¿Edad?', 'edad', { schema: z.coerce.number() })` →
   * `c.state.edad: number`.
   */
  ask<K extends string, T = string>(text: string | DynamicText<S>, stateKey: K, opts?: AskStepOptions<T>): FlowBuilder<FlowStateWith<S, K, T>> {
    const delayMs = delayOf(opts?.delay)
    const rest = withoutDelay(opts)
    this.push({
      kind: 'ask', text: text as string | DynamicText, stateKey,
      ...(rest && { opts: rest as CompiledAskOptions }),
      ...(delayMs !== undefined && { delayMs }),
    })
    return this as unknown as FlowBuilder<FlowStateWith<S, K, T>>
  }

  do(fn: FlowAction<S>): FlowBuilder<S> { this.push({ kind: 'do', fn: fn as FlowAction }); return this }

  /**
   * Send media. `kind` is one of `image | video | audio | voice | document | sticker | location`:
   *
   * ```ts
   * .media('image', 'https://…/menu.png', 'Nuestro menú')
   * .media('document', './factura.pdf', 'Tu factura', { filename: 'factura.pdf' })
   * .media('location', { lat: 4.71, lng: -74.07 }, 'Bogotá')
   * ```
   *
   * The legacy two-argument form `.media(source, caption?)` sends an image.
   */
  media(kind: 'location', source: FlowLocation | DynamicMediaSource<FlowLocation>, caption?: string, opts?: FlowMediaOptions): FlowBuilder<S>
  media(kind: FlowFileMediaKind, source: MediaSource | DynamicMediaSource<MediaSource>, caption?: string, opts?: FlowMediaOptions): FlowBuilder<S>
  media(source: string, caption?: string): FlowBuilder<S>
  media(a: string, b?: unknown, c?: string, d?: FlowMediaOptions): FlowBuilder<S> {
    const typed = isFlowMediaKind(a) && b !== undefined
    const type: FlowMediaKind = typed ? (a as FlowMediaKind) : 'image'
    const source = (typed ? b : a) as FlowMediaSource
    const caption = typed ? c : (b as string | undefined)
    const opts = typed ? d : undefined
    const delayMs = delayOf(opts?.delay)
    const rest = withoutDelay(opts)
    this.push({
      kind: 'media', type, source,
      ...(caption !== undefined && { caption }),
      ...(rest && { opts: rest }),
      ...(delayMs !== undefined && { delayMs }),
    })
    return this
  }

  /**
   * Present a numbered menu and capture the selection. The picked option KEY is stored in
   * `c.state[stateKey]` (defaults to `c.state.choice`), so a later `.say`/`.do` can read it.
   * An option's `then` sub-flow runs inline and returns here (sharing `c.state`); its `goto`
   * leaves the flow for another conversation.
   */
  choose<O extends Record<string, ChooseOption<S>>, K extends string = 'choice'>(
    prompt: string,
    options: O,
    stateKey?: K,
    opts?: ChooseStepOptions,
  ): FlowBuilder<FlowStateWith<S, K, Extract<keyof O, string>>> {
    const compiled: Record<string, CompiledChooseOption> = {}
    for (const [key, value] of Object.entries(options as Record<string, ChooseOption<S>>)) {
      if (typeof value === 'string') { compiled[key] = { label: value }; continue }
      const option: CompiledChooseOption = { label: value.label }
      if (value.then !== undefined) option.then = value.then instanceof FlowBuilder ? value.then.compile() : (value.then as CompiledFlow | FlowAction)
      if (value.goto !== undefined) option.goto = targetOf(value.goto)
      compiled[key] = option
    }
    const delayMs = delayOf(opts?.delay)
    const rest = withoutDelay(opts)
    this.push({
      kind: 'choose', prompt, options: compiled,
      ...(stateKey !== undefined && { stateKey }),
      ...(rest && { opts: rest }),
      ...(delayMs !== undefined && { delayMs }),
    })
    return this as unknown as FlowBuilder<FlowStateWith<S, K, Extract<keyof O, string>>>
  }

  /**
   * Run another flow inline, then come back and continue with the next step. The sub-flow
   * shares `c.state`, so whatever it captures is visible here (and typed: the builder's
   * state merges the sub-flow's). The sub-flow is snapshotted at this call.
   */
  use<T extends object>(sub: FlowBuilder<T>): FlowBuilder<FlowStateMerge<S, T>>
  use(sub: CompiledFlow): FlowBuilder<S>
  use(sub: FlowBuilder<object> | CompiledFlow): FlowBuilder<S> {
    const compiled = sub instanceof FlowBuilder ? sub.compile() : sub
    if (!isCompiledFlow(compiled)) throw new TypeError('use() expects a FlowBuilder or CompiledFlow')
    this.push({ kind: 'use', flow: compiled })
    return this
  }

  /**
   * Stop the flow unless `check` passes. On failure it sends `onFail` and ends the conversation,
   * or — with `{ redirect }` — jumps to another conversation:
   *
   * ```ts
   * .guard(() => esHorarioLaboral(), 'Fuera de horario, vuelve mañana')
   * .guard(async (ctx) => isAdmin(ctx.sender), { redirect: 'no-permiso' })
   * ```
   */
  guard(check: FlowGuard<S>, onFail?: GuardFailure<S>): FlowBuilder<S> {
    const step: Extract<CompiledStep, { kind: 'guard' }> = { kind: 'guard', check: check as FlowGuard }
    if (typeof onFail === 'string' || typeof onFail === 'function') step.message = onFail as string | DynamicText
    else if (onFail) {
      if (onFail.message !== undefined) step.message = onFail.message as string | DynamicText
      if (onFail.redirect !== undefined) step.redirect = targetOf(onFail.redirect)
    }
    this.push(step)
    return this
  }

  /**
   * Collect a typed form. On providers with `capabilities.forms === 'native'`
   * (WhatsApp Cloud API → WhatsApp Flows) it sends one native form and waits for
   * its submission; elsewhere it asks field by field. Either way the validated
   * answers are stored in `c.state[opts.stateKey ?? definition.id]`.
   * The definition is checked here: a malformed one throws a `TypeError`.
   *
   * @example
   * ```ts
   * flow('registro')
   *   .form({ id: 'signup', title: 'Registro', fields: [
   *     { type: 'text', name: 'name', label: 'Nombre' },
   *     { type: 'email', name: 'email', label: 'Correo' },
   *     { type: 'select', name: 'plan', label: 'Plan', options: { basic: 'Básico', pro: 'Pro' } },
   *   ] })
   *   .say((_ctx, c) => `Gracias ${(c.state.signup as { name: string }).name}`)
   * ```
   */
  form(definition: FormDefinition, opts?: FormStepOptions): FlowBuilder<S> {
    assertFormDefinition(definition)
    this.push({ kind: 'form', form: definition, opts })
    return this
  }

  /** Pause the flow (`'2s'`, `1500`) before the next step. */
  delay(d: FlowDelay): FlowBuilder<S> {
    this.push({ kind: 'delay', ms: delayOf(d) ?? 0 })
    return this
  }

  goto(target: string | FlowBuilder<object>): FlowBuilder<S> {
    this.push({ kind: 'goto', target: targetOf(target) })
    return this
  }

  timeout(d: string | number): FlowBuilder<S> { this._timeoutMs = parseDuration(d); return this }
  persistent(): FlowBuilder<S> { this._persistent = true; return this }
  scope(s: TriggerScope): FlowBuilder<S> { this._scope = s; return this }
  id(explicit: string): FlowBuilder<S> { this._id = explicit; return this }

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
  // WELCOME / type triggers carry their own `scope` field (the constants are frozen → copy).
  if (isTypeTrigger(trigger) || isWelcomeTrigger(trigger)) return { ...trigger, scope }
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
        case 'form':
          parts.push(step.form.id, step.form.fields.map((f) => f.name).join(','))
          break
        case 'do':
          parts.push('fn')
          break
        case 'media':
          parts.push(step.type, typeof step.source === 'string' ? step.source : 'src', step.caption ?? '')
          break
        case 'guard':
          parts.push(step.redirect ?? '', typeof step.message === 'string' ? step.message : '')
          break
        case 'use':
          parts.push(step.flow.id)
          break
        case 'delay':
          parts.push(String(step.ms))
          break
      }
      return parts.join('~')
    })
    .join('|')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
