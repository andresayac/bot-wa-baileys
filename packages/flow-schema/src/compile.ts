/**
 * JSON flow document → `CompiledFlow` compiler.
 *
 * Top-level steps map 1:1 onto core DSL steps where the core has one (`say`, `ask`,
 * `choose`, `goto`, `delay`, `media`, `guard`, `use`, `form`), so `describe()`/`lint()`
 * and persistent checkpoints work per step. Steps the core has no node for (`condition`,
 * `end`, `http`, `handoff`, `ai`) compile to a `do` action run by a small interpreter;
 * nested steps (`choose` options, `condition` branches, subflows) run through the same
 * interpreter.
 *
 * Nothing here executes document code: expressions are parsed by the safe evaluator,
 * templates only read own properties, HTTP goes through `@bot-wa/http` (anti-SSRF,
 * redirects, timeouts and size limits) and forms go through the core's form runner.
 */

import {
  sleep,
  type CompiledFlow,
  type CompiledStep,
  type ConversationControls,
  type DynamicText,
  type FlowAction,
  type FlowLocation,
  type FlowMediaKind,
  type FlowMediaSource,
  type FormDefinition,
  type FormField,
  type FormStepOptions,
  type MediaSource,
  type RuntimeMessage,
  type Trigger,
  type WaitOptions,
} from '@bot-wa/core'
import { runFormStep } from '@bot-wa/core/internal'
import { secureFetch, type SecureFetchOptions, type SecureFetchResponse } from '@bot-wa/http'
import { evaluateCondition, hasTemplate, parseExpression, renderTemplate, type ExpressionNode } from './expression.js'
import {
  FLOW_DOCUMENT_LIMITS,
  FlowDocumentError,
  toMs,
  validateFlowDocument,
  type FlowDocument,
  type FlowFormDocument,
  type FlowMediaDocumentSource,
  type FlowStepDocument,
  type FlowDuration,
} from './schema.js'

/** A ready-built compiled flow, and where it came from (the JSON step is kept as metadata). */
export const FLOW_STEP_SOURCE = Symbol.for('bot-wa.flow.step-source')
/** The whole JSON document a compiled flow came from (top-level metadata included). */
export const FLOW_DOCUMENT_SOURCE = Symbol.for('bot-wa.flow.document-source')

/** Options of {@link compileFlowDocument}. */
export interface CompileFlowOptions {
  /** Resolve a `subflow` step's document by id (required only when one is used). */
  resolveSubflow?: (flowId: string) => FlowDocument | undefined
  /** HTTP implementation of `http` steps (tests). Default `secureFetch` from `@bot-wa/http`. */
  fetch?: (url: string, options: SecureFetchOptions) => Promise<SecureFetchResponse>
  /** Bounds of `http` steps: default 10 s and 64 KiB of response. */
  http?: { timeoutMs?: number; maxBytes?: number; allowHttp?: boolean }
  /** Flow timeout passed to a nested form's waits (default: the form's own option). */
  formTimeoutMs?: number
}

/** The original JSON step a compiled step came from, when it was produced by the compiler. */
export function flowStepSource(step: CompiledStep): FlowStepDocument | undefined {
  return (step as unknown as Record<symbol, FlowStepDocument | undefined>)[FLOW_STEP_SOURCE]
}

/** The original JSON document a compiled flow came from (absent for DSL-built flows). */
export function flowDocumentSource(flow: CompiledFlow): FlowDocument | undefined {
  return (flow as unknown as Record<symbol, FlowDocument | undefined>)[FLOW_DOCUMENT_SOURCE]
}

/**
 * Compile a flow document into a core `CompiledFlow` (register it with
 * `bot.registerFlow()` / `bot.replaceFlow()`). Throws {@link FlowDocumentError}
 * when the document is invalid or a subflow cannot be resolved.
 */
export function compileFlowDocument(input: unknown, options: CompileFlowOptions = {}): CompiledFlow {
  const issues = validateFlowDocument(input)
  if (issues.length) throw new FlowDocumentError(issues)
  return compileValid(input as FlowDocument, options, [])
}

function compileValid(doc: FlowDocument, options: CompileFlowOptions, stack: readonly string[]): CompiledFlow {
  if (stack.includes(doc.id)) {
    throw new FlowDocumentError([{ path: '/id', message: `subflow cycle: ${[...stack, doc.id].join(' → ')}` }])
  }
  const next = [...stack, doc.id]
  const timeoutMs = doc.timeout !== undefined ? toMs(doc.timeout) : undefined
  const compiled: CompiledFlow = {
    id: doc.id,
    trigger: compileTrigger(doc.trigger),
    steps: doc.steps.map((step, i) => compileTopStep(step, options, next, `/steps/${i}`)),
    opts: { timeoutMs, persistent: doc.persistent === true },
  }
  Object.defineProperty(compiled, FLOW_DOCUMENT_SOURCE, {
    value: structuredClone(doc),
    enumerable: false,
    configurable: true,
    writable: false,
  })
  return compiled
}

/* ── top-level steps ──────────────────────────────────────────────────── */

function compileTopStep(step: FlowStepDocument, options: CompileFlowOptions, stack: readonly string[], path: string): CompiledStep {
  switch (step.kind) {
    case 'say':
      return withSource({ kind: 'say', text: textOf(step.text) }, step)
    case 'ask':
      return withSource({ kind: 'ask', text: textOf(step.text), stateKey: step.stateKey, opts: askOptions(step) }, step)
    case 'choose': {
      if (hasTemplate(step.text)) return withSource({ kind: 'do', fn: nestedAction([step], options, stack, path) }, step)
      const choices: Record<string, { label: string; then?: FlowAction }> = {}
      for (const o of step.options) {
        choices[o.key] = {
          label: o.label,
          ...(o.steps?.length ? { then: nestedAction(o.steps, options, stack, `${path}/options`) } : {}),
        }
      }
      return withSource({ kind: 'choose', prompt: step.text, options: choices, stateKey: step.stateKey, opts: waitOptions(step.timeout) }, step)
    }
    case 'goto':
      return withSource({ kind: 'goto', target: step.target }, step)
    case 'delay':
      return withSource({ kind: 'delay', ms: toMs(step.duration) }, step)
    case 'media':
      // The compiled media step has a static caption; a `{{ path }}` caption runs
      // through the interpreter, which renders it against `c.state`.
      if (hasTemplate(step.caption ?? '')) return withSource({ kind: 'do', fn: nestedAction([step], options, stack, path) }, step)
      return withSource({
        kind: 'media',
        type: step.type as FlowMediaKind,
        source: mediaSourceOf(step.source, step.type),
        ...(step.caption !== undefined ? { caption: step.caption } : {}),
        ...(step.filename !== undefined ? { opts: { filename: step.filename } } : {}),
      }, step)
    case 'form':
      return withSource({ kind: 'form', form: formDefinitionOf(step.form), ...(formOptionsOf(step) ? { opts: formOptionsOf(step) } : {}) }, step)
    case 'guard':
      return withSource({
        kind: 'guard',
        check: guardCheck(step.if),
        ...(step.message !== undefined ? { message: textOf(step.message) } : {}),
        ...(step.redirect !== undefined ? { redirect: step.redirect } : {}),
      }, step)
    case 'subflow': {
      const target = resolveSubflow(step.flowId, options, path)
      return withSource({ kind: 'use', flow: compileValid(target, options, stack) }, step)
    }
    case 'condition':
    case 'end':
    case 'http':
    case 'handoff':
    case 'ai':
      return withSource({ kind: 'do', fn: nestedAction([step], options, stack, path) }, step)
  }
}

function withSource<S extends CompiledStep>(compiled: S, source: FlowStepDocument): S {
  Object.defineProperty(compiled, FLOW_STEP_SOURCE, {
    value: structuredClone(source),
    enumerable: false,
    configurable: true,
    writable: false,
  })
  return compiled
}

function resolveSubflow(id: string, options: CompileFlowOptions, path: string): FlowDocument {
  const found = options.resolveSubflow?.(id)
  if (!found) {
    throw new FlowDocumentError([{ path: `${path}/flowId`, message: `subflow "${id}" cannot be resolved (pass resolveSubflow)` }])
  }
  const issues = validateFlowDocument(found)
  if (issues.length) throw new FlowDocumentError(issues.map((issue) => ({ path: `${path} → ${id}${issue.path}`, message: issue.message })))
  return found
}

function compileTrigger(trigger: FlowDocument['trigger']): Trigger {
  if (typeof trigger === 'string') return trigger
  if (Array.isArray(trigger)) return [...trigger]
  return { pattern: [...trigger.keywords], ...(trigger.match ? { match: trigger.match } : {}), ...(trigger.scope ? { scope: trigger.scope } : {}) }
}

/** A guard's check: the safe expression over `c.state` and the message fields. */
function guardCheck(source: string): (ctx: RuntimeMessage, c: { state: Record<string, unknown> }) => boolean {
  const ast = parseExpression(source)
  return (ctx, c) => evaluateCondition(ast, scopeOf(ctx, c))
}

/* ── nested interpreter ───────────────────────────────────────────────── */

type Prepared =
  | { kind: 'say'; text: string }
  | { kind: 'ask'; text: string; stateKey: string; opts?: WaitOptions }
  | { kind: 'choose'; text: string; labels: Record<string, string>; branches: Record<string, Prepared[]>; stateKey: string; opts?: WaitOptions }
  | { kind: 'delay'; ms: number }
  | { kind: 'goto'; target: string }
  | { kind: 'end'; text?: string }
  | { kind: 'condition'; test: ExpressionNode; then: Prepared[]; else: Prepared[] }
  | { kind: 'media'; type: FlowMediaKind; source: FlowMediaDocumentSource | { stateKey: string }; caption?: string; filename?: string }
  | { kind: 'form'; form: FormDefinition; opts: FormStepOptions }
  | { kind: 'guard'; test: ExpressionNode; message?: string; redirect?: string }
  | { kind: 'http'; method: string; url: string; headers?: Record<string, string>; body?: unknown; stateKey?: string; timeoutMs?: number }
  | { kind: 'handoff'; reason?: string; message?: string }
  | { kind: 'ai'; prompt: string; tools?: readonly string[]; stateKey?: string }

function nestedAction(steps: readonly FlowStepDocument[], options: CompileFlowOptions, stack: readonly string[], path: string): FlowAction {
  const program = steps.map((step, i) => prepare(step, options, stack, `${path}/${i}`))
  return async (ctx, c) => { await run(program, ctx, c, options) }
}

function prepare(step: FlowStepDocument, options: CompileFlowOptions, stack: readonly string[], path: string): Prepared {
  switch (step.kind) {
    case 'say': return { kind: 'say', text: step.text }
    case 'ask': return { kind: 'ask', text: step.text, stateKey: step.stateKey, opts: askOptions(step) }
    case 'choose': {
      const labels: Record<string, string> = {}
      const branches: Record<string, Prepared[]> = {}
      for (const o of step.options) {
        labels[o.key] = o.label
        branches[o.key] = (o.steps ?? []).map((s, i) => prepare(s, options, stack, `${path}/options/${o.key}/${i}`))
      }
      return { kind: 'choose', text: step.text, labels, branches, stateKey: step.stateKey ?? 'choice', opts: waitOptions(step.timeout) }
    }
    case 'delay': return { kind: 'delay', ms: toMs(step.duration) }
    case 'goto': return { kind: 'goto', target: step.target }
    case 'end': return step.text === undefined ? { kind: 'end' } : { kind: 'end', text: step.text }
    case 'condition': return {
      kind: 'condition',
      test: parseExpression(step.if),
      then: step.then.map((s, i) => prepare(s, options, stack, `${path}/then/${i}`)),
      else: (step.else ?? []).map((s, i) => prepare(s, options, stack, `${path}/else/${i}`)),
    }
    case 'media': return { kind: 'media', type: step.type as FlowMediaKind, source: step.source, ...(step.caption !== undefined ? { caption: step.caption } : {}), ...(step.filename !== undefined ? { filename: step.filename } : {}) }
    case 'form': {
      const opts = formOptionsOf(step) ?? {}
      if (step.timeout !== undefined || options.formTimeoutMs !== undefined) opts.timeout = step.timeout ?? options.formTimeoutMs
      return { kind: 'form', form: formDefinitionOf(step.form), opts }
    }
    case 'guard': return { kind: 'guard', test: parseExpression(step.if), ...(step.message !== undefined ? { message: step.message } : {}), ...(step.redirect !== undefined ? { redirect: step.redirect } : {}) }
    case 'subflow': {
      const target = resolveSubflow(step.flowId, options, path)
      if (stack.includes(target.id)) {
        throw new FlowDocumentError([{ path: `${path}/flowId`, message: `subflow cycle: ${[...stack, target.id].join(' → ')}` }])
      }
      // Inline the subflow's steps: `.use()` semantics (same c.state, no second trigger).
      return { kind: 'condition', test: { t: 'lit', v: true }, then: target.steps.map((s, i) => prepare(s, options, [...stack, target.id], `${path} → ${target.id}/${i}`)), else: [] }
    }
    case 'http': return { kind: 'http', method: step.method, url: step.url, ...(step.headers !== undefined ? { headers: step.headers } : {}), ...(step.body !== undefined ? { body: step.body } : {}), ...(step.stateKey !== undefined ? { stateKey: step.stateKey } : {}), ...(step.timeout !== undefined ? { timeoutMs: toMs(step.timeout) } : {}) }
    case 'handoff': return { kind: 'handoff', ...(step.reason !== undefined ? { reason: step.reason } : {}), ...(step.message !== undefined ? { message: step.message } : {}) }
    case 'ai': return { kind: 'ai', prompt: step.prompt, ...(step.tools !== undefined ? { tools: step.tools } : {}), ...(step.stateKey !== undefined ? { stateKey: step.stateKey } : {}) }
  }
}

async function run(program: readonly Prepared[], ctx: RuntimeMessage, c: ConversationControls, options: CompileFlowOptions): Promise<void> {
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
        await run(step.branches[picked] ?? [], ctx, c, options)
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
        await run(evaluateCondition(step.test, scopeOf(ctx, c)) ? step.then : step.else, ctx, c, options)
        break
      case 'media':
        await sendMedia(ctx, step, scopeOf(ctx, c))
        break
      case 'form':
        await runFormStep(step.form, ctx, c, step.opts, options.formTimeoutMs)
        break
      case 'guard':
        if (evaluateCondition(step.test, scopeOf(ctx, c))) break
        if (step.message !== undefined) await c.say(renderTemplate(step.message, scopeOf(ctx, c)))
        if (step.redirect !== undefined) c.goto(step.redirect)
        c.end()
        break
      case 'http': {
        const response = await httpStep(step, scopeOf(ctx, c), options)
        if (step.stateKey !== undefined) c.state[step.stateKey] = response
        break
      }
      case 'handoff': {
        const rich = ctx as RichContext
        if (typeof rich.handoff !== 'function') throw new Error('handoff step: this context does not support handoff')
        await rich.handoff({ ...(step.reason !== undefined ? { reason: step.reason } : {}) })
        if (step.message !== undefined) await c.say(renderTemplate(step.message, scopeOf(ctx, c)))
        // The handoff cancelled this conversation; end explicitly in case the runtime did not.
        c.end()
        break
      }
      case 'ai': {
        const answer = await aiStep(step, ctx, c)
        if (step.stateKey !== undefined) c.state[step.stateKey] = answer
        break
      }
    }
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Expression/template scope: `c.state` plus read-only `$` fields of the triggering message. */
export function flowScope(ctx: RuntimeMessage, c: { state: Record<string, unknown> }): Record<string, unknown> {
  return { ...c.state, $body: ctx.body, $from: ctx.from, $sender: ctx.sender, $isGroup: ctx.isGroup }
}
const scopeOf = flowScope

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
      const scope = { $answer: body, $body: ctx.body, $from: ctx.from, $sender: ctx.sender, $isGroup: ctx.isGroup }
      return evaluateCondition(test, scope) ? true : (message ?? step.text)
    }
  }
  return Object.keys(opts).length ? opts : undefined
}

function waitOptions(timeout: FlowDuration | undefined): WaitOptions | undefined {
  return timeout === undefined ? undefined : { timeout: toMs(timeout) }
}

function mediaSourceOf(source: FlowMediaDocumentSource, type: string): FlowMediaSource {
  if (type === 'location') {
    const loc = source as Extract<FlowMediaDocumentSource, { latitude: number }>
    return { lat: loc.latitude, lng: loc.longitude, ...(loc.name !== undefined ? { name: loc.name } : {}) } satisfies FlowLocation
  }
  if ('url' in source) return (source as { url: string }).url
  if (!isStateSource(source)) throw new TypeError('media step: source must be a url, a stateKey or coordinates')
  const key = source.stateKey
  return ((_ctx: RuntimeMessage, c: ConversationControls) => {
    const value = c.state[key]
    if (typeof value === 'string') return value
    if (typeof value === 'object' && value !== null && typeof (value as { url?: unknown }).url === 'string') {
      return { url: (value as { url: string }).url }
    }
    throw new Error(`media step: c.state.${key} must be a URL string or { url } (got ${typeof value})`)
  }) as unknown as FlowMediaSource
}

/** The MessageContext members an action needs beyond the narrow `RuntimeMessage`. */
interface RichContext extends RuntimeMessage {
  photo?(source: MediaSource, caption?: string): Promise<unknown>
  video?(source: MediaSource, caption?: string, opts?: { gifPlayback?: boolean; ptv?: boolean }): Promise<unknown>
  audio?(source: MediaSource): Promise<unknown>
  voice?(source: MediaSource): Promise<unknown>
  file?(source: MediaSource, filename?: string, caption?: string): Promise<unknown>
  sticker?(source: MediaSource, opts?: { pack?: string; author?: string }): Promise<unknown>
  location?(lat: number, lng: number, name?: string): Promise<unknown>
  handoff?(opts?: { reason?: string }): Promise<boolean>
  tools?: unknown
}

async function sendMedia(ctx: RuntimeMessage, step: Extract<Prepared, { kind: 'media' }>, scope: Record<string, unknown>): Promise<void> {
  const rich = ctx as RichContext
  const raw = 'stateKey' in step.source ? resolveMediaSource(step.source, scope) : step.source
  if (step.type === 'location') {
    const loc = raw as Extract<FlowMediaDocumentSource, { latitude: number }>
    if (typeof rich.location !== 'function') throw new Error('media step: this context cannot send a location')
    await rich.location(loc.latitude, loc.longitude, loc.name)
    return
  }
  const media: MediaSource = typeof raw === 'string' ? raw : { url: (raw as { url: string }).url }
  const caption = step.caption !== undefined ? renderTemplate(step.caption, scope) : undefined
  const send = async () => {
    switch (step.type) {
      case 'image':
        if (typeof rich.photo !== 'function') throw new Error('media step: this context cannot send an image')
        return rich.photo(media, caption)
      case 'video':
        if (typeof rich.video !== 'function') throw new Error('media step: this context cannot send a video')
        return rich.video(media, caption)
      case 'audio':
        if (typeof rich.audio !== 'function') throw new Error('media step: this context cannot send audio')
        return rich.audio(media)
      case 'voice':
        if (typeof rich.voice !== 'function') throw new Error('media step: this context cannot send a voice note')
        return rich.voice(media)
      case 'sticker':
        if (typeof rich.sticker !== 'function') throw new Error('media step: this context cannot send a sticker')
        return rich.sticker(media)
      case 'document':
        if (typeof rich.file !== 'function') throw new Error('media step: this context cannot send a document')
        return rich.file(media, step.filename, caption)
    }
  }
  await send()
}

function isStateSource(source: FlowMediaDocumentSource | { stateKey: string }): source is { stateKey: string } {
  return typeof source === 'object' && source !== null && 'stateKey' in source
}

function resolveMediaSource(source: FlowMediaDocumentSource | { stateKey: string }, scope: Record<string, unknown>): FlowMediaDocumentSource {
  if (!isStateSource(source)) return source
  const value = scope[source.stateKey]
  if (typeof value === 'string') return { url: value }
  if (typeof value === 'object' && value !== null && typeof (value as { url?: unknown }).url === 'string') return value as { url: string }
  if (typeof value === 'object' && value !== null && typeof (value as { latitude?: unknown }).latitude === 'number') return value as FlowMediaDocumentSource
  throw new Error(`media step: c.state.${source.stateKey} must be a URL string, { url } or a location`)
}

function formDefinitionOf(form: FlowFormDocument): FormDefinition {
  const fields = form.fields.map((field): FormField => {
    const base = {
      name: field.name,
      label: field.label,
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field.helper !== undefined ? { helper: field.helper } : {}),
      ...(field.prompt !== undefined ? { prompt: field.prompt } : {}),
      ...(field.error !== undefined ? { error: field.error } : {}),
    }
    switch (field.type) {
      case 'text':
        return {
          ...base, type: 'text',
          ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
          ...(field.pattern !== undefined ? { pattern: field.pattern } : {}),
          ...(field.multiline !== undefined ? { multiline: field.multiline } : {}),
        }
      case 'number':
        return {
          ...base, type: 'number',
          ...(typeof field.min === 'number' ? { min: field.min } : {}),
          ...(typeof field.max === 'number' ? { max: field.max } : {}),
          ...(field.integer !== undefined ? { integer: field.integer } : {}),
        }
      case 'email':
        return { ...base, type: 'email' }
      case 'date':
        return {
          ...base, type: 'date',
          ...(typeof field.min === 'string' ? { min: field.min } : {}),
          ...(typeof field.max === 'string' ? { max: field.max } : {}),
        }
      case 'select':
        return { ...base, type: 'select', options: field.options! }
      case 'multiselect':
        return {
          ...base, type: 'multiselect', options: field.options!,
          ...(field.minSelected !== undefined ? { minSelected: field.minSelected } : {}),
          ...(field.maxSelected !== undefined ? { maxSelected: field.maxSelected } : {}),
        }
      case 'optin':
        return { ...base, type: 'optin' }
    }
  })
  return {
    id: form.id,
    ...(form.title !== undefined ? { title: form.title } : {}),
    ...(form.intro !== undefined ? { intro: form.intro } : {}),
    ...(form.cta !== undefined ? { cta: form.cta } : {}),
    ...(form.submitLabel !== undefined ? { submitLabel: form.submitLabel } : {}),
    fields,
  }
}

function formOptionsOf(step: Extract<FlowStepDocument, { kind: 'form' }>): FormStepOptions | undefined {
  const opts: FormStepOptions = {
    ...(step.stateKey !== undefined ? { stateKey: step.stateKey } : {}),
    ...(step.flatten !== undefined ? { flatten: step.flatten } : {}),
    ...(step.mode !== undefined ? { mode: step.mode } : {}),
    ...(step.nativeId !== undefined ? { nativeId: step.nativeId } : {}),
    ...(step.timeout !== undefined ? { timeout: toMs(step.timeout) } : {}),
    ...(step.retries !== undefined ? { retries: step.retries } : {}),
  }
  return Object.keys(opts).length ? opts : undefined
}

async function httpStep(step: Extract<Prepared, { kind: 'http' }>, scope: Record<string, unknown>, options: CompileFlowOptions): Promise<unknown> {
  const url = renderTemplate(step.url, scope)
  const headers = Object.fromEntries(Object.entries(step.headers ?? {}).map(([k, v]) => [k, renderTemplate(v, scope)]))
  const hasBody = step.body !== undefined && step.method !== 'GET'
  const fetch = options.fetch ?? secureFetch
  const response = await fetch(url, {
    method: step.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(step.body) } : {}),
    timeoutMs: step.timeoutMs ?? options.http?.timeoutMs ?? 10_000,
    maxBytes: options.http?.maxBytes ?? 64 * 1024,
    ...(options.http?.allowHttp === true ? { allowHttp: true } : {}),
  })
  const text = response.body.toString('utf8')
  const type = response.response.headers.get('content-type') ?? ''
  if (type.includes('json')) {
    try { return JSON.parse(text) } catch { throw new Error(`http step: ${step.method} ${url} returned invalid JSON`) }
  }
  return text
}

interface AILike {
  replyInChat(chatKey: string, userText: string, opts?: { userId?: string; isGroup?: boolean; ctx?: RuntimeMessage; tools?: readonly string[] }): Promise<string>
}

async function aiStep(step: Extract<Prepared, { kind: 'ai' }>, ctx: RuntimeMessage, c: ConversationControls): Promise<string> {
  const tools = ((ctx as RichContext).tools as { ai?: AILike } | undefined)?.ai
  if (!tools || typeof tools.replyInChat !== 'function') {
    throw new Error('ai step: ctx.tools.ai is not available (plug aiPlugin() first)')
  }
  const answer = await tools.replyInChat(ctx.from, renderTemplate(step.prompt, scopeOf(ctx, c)), {
    userId: ctx.sender,
    isGroup: ctx.isGroup,
    ctx,
    ...(step.tools !== undefined ? { tools: step.tools } : {}),
  })
  return answer
}
