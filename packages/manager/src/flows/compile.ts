/**
 * JSON flow document → `CompiledFlow` compiler (feature #24).
 *
 * A flow document is pure data (see {@link FLOW_DOCUMENT_SCHEMA}): `say`,
 * `ask`, `choose`, `delay`, `goto`, `end` and `condition` steps, with safe
 * expressions ({@link parseExpression}) and `{{ path }}` templates. It never
 * carries code, so it is safe to accept from the REST API and to persist.
 *
 * Top-level steps map 1:1 onto core DSL steps (so `describe()`/`lint()` and
 * persistent checkpoints work per step); nested steps (`choose` options,
 * `condition` branches) run through a small interpreter over the same
 * conversation controls.
 */

import { sleep, type CompiledFlow, type CompiledStep, type ConversationControls, type DynamicText, type FlowAction, type RuntimeMessage, type Trigger, type WaitOptions } from '@bot-wa/core'
import { evaluateCondition, ExpressionError, hasTemplate, parseExpression, renderTemplate, type ExpressionNode } from './expression.js'
import { FLOW_DOCUMENT_LIMITS, FLOW_DOCUMENT_VERSION, FLOW_ID_PATTERN } from './schema.js'

/** Keyword trigger of a flow document. */
export type FlowDocumentTrigger =
  | string
  | string[]
  | { keywords: string[]; match?: 'equals' | 'contains' | 'startsWith' | 'endsWith'; scope?: 'dm' | 'group' | 'all' }

/** A duration: milliseconds, or `'500ms'` / `'30s'` / `'5m'` / `'1h'`. */
export type FlowDuration = number | string

/** One step of a flow document. */
export type FlowStepDocument =
  | { kind: 'say'; text: string }
  | { kind: 'ask'; text: string; stateKey: string; timeout?: FlowDuration; retries?: number; validate?: { expr: string; message?: string } }
  | { kind: 'choose'; text: string; options: Array<{ key: string; label: string; steps?: FlowStepDocument[] }>; stateKey?: string; timeout?: FlowDuration }
  | { kind: 'delay'; duration: FlowDuration }
  | { kind: 'goto'; target: string }
  | { kind: 'end'; text?: string }
  | { kind: 'condition'; if: string; then: FlowStepDocument[]; else?: FlowStepDocument[] }

/** A declarative, code-free flow (format version 1). */
export interface FlowDocument {
  $schema?: string
  version: typeof FLOW_DOCUMENT_VERSION
  id: string
  name?: string
  description?: string
  trigger: FlowDocumentTrigger
  timeout?: FlowDuration
  persistent?: boolean
  steps: FlowStepDocument[]
}

/** One validation problem, with a JSON-pointer-like path (`/steps/2/text`). */
export interface FlowDocumentIssue {
  path: string
  message: string
}

/** Thrown by {@link compileFlowDocument} for an invalid document. */
export class FlowDocumentError extends Error {
  constructor(readonly issues: FlowDocumentIssue[]) {
    super(`invalid flow document: ${issues.slice(0, 3).map((i) => `${i.path || '/'} ${i.message}`).join('; ')}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ''}`)
    this.name = 'FlowDocumentError'
  }
}

const ID_RE = new RegExp(FLOW_ID_PATTERN)
const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/
const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
const MATCH = new Set(['equals', 'contains', 'startsWith', 'endsWith'])
const SCOPES = new Set(['dm', 'group', 'all'])
const STEP_KEYS: Record<FlowStepDocument['kind'], readonly string[]> = {
  say: ['kind', 'text'],
  ask: ['kind', 'text', 'stateKey', 'timeout', 'retries', 'validate'],
  choose: ['kind', 'text', 'options', 'stateKey', 'timeout'],
  delay: ['kind', 'duration'],
  goto: ['kind', 'target'],
  end: ['kind', 'text'],
  condition: ['kind', 'if', 'then', 'else'],
}
const DOC_KEYS = ['$schema', 'version', 'id', 'name', 'description', 'trigger', 'timeout', 'persistent', 'steps']

/**
 * Validate an untrusted value as a {@link FlowDocument}. Returns every issue found
 * (empty array = valid). Checks the schema rules, the structural limits and the
 * syntax of every expression.
 */
export function validateFlowDocument(input: unknown): FlowDocumentIssue[] {
  const issues: FlowDocumentIssue[] = []
  const add = (path: string, message: string) => { if (issues.length < 100) issues.push({ path, message }) }
  if (!isObject(input)) return [{ path: '', message: 'must be an object' }]
  extraKeys(input, DOC_KEYS, '', add)
  if (input.$schema !== undefined && typeof input.$schema !== 'string') add('/$schema', 'must be a string')
  if (input.version !== FLOW_DOCUMENT_VERSION) add('/version', `must be ${FLOW_DOCUMENT_VERSION}`)
  checkId(input.id, '/id', add)
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 200)) add('/name', 'must be a string of at most 200 characters')
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)) add('/description', 'must be a string of at most 2000 characters')
  checkTrigger(input.trigger, add)
  if (input.timeout !== undefined) checkDuration(input.timeout, '/timeout', add)
  if (input.persistent !== undefined && typeof input.persistent !== 'boolean') add('/persistent', 'must be a boolean')
  const counter = { steps: 0 }
  if (!Array.isArray(input.steps) || input.steps.length === 0) add('/steps', 'must be a non-empty array')
  else checkSteps(input.steps, '/steps', 1, counter, add)
  return issues
}

/** Type guard over {@link validateFlowDocument}. */
export function isFlowDocument(input: unknown): input is FlowDocument {
  return validateFlowDocument(input).length === 0
}

/**
 * Compile a flow document into a core `CompiledFlow` (register it with
 * `bot.registerFlow()` / `bot.replaceFlow()`). Throws {@link FlowDocumentError}
 * when the document is invalid.
 *
 * @example
 * ```ts
 * bot.registerFlow(compileFlowDocument({
 *   version: 1, id: 'encuesta', trigger: 'encuesta',
 *   steps: [
 *     { kind: 'ask', text: '¿Tu nombre?', stateKey: 'name' },
 *     { kind: 'condition', if: 'len(name) > 20', then: [{ kind: 'end', text: 'Nombre demasiado largo' }] },
 *     { kind: 'say', text: 'Gracias {{name}}' },
 *   ],
 * }))
 * ```
 */
export function compileFlowDocument(input: unknown): CompiledFlow {
  const issues = validateFlowDocument(input)
  if (issues.length) throw new FlowDocumentError(issues)
  const doc = input as FlowDocument
  const timeoutMs = doc.timeout !== undefined ? toMs(doc.timeout) : undefined
  return {
    id: doc.id,
    trigger: compileTrigger(doc.trigger),
    steps: doc.steps.map((step) => compileTopStep(step)),
    opts: { timeoutMs, persistent: doc.persistent === true },
  }
}

/* ── compile ──────────────────────────────────────────────────────────── */

function compileTrigger(trigger: FlowDocumentTrigger): Trigger {
  if (typeof trigger === 'string') return trigger
  if (Array.isArray(trigger)) return [...trigger]
  return { pattern: [...trigger.keywords], ...(trigger.match ? { match: trigger.match } : {}), ...(trigger.scope ? { scope: trigger.scope } : {}) }
}

function compileTopStep(step: FlowStepDocument): CompiledStep {
  switch (step.kind) {
    case 'say':
      return { kind: 'say', text: textOf(step.text) }
    case 'ask':
      return { kind: 'ask', text: textOf(step.text), stateKey: step.stateKey, opts: askOptions(step) }
    case 'choose': {
      if (hasTemplate(step.text)) return { kind: 'do', fn: nestedAction([step]) }
      const options: Record<string, { label: string; then?: FlowAction }> = {}
      for (const o of step.options) options[o.key] = { label: o.label, ...(o.steps?.length ? { then: nestedAction(o.steps) } : {}) }
      return { kind: 'choose', prompt: step.text, options, stateKey: step.stateKey, opts: waitOptions(step.timeout) }
    }
    case 'goto':
      return { kind: 'goto', target: step.target }
    case 'delay':
    case 'end':
    case 'condition':
      return { kind: 'do', fn: nestedAction([step]) }
  }
}

/** Compile nested steps to one `FlowAction` run by the interpreter below. */
function nestedAction(steps: readonly FlowStepDocument[]): FlowAction {
  const program = steps.map(prepare)
  return async (ctx, c) => { await run(program, ctx, c) }
}

type Prepared =
  | { kind: 'say'; text: string }
  | { kind: 'ask'; text: string; stateKey: string; opts?: WaitOptions }
  | { kind: 'choose'; text: string; labels: Record<string, string>; branches: Record<string, Prepared[]>; stateKey: string; opts?: WaitOptions }
  | { kind: 'delay'; ms: number }
  | { kind: 'goto'; target: string }
  | { kind: 'end'; text?: string }
  | { kind: 'condition'; test: ExpressionNode; then: Prepared[]; else: Prepared[] }

function prepare(step: FlowStepDocument): Prepared {
  switch (step.kind) {
    case 'say': return step
    case 'ask': return { kind: 'ask', text: step.text, stateKey: step.stateKey, opts: askOptions(step) }
    case 'choose': {
      const labels: Record<string, string> = {}
      const branches: Record<string, Prepared[]> = {}
      for (const o of step.options) {
        labels[o.key] = o.label
        branches[o.key] = (o.steps ?? []).map(prepare)
      }
      return { kind: 'choose', text: step.text, labels, branches, stateKey: step.stateKey ?? 'choice', opts: waitOptions(step.timeout) }
    }
    case 'delay': return { kind: 'delay', ms: toMs(step.duration) }
    case 'goto': return step
    case 'end': return step
    case 'condition': return { kind: 'condition', test: parseExpression(step.if), then: step.then.map(prepare), else: (step.else ?? []).map(prepare) }
  }
}

async function run(program: readonly Prepared[], ctx: RuntimeMessage, c: ConversationControls): Promise<void> {
  for (const step of program) {
    switch (step.kind) {
      case 'say':
        await c.say(renderTemplate(step.text, scopeOf(ctx, c)))
        break
      case 'ask':
        c.state[step.stateKey] = await c.ask(renderTemplate(step.text, scopeOf(ctx, c)), step.opts)
        break
      case 'choose': {
        const picked = await c.choose(renderTemplate(step.text, scopeOf(ctx, c)), step.labels, step.opts)
        c.state[step.stateKey] = picked
        await run(step.branches[picked] ?? [], ctx, c)
        break
      }
      case 'delay':
        await sleep(step.ms)
        break
      case 'goto':
        c.goto(step.target)
        break
      case 'end':
        c.end(step.text === undefined ? undefined : renderTemplate(step.text, scopeOf(ctx, c)))
        break
      case 'condition':
        await run(evaluateCondition(step.test, scopeOf(ctx, c)) ? step.then : step.else, ctx, c)
        break
    }
  }
}

/** Expression/template scope: `c.state` plus read-only `$` fields of the triggering message. */
function scopeOf(ctx: RuntimeMessage, c: { state: Record<string, unknown> }): Record<string, unknown> {
  return { ...c.state, $body: ctx.body, $from: ctx.from, $sender: ctx.sender, $isGroup: ctx.isGroup }
}

function textOf(text: string): string | DynamicText {
  if (!hasTemplate(text)) return text
  return (ctx: RuntimeMessage, c: ConversationControls) => renderTemplate(text, scopeOf(ctx, c))
}

function askOptions(step: Extract<FlowStepDocument, { kind: 'ask' }>): WaitOptions | undefined {
  const opts: WaitOptions = { ...waitOptions(step.timeout) }
  if (step.retries !== undefined) opts.retries = step.retries
  if (step.validate) {
    const test = parseExpression(step.validate.expr)
    const message = step.validate.message
    opts.validate = (body, ctx) => {
      // c.state is not reachable from validate(); the answer and message fields are.
      const scope = { $answer: body, $body: ctx.body, $from: ctx.from, $sender: ctx.sender, $isGroup: ctx.isGroup }
      return evaluateCondition(test, scope) ? true : (message ?? step.text)
    }
  }
  return Object.keys(opts).length ? opts : undefined
}

function waitOptions(timeout: FlowDuration | undefined): WaitOptions | undefined {
  return timeout === undefined ? undefined : { timeout: toMs(timeout) }
}

function toMs(d: FlowDuration): number {
  if (typeof d === 'number') return d
  const m = DURATION_RE.exec(d)!
  return Math.round(parseFloat(m[1]) * UNITS[m[2]])
}

/* ── validate ─────────────────────────────────────────────────────────── */

type Add = (path: string, message: string) => void

function checkSteps(steps: unknown[], path: string, depth: number, counter: { steps: number }, add: Add): void {
  if (depth > FLOW_DOCUMENT_LIMITS.maxDepth) { add(path, `nested deeper than ${FLOW_DOCUMENT_LIMITS.maxDepth} levels`); return }
  steps.forEach((step, i) => {
    if (++counter.steps === FLOW_DOCUMENT_LIMITS.maxSteps + 1) add(path, `more than ${FLOW_DOCUMENT_LIMITS.maxSteps} steps in total`)
    checkStep(step, `${path}/${i}`, depth, counter, add)
  })
}

function checkStep(step: unknown, path: string, depth: number, counter: { steps: number }, add: Add): void {
  if (!isObject(step)) { add(path, 'must be an object'); return }
  const kind = step.kind
  if (typeof kind !== 'string' || !Object.hasOwn(STEP_KEYS, kind)) {
    add(`${path}/kind`, `must be one of ${Object.keys(STEP_KEYS).join(', ')}`)
    return
  }
  extraKeys(step, STEP_KEYS[kind as FlowStepDocument['kind']], path, add)
  const nested = (value: unknown, p: string, required: boolean) => {
    if (value === undefined && !required) return
    if (!Array.isArray(value)) { add(p, 'must be an array of steps'); return }
    checkSteps(value, p, depth + 1, counter, add)
  }
  switch (kind) {
    case 'say':
      checkText(step.text, `${path}/text`, add)
      break
    case 'ask':
      checkText(step.text, `${path}/text`, add)
      checkId(step.stateKey, `${path}/stateKey`, add)
      if (step.timeout !== undefined) checkDuration(step.timeout, `${path}/timeout`, add)
      if (step.retries !== undefined && !(Number.isInteger(step.retries) && (step.retries as number) >= 0 && (step.retries as number) <= 20)) add(`${path}/retries`, 'must be an integer between 0 and 20')
      if (step.validate !== undefined) {
        if (!isObject(step.validate)) add(`${path}/validate`, 'must be an object')
        else {
          extraKeys(step.validate, ['expr', 'message'], `${path}/validate`, add)
          checkExpression(step.validate.expr, `${path}/validate/expr`, add)
          if (step.validate.message !== undefined) checkText(step.validate.message, `${path}/validate/message`, add)
        }
      }
      break
    case 'choose': {
      checkText(step.text, `${path}/text`, add)
      if (step.stateKey !== undefined) checkId(step.stateKey, `${path}/stateKey`, add)
      if (step.timeout !== undefined) checkDuration(step.timeout, `${path}/timeout`, add)
      const options = step.options
      if (!Array.isArray(options) || options.length === 0 || options.length > FLOW_DOCUMENT_LIMITS.maxOptions) {
        add(`${path}/options`, `must be an array of 1-${FLOW_DOCUMENT_LIMITS.maxOptions} options`)
        break
      }
      const seen = new Set<string>()
      options.forEach((o, i) => {
        const p = `${path}/options/${i}`
        if (!isObject(o)) { add(p, 'must be an object'); return }
        extraKeys(o, ['key', 'label', 'steps'], p, add)
        checkId(o.key, `${p}/key`, add)
        if (typeof o.key === 'string') {
          if (seen.has(o.key)) add(`${p}/key`, `duplicate option key "${o.key}"`)
          seen.add(o.key)
        }
        if (typeof o.label !== 'string' || o.label.length === 0 || o.label.length > 200) add(`${p}/label`, 'must be a string of 1-200 characters')
        nested(o.steps, `${p}/steps`, false)
      })
      break
    }
    case 'delay':
      if (checkDuration(step.duration, `${path}/duration`, add) && toMs(step.duration as FlowDuration) > FLOW_DOCUMENT_LIMITS.maxDelayMs) {
        add(`${path}/duration`, `must be at most ${FLOW_DOCUMENT_LIMITS.maxDelayMs} ms`)
      }
      break
    case 'goto':
      checkId(step.target, `${path}/target`, add)
      break
    case 'end':
      if (step.text !== undefined) checkText(step.text, `${path}/text`, add)
      break
    case 'condition':
      checkExpression(step.if, `${path}/if`, add)
      nested(step.then, `${path}/then`, true)
      nested(step.else, `${path}/else`, false)
      break
  }
}

function checkTrigger(trigger: unknown, add: Add): void {
  const kw = (v: unknown, p: string) => { if (typeof v !== 'string' || v.trim() === '' || v.length > 200) add(p, 'must be a non-empty keyword of at most 200 characters') }
  const list = (v: unknown, p: string) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > FLOW_DOCUMENT_LIMITS.maxKeywords) { add(p, `must be an array of 1-${FLOW_DOCUMENT_LIMITS.maxKeywords} keywords`); return }
    v.forEach((k, i) => kw(k, `${p}/${i}`))
  }
  if (typeof trigger === 'string') return kw(trigger, '/trigger')
  if (Array.isArray(trigger)) return list(trigger, '/trigger')
  if (!isObject(trigger)) { add('/trigger', 'must be a keyword, an array of keywords or { keywords, match?, scope? }'); return }
  extraKeys(trigger, ['keywords', 'match', 'scope'], '/trigger', add)
  list(trigger.keywords, '/trigger/keywords')
  if (trigger.match !== undefined && !MATCH.has(trigger.match as string)) add('/trigger/match', 'must be equals, contains, startsWith or endsWith')
  if (trigger.scope !== undefined && !SCOPES.has(trigger.scope as string)) add('/trigger/scope', 'must be dm, group or all')
}

function checkId(v: unknown, path: string, add: Add): void {
  if (typeof v !== 'string' || !ID_RE.test(v)) add(path, `must match ${FLOW_ID_PATTERN}`)
}

function checkText(v: unknown, path: string, add: Add): void {
  if (typeof v !== 'string' || v.length === 0 || v.length > FLOW_DOCUMENT_LIMITS.maxTextLength) add(path, `must be a string of 1-${FLOW_DOCUMENT_LIMITS.maxTextLength} characters`)
}

function checkDuration(v: unknown, path: string, add: Add): boolean {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return true
  if (typeof v === 'string' && DURATION_RE.test(v)) return true
  add(path, 'must be milliseconds or a duration such as "30s", "5m", "1h"')
  return false
}

function checkExpression(v: unknown, path: string, add: Add): void {
  if (typeof v !== 'string') { add(path, 'must be an expression string'); return }
  try { parseExpression(v) } catch (error) {
    add(path, error instanceof ExpressionError ? error.message : 'invalid expression')
  }
}

function extraKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, add: Add): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) add(`${path}/${key}`, 'unknown property')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
