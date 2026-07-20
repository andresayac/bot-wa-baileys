/**
 * FlowBuilder v2 — declarative conversation flows with own DSL.
 *
 * Build multi-step conversations with capture, validation, branching,
 * timeouts and fallbacks. Each step is chainable and returns `this`.
 *
 * @example Registration flow with capture & validation
 * ```ts
 * import { flow } from '@bot-wa/bot-wa-baileys'
 *
 * const registerFlow = flow('registrar')
 *   .say('📝 *Vamos a registrarte*')
 *   .say('¿Cuál es tu nombre?', { capture: true })
 *   .do(async (ctx, { state }) => state.set('name', ctx.body))
 *   .say('¿Cuál es tu email?', { capture: true })
 *   .validate((body) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)
 *     ? true
 *     : '❌ email inválido')
 *   .do(async (ctx, { state }) => state.set('email', ctx.body))
 *   .say(async (ctx, { state }) => `✅ ${state.get('name')} <${state.get('email')}>`)
 *   .end()
 *
 * bot.use(registerFlow)
 * ```
 *
 * @example Branching with `choose`
 * ```ts
 * const buyFlow = flow('comprar')
 *   .say('1️⃣ Electrónica\n2️⃣ Ropa\n3️⃣ Hogar')
 *   .say('Escribe el número', { capture: true })
 *   .choose({
 *     '1': flow().say('📱 iPhone 15 — $999').end(),
 *     '2': flow().say('👕 Camiseta — $25').end(),
 *     '3': flow().say('🏠 Lámpara — $35').end(),
 *   })
 *   .say('✅ gracias!')
 *   .end()
 * ```
 *
 * @example Timeout & fallback
 * ```ts
 * const supportFlow = flow('soporte')
 *   .say('Describe tu problema', { capture: true })
 *   .do(async (ctx, { state }) => state.set('problem', ctx.body))
 *   .say(async (ctx, { state }) => `✅ registrado: "${state.get('problem')}"`)
 *   .timeout(60_000, '⏰ sesión caducada')
 *   .fallback(async (ctx) => await ctx.reply('🤔 no entendí, intenta de nuevo'))
 *   .end()
 * ```
 */

import type {
  Flow,
  FlowAction,
  FlowMatchOptions,
  FlowMatcher,
  FlowStep,
  FlowStepOptions,
  FlowState,
  FlowTools,
  KeywordMatcher,
  MediaSource,
  MessageContext,
} from '../core/types'

let _flowCounter = 0

/**
 * Create a new flow. If `keyword` is omitted, the flow matches everything (`'*'`).
 *
 * @example
 * ```ts
 * const f = flow('soporte')
 *   .say('¿Cuál es tu problema?', { capture: true })
 *   .end()
 * ```
 */
export function flow(keyword?: KeywordMatcher, matchOpts?: FlowMatchOptions): FlowBuilder {
  return new FlowBuilder(keyword ?? '*', matchOpts)
}

/** Alias — kept consistent with <= v1 (users used addKeyword). */
export const addKeyword = flow

export class FlowBuilder implements Flow {
  readonly id: string
  readonly steps: FlowStep[] = []
  private _keyword: KeywordMatcher
  private _matchOpts: FlowMatchOptions
  private _timeoutMs?: number
  private _timeoutMessage?: string
  private _maxRetries = 3
  private _fallback?: FlowAction
  private _persistent = false
  private _defaultBranch?: FlowAction

  constructor(keyword: KeywordMatcher, matchOpts: FlowMatchOptions = {}) {
    this.id = `flow_${++_flowCounter}`
    this._keyword = keyword
    this._matchOpts = matchOpts
  }

  /** Public keyword getter (read-only). */
  get keyword(): KeywordMatcher { return this._keyword }

  /** Public options getter — computed from private fields. */
  get options(): any {
    return {
      timeoutMs: this._timeoutMs,
      timeoutMessage: this._timeoutMessage,
      maxRetries: this._maxRetries,
      fallback: this._fallback,
      persistent: this._persistent,
      matcher: this._matchOpts.matcher,
      caseSensitive: this._matchOpts.caseSensitive,
      scope: this._matchOpts.scope,
    }
  }

  /** Update or change matching keyword. */
  when(keyword: KeywordMatcher, matchOpts?: FlowMatchOptions): this {
    this._keyword = keyword
    if (matchOpts) this._matchOpts = matchOpts
    return this
  }

  /**
   * Send text/media and optionally run an action. Accepts a string, a media
   * source, an array of messages, or an async function returning a string.
   *
   * @example Plain text
   * ```ts
   * flow.say('¿Cuál es tu nombre?')
   * ```
   *
   * @example Capture the next user message
   * ```ts
   * flow.say('¿Cuál es tu nombre?', { capture: true })
   * ```
   *
   * @example Dynamic reply from state
   * ```ts
   * flow.say(async (ctx, { state }) => `Hola ${state.get('name')}`)
   * ```
   */
  say(
    answer: string | MediaSource | (string | { media: MediaSource; caption?: string })[] | ((ctx: any, tools: any) => Promise<string> | string),
    optionsOrAction?: FlowStepOptions | FlowAction,
    action?: FlowAction
  ): this {
    const opts = typeof optionsOrAction === 'function' ? {} : (optionsOrAction ?? {})
    const act = typeof optionsOrAction === 'function' ? optionsOrAction : action

    const answers = Array.isArray(answer)
      ? answer.map((a) => (typeof a === 'string' ? a : a))
      : typeof answer === 'string'
        ? [answer]
        : typeof answer === 'function'
          ? [answer as any]
          : [{ media: answer }]

    this.steps.push({
      kind: 'answer',
      answers,
      options: opts,
      action: act,
    })
    return this
  }

  /** Alias — backward compatible with v1 `addAnswer`. */
  addAnswer = this.say

  /**
   * Run an action without sending anything. Useful to persist state between steps.
   *
   * @example
   * ```ts
   * flow.do(async (ctx, { state }) => state.set('name', ctx.body))
   * ```
   */
  do(action: FlowAction): this {
    this.steps.push({ kind: 'action', action })
    return this
  }
  addAction = this.do

  /** Send a media file/url/buffer with optional caption. */
  media(source: MediaSource, caption?: string, opts: FlowStepOptions = {}): this {
    this.steps.push({
      kind: 'answer',
      answers: [{ media: source, caption }],
      options: opts,
    })
    return this
  }

  /** Branch to sub-flows based on a condition function. */
  branch(
    condition: (ctx: MessageContext, state: FlowState) => string | Flow | null | undefined,
    branches: Array<{ case: string | Flow; then: Flow }>,
    fallbackAction?: FlowAction
  ): this {
    this._defaultBranch = fallbackAction
    this.steps.push({
      kind: 'branch',
      branches: branches.map((b) => ({
        when: b.case as any,
        then: (typeof b.then === 'string' ? branches.find((x) => x.case === b.then)?.then : b.then)!,
        opts: {},
      })),
      defaultBranch: fallbackAction,
    })
    // Note: branch() relies on the runtime; the condition function is captured by the engine
    ;(this.steps[this.steps.length - 1] as any).__condition = condition
    return this
  }

  /**
   * Switch-style conditional based on the next captured user input.
   * Each key maps to a sub-flow; the matching sub-flow runs when the user types the key.
   *
   * @example
   * ```ts
   * flow.choose({
   *   '1': flow().say('📱 Electrónica').end(),
   *   '2': flow().say('👕 Ropa').end(),
   * })
   * ```
   */
  choose(options: Record<string, Flow | FlowAction>): this {
    const branches = Object.entries(options).map(([key, value]) => ({
      when: key,
      then: value,
      opts: {},
    }))
    this.steps.push({
      kind: 'choose',
      branches: branches.map((b) => ({
        when: b.when,
        then: b.then as Flow,
        opts: {},
      })),
      defaultBranch:
        typeof options!.default === 'function' ? (options!.default as FlowAction) : undefined,
    })
    return this
  }

  /**
   * Set a timeout for the whole flow. When the user is inactive for `ms`
   * milliseconds, the flow ends and `message` is sent.
   *
   * @example
   * ```ts
   * flow.timeout(60_000, '⏰ sesión caducada por inactividad')
   * ```
   */
  timeout(ms: number, message = '⏰ Sesión caducada'): this {
    this._timeoutMs = ms
    this._timeoutMessage = message
    return this
  }

  /**
   * Fallback action when the user sends something off-topic during a flow
   * (i.e. a message that doesn't match the expected capture).
   *
   * @example
   * ```ts
   * flow.fallback(async (ctx) => await ctx.reply('🤔 no entendí, intenta de nuevo'))
   * ```
   */
  fallback(action: FlowAction): this {
    this._fallback = action
    return this
  }

  /**
   * Validate the user input on the next captured step. Return `true` to accept
   * or a string error message to reject (the step repeats).
   *
   * @example
   * ```ts
   * flow.say('¿Email?', { capture: true })
   *   .validate((body) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)
   *     ? true
   *     : '❌ email inválido')
   * ```
   */
  validate(validate: (body: string) => true | string | Promise<true | string>): this {
    const last = this.steps[this.steps.length - 1]
    if (!last) throw new Error('validate() must be called after say(capture:true)')
    last.options = last.options ?? {}
    last.options.validate = validate as any
    return this
  }

  /** Mark flow state as persistent (must be backed by store adapter). */
  persistent(): this {
    this._persistent = true
    return this
  }

  /** Explicit end marker. Optional — flow ends automatically after last step. */
  end(): this { return this }

  /** Test if a message text triggers this flow. */
  test(body: string, _ctx?: Pick<MessageContext, 'from' | 'isGroup'>): boolean {
    return matchKeyword(this._keyword, body, this._matchOpts)
  }
}

/* =============================================================================
 * MATCHING LOGIC
 * ========================================================================== */

export function matchKeyword(
  keyword: KeywordMatcher,
  body: string,
  opts: FlowMatchOptions = {}
): boolean {
  const matchers = Array.isArray(keyword) ? keyword : [keyword]
  const caseSensitive = opts.caseSensitive ?? false
  const strategy =
    opts.matcher ??
    (matchers.some((m) => m instanceof RegExp) ? 'regex' : 'contains')

  const normalizedBody = caseSensitive ? body : body.toLowerCase()

  return matchers.some((m) => {
    if (m instanceof RegExp) {
      return m.test(caseSensitive ? body : normalizedBody)
    }
    const text = caseSensitive ? String(m) : String(m).toLowerCase()
    switch (strategy) {
      case 'equals': return normalizedBody === text
      case 'startsWith': return normalizedBody.startsWith(text)
      case 'endsWith': return normalizedBody.endsWith(text)
      case 'regex': {
        try { return new RegExp(text).test(body) } catch { return false }
      }
      case 'contains':
      default:
        return normalizedBody.includes(text)
    }
  })
}
