/**
 * Versioned JSON Schema (draft 2020-12) of a JSON flow document — see {@link FlowDocument}.
 * Served by the manager's REST API at `GET /v1/flows/schema` and referenced from its
 * OpenAPI document. {@link validateFlowDocument} enforces the same rules (plus expression
 * syntax and cross-field checks) without a schema-validator dependency.
 *
 * A flow document is **data only**: no code, no `eval`, no arbitrary module imports. The
 * only computation is the safe expression language (`expression.ts`) and `{{ path }}`
 * templates over `c.state`/the triggering message.
 */

import { parseExpression, ExpressionError } from './expression.js'

/** Current (and only) flow document format version. */
export const FLOW_DOCUMENT_VERSION = 1 as const

/** Stable `$id` of the v1 schema. */
export const FLOW_DOCUMENT_SCHEMA_ID = 'https://bot-wa.dev/schemas/flow-document/v1.json'

/** Structural limits of a flow document (also enforced by the validator). */
export const FLOW_DOCUMENT_LIMITS = Object.freeze({
  maxSteps: 500,
  maxDepth: 8,
  maxTextLength: 4096,
  maxOptions: 20,
  maxDelayMs: 300_000,
  /** Upper bound of every `timeout` (7 days; must stay below setTimeout's 2^31-1 ms). */
  maxTimeoutMs: 604_800_000,
  maxKeywords: 50,
  maxFields: 50,
  maxTools: 20,
  maxUrlLength: 2048,
  maxHeaders: 20,
  maxHttpBodyBytes: 16_384,
})

/** Identifier pattern for flow ids, state keys, option keys and goto targets. */
export const FLOW_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'

/** Keyword trigger of a flow document. */
export type FlowDocumentTrigger =
  | string
  | string[]
  | { keywords: string[]; match?: 'equals' | 'contains' | 'startsWith' | 'endsWith'; scope?: 'dm' | 'group' | 'all' }

/** A duration: milliseconds, or `'500ms'` / `'30s'` / `'5m'` / `'1h'`. */
export type FlowDuration = number | string

/** Media kinds a document can send. */
export type FlowMediaDocumentKind = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'location'

/** Where a media step gets its bytes: a public URL, a state path or coordinates. */
export type FlowMediaDocumentSource =
  | { url: string }
  | { stateKey: string }
  | { latitude: number; longitude: number; name?: string; address?: string }

/** A native form field in JSON (the `pattern` is a string, not a RegExp). */
export interface FlowFormFieldDocument {
  name: string
  label: string
  type: 'text' | 'number' | 'email' | 'date' | 'select' | 'multiselect' | 'optin'
  required?: boolean
  helper?: string
  prompt?: string
  error?: string
  minLength?: number
  maxLength?: number
  pattern?: string
  multiline?: boolean
  min?: number | string
  max?: number | string
  integer?: boolean
  options?: Record<string, string> | string[]
  minSelected?: number
  maxSelected?: number
}

/** A native form definition in JSON. */
export interface FlowFormDocument {
  id: string
  title?: string
  intro?: string
  cta?: string
  submitLabel?: string
  fields: FlowFormFieldDocument[]
}

/** One step of a flow document. */
export type FlowStepDocument =
  | { kind: 'say'; text: string }
  | { kind: 'ask'; text: string; stateKey: string; timeout?: FlowDuration; retries?: number; validate?: { expr: string; message?: string } }
  | { kind: 'choose'; text: string; options: Array<{ key: string; label: string; steps?: FlowStepDocument[] }>; stateKey?: string; timeout?: FlowDuration }
  | { kind: 'delay'; duration: FlowDuration }
  | { kind: 'goto'; target: string }
  | { kind: 'end'; text?: string }
  | { kind: 'condition'; if: string; then: FlowStepDocument[]; else?: FlowStepDocument[] }
  | { kind: 'media'; type: FlowMediaDocumentKind; source: FlowMediaDocumentSource; caption?: string; filename?: string }
  | { kind: 'form'; form: FlowFormDocument; stateKey?: string; flatten?: boolean; mode?: 'auto' | 'native' | 'degraded'; nativeId?: string; timeout?: FlowDuration; retries?: number }
  | { kind: 'guard'; if: string; message?: string; redirect?: string }
  | { kind: 'subflow'; flowId: string }
  | { kind: 'http'; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; headers?: Record<string, string>; body?: unknown; stateKey?: string; timeout?: FlowDuration }
  | { kind: 'handoff'; reason?: string; message?: string }
  | { kind: 'ai'; prompt: string; tools?: string[]; stateKey?: string }

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

/** Thrown by the compiler for an invalid document. */
export class FlowDocumentError extends Error {
  constructor(readonly issues: FlowDocumentIssue[]) {
    super(`invalid flow document: ${issues.slice(0, 3).map((i) => `${i.path || '/'} ${i.message}`).join('; ')}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ''}`)
    this.name = 'FlowDocumentError'
  }
}

const durationOf = (maxMs: number) => ({
  description: `Milliseconds, or a duration string such as "500ms", "30s", "5m", "1h" (at most ${maxMs} ms).`,
  oneOf: [
    { type: 'integer', minimum: 0, maximum: maxMs },
    { type: 'string', pattern: '^\\s*\\d+(\\.\\d+)?\\s*(ms|s|m|h)\\s*$' },
  ],
})
const duration = durationOf(FLOW_DOCUMENT_LIMITS.maxTimeoutMs)
const text = { type: 'string', minLength: 1, maxLength: FLOW_DOCUMENT_LIMITS.maxTextLength, description: 'Message text; supports {{ path }} placeholders over c.state and $body/$from/$sender/$isGroup.' }
const expression = { type: 'string', minLength: 1, maxLength: 1000, description: 'Safe expression: literals, state paths, == != < <= > >= && || ! + -, and len/lower/upper/trim/number/string/contains/startsWith/endsWith/empty/oneOf.' }
const identifier = { type: 'string', pattern: FLOW_ID_PATTERN }
const steps = { type: 'array', items: { $ref: '#/$defs/step' }, maxItems: FLOW_DOCUMENT_LIMITS.maxSteps }
const options = {
  oneOf: [
    { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: FLOW_DOCUMENT_LIMITS.maxOptions },
    { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 200 }, minProperties: 1, maxProperties: FLOW_DOCUMENT_LIMITS.maxOptions },
  ],
}

/** The JSON Schema object itself (draft 2020-12). */
export const FLOW_DOCUMENT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: FLOW_DOCUMENT_SCHEMA_ID,
  title: 'bot-wa flow document',
  description: 'Declarative conversation flow compiled to a @bot-wa/core CompiledFlow. Data only: no code.',
  type: 'object',
  required: ['version', 'id', 'trigger', 'steps'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    version: { const: FLOW_DOCUMENT_VERSION },
    id: identifier,
    name: { type: 'string', maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    trigger: { $ref: '#/$defs/trigger' },
    timeout: duration,
    persistent: { type: 'boolean' },
    steps: { ...steps, minItems: 1 },
  },
  $defs: {
    keyword: { type: 'string', minLength: 1, maxLength: 200 },
    trigger: {
      oneOf: [
        { $ref: '#/$defs/keyword' },
        { type: 'array', items: { $ref: '#/$defs/keyword' }, minItems: 1, maxItems: FLOW_DOCUMENT_LIMITS.maxKeywords },
        {
          type: 'object',
          required: ['keywords'],
          additionalProperties: false,
          properties: {
            keywords: { type: 'array', items: { $ref: '#/$defs/keyword' }, minItems: 1, maxItems: FLOW_DOCUMENT_LIMITS.maxKeywords },
            match: { enum: ['equals', 'contains', 'startsWith', 'endsWith'] },
            scope: { enum: ['dm', 'group', 'all'] },
          },
        },
      ],
    },
    step: {
      oneOf: [
        { $ref: '#/$defs/say' }, { $ref: '#/$defs/ask' }, { $ref: '#/$defs/choose' }, { $ref: '#/$defs/delay' },
        { $ref: '#/$defs/goto' }, { $ref: '#/$defs/end' }, { $ref: '#/$defs/condition' }, { $ref: '#/$defs/media' },
        { $ref: '#/$defs/form' }, { $ref: '#/$defs/guard' }, { $ref: '#/$defs/subflow' }, { $ref: '#/$defs/http' },
        { $ref: '#/$defs/handoff' }, { $ref: '#/$defs/ai' },
      ],
    },
    say: { type: 'object', required: ['kind', 'text'], additionalProperties: false, properties: { kind: { const: 'say' }, text } },
    ask: {
      type: 'object',
      required: ['kind', 'text', 'stateKey'],
      additionalProperties: false,
      properties: {
        kind: { const: 'ask' },
        text,
        stateKey: identifier,
        timeout: duration,
        retries: { type: 'integer', minimum: 0, maximum: 20 },
        validate: {
          type: 'object',
          required: ['expr'],
          additionalProperties: false,
          properties: { expr: expression, message: text },
          description: 'The answer is accepted when `expr` is truthy; `$answer` holds the raw answer.',
        },
      },
    },
    choose: {
      type: 'object',
      required: ['kind', 'text', 'options'],
      additionalProperties: false,
      properties: {
        kind: { const: 'choose' },
        text,
        stateKey: identifier,
        timeout: duration,
        options: {
          type: 'array',
          minItems: 1,
          maxItems: FLOW_DOCUMENT_LIMITS.maxOptions,
          items: {
            type: 'object',
            required: ['key', 'label'],
            additionalProperties: false,
            properties: { key: identifier, label: { type: 'string', minLength: 1, maxLength: 200 }, steps },
          },
        },
      },
    },
    delay: { type: 'object', required: ['kind', 'duration'], additionalProperties: false, properties: { kind: { const: 'delay' }, duration: durationOf(FLOW_DOCUMENT_LIMITS.maxDelayMs) } },
    goto: { type: 'object', required: ['kind', 'target'], additionalProperties: false, properties: { kind: { const: 'goto' }, target: identifier } },
    end: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'end' }, text } },
    condition: {
      type: 'object',
      required: ['kind', 'if', 'then'],
      additionalProperties: false,
      properties: { kind: { const: 'condition' }, if: expression, then: steps, else: steps },
    },
    media: {
      type: 'object',
      required: ['kind', 'type', 'source'],
      additionalProperties: false,
      properties: {
        kind: { const: 'media' },
        type: { enum: ['image', 'video', 'audio', 'voice', 'document', 'sticker', 'location'] },
        source: {
          oneOf: [
            { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', minLength: 1, maxLength: FLOW_DOCUMENT_LIMITS.maxUrlLength } } },
            { type: 'object', required: ['stateKey'], additionalProperties: false, properties: { stateKey: identifier } },
            {
              type: 'object', required: ['latitude', 'longitude'], additionalProperties: false,
              properties: {
                latitude: { type: 'number', minimum: -90, maximum: 90 },
                longitude: { type: 'number', minimum: -180, maximum: 180 },
                name: { type: 'string', maxLength: 200 },
                address: { type: 'string', maxLength: 500 },
              },
            },
          ],
        },
        caption: text,
        filename: { type: 'string', maxLength: 255 },
      },
    },
    form: {
      type: 'object',
      required: ['kind', 'form'],
      additionalProperties: false,
      properties: {
        kind: { const: 'form' },
        form: { $ref: '#/$defs/formDefinition' },
        stateKey: identifier,
        flatten: { type: 'boolean' },
        mode: { enum: ['auto', 'native', 'degraded'] },
        nativeId: { type: 'string', minLength: 1, maxLength: 200 },
        timeout: duration,
        retries: { type: 'integer', minimum: 0, maximum: 20 },
      },
    },
    formDefinition: {
      type: 'object',
      required: ['id', 'fields'],
      additionalProperties: false,
      properties: {
        id: identifier,
        title: { type: 'string', maxLength: 200 },
        intro: text,
        cta: { type: 'string', minLength: 1, maxLength: 100 },
        submitLabel: { type: 'string', minLength: 1, maxLength: 100 },
        fields: { type: 'array', minItems: 1, maxItems: FLOW_DOCUMENT_LIMITS.maxFields, items: { $ref: '#/$defs/formField' } },
      },
    },
    formField: {
      type: 'object',
      required: ['name', 'label', 'type'],
      additionalProperties: false,
      properties: {
        name: identifier,
        label: { type: 'string', minLength: 1, maxLength: 200 },
        type: { enum: ['text', 'number', 'email', 'date', 'select', 'multiselect', 'optin'] },
        required: { type: 'boolean' },
        helper: { type: 'string', maxLength: 500 },
        prompt: text,
        error: { type: 'string', maxLength: 500 },
        minLength: { type: 'integer', minimum: 0 },
        maxLength: { type: 'integer', minimum: 1 },
        pattern: { type: 'string', minLength: 1, maxLength: 500 },
        multiline: { type: 'boolean' },
        min: { oneOf: [{ type: 'number' }, { type: 'string', maxLength: 20 }] },
        max: { oneOf: [{ type: 'number' }, { type: 'string', maxLength: 20 }] },
        integer: { type: 'boolean' },
        options,
        minSelected: { type: 'integer', minimum: 0 },
        maxSelected: { type: 'integer', minimum: 1 },
      },
    },
    guard: {
      type: 'object',
      required: ['kind', 'if'],
      additionalProperties: false,
      properties: { kind: { const: 'guard' }, if: expression, message: text, redirect: identifier },
    },
    subflow: { type: 'object', required: ['kind', 'flowId'], additionalProperties: false, properties: { kind: { const: 'subflow' }, flowId: identifier } },
    http: {
      type: 'object',
      required: ['kind', 'method', 'url'],
      additionalProperties: false,
      properties: {
        kind: { const: 'http' },
        method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        url: { type: 'string', minLength: 1, maxLength: FLOW_DOCUMENT_LIMITS.maxUrlLength },
        headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 1000 }, maxProperties: FLOW_DOCUMENT_LIMITS.maxHeaders },
        body: {},
        stateKey: identifier,
        timeout: duration,
      },
    },
    handoff: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: { kind: { const: 'handoff' }, reason: { type: 'string', maxLength: 200 }, message: text },
    },
    ai: {
      type: 'object',
      required: ['kind', 'prompt'],
      additionalProperties: false,
      properties: {
        kind: { const: 'ai' },
        prompt: text,
        tools: { type: 'array', items: identifier, minItems: 1, maxItems: FLOW_DOCUMENT_LIMITS.maxTools },
        stateKey: identifier,
      },
    },
  },
})

const ID_RE = new RegExp(FLOW_ID_PATTERN)
const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/
const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
const MATCH = new Set(['equals', 'contains', 'startsWith', 'endsWith'])
const SCOPES = new Set(['dm', 'group', 'all'])
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker', 'location'])
const FIELD_TYPES = new Set(['text', 'number', 'email', 'date', 'select', 'multiselect', 'optin'])
const STEP_KEYS: Record<FlowStepDocument['kind'], readonly string[]> = {
  say: ['kind', 'text'],
  ask: ['kind', 'text', 'stateKey', 'timeout', 'retries', 'validate'],
  choose: ['kind', 'text', 'options', 'stateKey', 'timeout'],
  delay: ['kind', 'duration'],
  goto: ['kind', 'target'],
  end: ['kind', 'text'],
  condition: ['kind', 'if', 'then', 'else'],
  media: ['kind', 'type', 'source', 'caption', 'filename'],
  form: ['kind', 'form', 'stateKey', 'flatten', 'mode', 'nativeId', 'timeout', 'retries'],
  guard: ['kind', 'if', 'message', 'redirect'],
  subflow: ['kind', 'flowId'],
  http: ['kind', 'method', 'url', 'headers', 'body', 'stateKey', 'timeout'],
  handoff: ['kind', 'reason', 'message'],
  ai: ['kind', 'prompt', 'tools', 'stateKey'],
}
const DOC_KEYS = ['$schema', 'version', 'id', 'name', 'description', 'trigger', 'timeout', 'persistent', 'steps']

/**
 * Validate an untrusted value as a {@link FlowDocument}. Returns every issue found
 * (empty array = valid). Checks the schema rules, the structural limits, the syntax of
 * every expression and the cross-field rules (location fields, form fields, URLs...).
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
  if (input.timeout !== undefined) checkTimeout(input.timeout, '/timeout', add)
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
      if (step.timeout !== undefined) checkTimeout(step.timeout, `${path}/timeout`, add)
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
      if (step.timeout !== undefined) checkTimeout(step.timeout, `${path}/timeout`, add)
      const choices = step.options
      if (!Array.isArray(choices) || choices.length === 0 || choices.length > FLOW_DOCUMENT_LIMITS.maxOptions) {
        add(`${path}/options`, `must be an array of 1-${FLOW_DOCUMENT_LIMITS.maxOptions} options`)
        break
      }
      const seen = new Set<string>()
      choices.forEach((o, i) => {
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
    case 'media':
      checkMedia(step, path, add)
      break
    case 'form':
      checkForm(step, path, add)
      break
    case 'guard':
      checkExpression(step.if, `${path}/if`, add)
      if (step.message !== undefined) checkText(step.message, `${path}/message`, add)
      if (step.redirect !== undefined) checkId(step.redirect, `${path}/redirect`, add)
      if (step.message === undefined && step.redirect === undefined) add(path, 'a guard needs a message, a redirect or both')
      break
    case 'subflow':
      checkId(step.flowId, `${path}/flowId`, add)
      break
    case 'http':
      checkHttp(step, path, add)
      break
    case 'handoff':
      if (step.reason !== undefined && (typeof step.reason !== 'string' || step.reason.length > 200)) add(`${path}/reason`, 'must be a string of at most 200 characters')
      if (step.message !== undefined) checkText(step.message, `${path}/message`, add)
      break
    case 'ai':
      checkText(step.prompt, `${path}/prompt`, add)
      if (step.stateKey !== undefined) checkId(step.stateKey, `${path}/stateKey`, add)
      if (step.tools !== undefined) {
        if (!Array.isArray(step.tools) || step.tools.length === 0 || step.tools.length > FLOW_DOCUMENT_LIMITS.maxTools) {
          add(`${path}/tools`, `must be an array of 1-${FLOW_DOCUMENT_LIMITS.maxTools} tool ids`)
        } else {
          step.tools.forEach((tool, i) => checkId(tool, `${path}/tools/${i}`, add))
        }
      }
      break
  }
}

function checkMedia(step: Record<string, unknown>, path: string, add: Add): void {
  const type = step.type
  if (typeof type !== 'string' || !MEDIA_KINDS.has(type)) {
    add(`${path}/type`, `must be one of ${[...MEDIA_KINDS].join(', ')}`)
    return
  }
  if (step.caption !== undefined) checkText(step.caption, `${path}/caption`, add)
  if (step.filename !== undefined && (typeof step.filename !== 'string' || step.filename.length === 0 || step.filename.length > 255)) {
    add(`${path}/filename`, 'must be a string of 1-255 characters')
  }
  const source = step.source
  if (!isObject(source)) { add(`${path}/source`, 'must be an object'); return }
  if (type === 'location') {
    extraKeys(source, ['latitude', 'longitude', 'name', 'address'], `${path}/source`, add)
    if (typeof source.latitude !== 'number' || source.latitude < -90 || source.latitude > 90) add(`${path}/source/latitude`, 'must be a number between -90 and 90')
    if (typeof source.longitude !== 'number' || source.longitude < -180 || source.longitude > 180) add(`${path}/source/longitude`, 'must be a number between -180 and 180')
    if (source.name !== undefined && typeof source.name !== 'string') add(`${path}/source/name`, 'must be a string')
    if (source.address !== undefined && typeof source.address !== 'string') add(`${path}/source/address`, 'must be a string')
    return
  }
  extraKeys(source, ['url', 'stateKey'], `${path}/source`, add)
  if (source.url !== undefined) {
    checkUrl(source.url, `${path}/source/url`, add, true)
  } else if (source.stateKey !== undefined) {
    checkId(source.stateKey, `${path}/source/stateKey`, add)
  } else {
    add(`${path}/source`, 'needs a url or a stateKey')
  }
}

function checkForm(step: Record<string, unknown>, path: string, add: Add): void {
  const form = step.form
  if (!isObject(form)) { add(`${path}/form`, 'must be an object'); return }
  extraKeys(form, ['id', 'title', 'intro', 'cta', 'submitLabel', 'fields'], `${path}/form`, add)
  checkId(form.id, `${path}/form/id`, add)
  if (form.title !== undefined && (typeof form.title !== 'string' || form.title.length > 200)) add(`${path}/form/title`, 'must be a string of at most 200 characters')
  if (form.intro !== undefined) checkText(form.intro, `${path}/form/intro`, add)
  for (const key of ['cta', 'submitLabel'] as const) {
    if (form[key] !== undefined && (typeof form[key] !== 'string' || form[key].length === 0 || form[key].length > 100)) add(`${path}/form/${key}`, 'must be a string of 1-100 characters')
  }
  if (!Array.isArray(form.fields) || form.fields.length === 0 || form.fields.length > FLOW_DOCUMENT_LIMITS.maxFields) {
    add(`${path}/form/fields`, `must be an array of 1-${FLOW_DOCUMENT_LIMITS.maxFields} fields`)
    return
  }
  const names = new Set<string>()
  form.fields.forEach((field, i) => {
    const p = `${path}/form/fields/${i}`
    if (!isObject(field)) { add(p, 'must be an object'); return }
    const allowed = ['name', 'label', 'type', 'required', 'helper', 'prompt', 'error', 'minLength', 'maxLength', 'pattern', 'multiline', 'min', 'max', 'integer', 'options', 'minSelected', 'maxSelected']
    extraKeys(field, allowed, p, add)
    checkId(field.name, `${p}/name`, add)
    if (typeof field.name === 'string') {
      if (names.has(field.name)) add(`${p}/name`, `duplicate field name "${field.name}"`)
      names.add(field.name)
    }
    if (typeof field.label !== 'string' || field.label.length === 0 || field.label.length > 200) add(`${p}/label`, 'must be a string of 1-200 characters')
    if (typeof field.type !== 'string' || !FIELD_TYPES.has(field.type)) { add(`${p}/type`, `must be one of ${[...FIELD_TYPES].join(', ')}`); return }
    if (field.required !== undefined && typeof field.required !== 'boolean') add(`${p}/required`, 'must be a boolean')
    if (field.helper !== undefined && (typeof field.helper !== 'string' || field.helper.length > 500)) add(`${p}/helper`, 'must be a string of at most 500 characters')
    if (field.prompt !== undefined) checkText(field.prompt, `${p}/prompt`, add)
    if (field.error !== undefined && (typeof field.error !== 'string' || field.error.length > 500)) add(`${p}/error`, 'must be a string of at most 500 characters')
    if (field.pattern !== undefined) {
      if (typeof field.pattern !== 'string' || field.pattern.length === 0 || field.pattern.length > 500) add(`${p}/pattern`, 'must be a string of 1-500 characters')
      else {
        try { new RegExp(field.pattern) } catch { add(`${p}/pattern`, 'must be a valid regular expression') }
      }
    }
    if (field.type === 'text') {
      if (field.minLength !== undefined && (!Number.isInteger(field.minLength) || (field.minLength as number) < 0)) add(`${p}/minLength`, 'must be a non-negative integer')
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || (field.maxLength as number) < 1)) add(`${p}/maxLength`, 'must be a positive integer')
      if (field.multiline !== undefined && typeof field.multiline !== 'boolean') add(`${p}/multiline`, 'must be a boolean')
    }
    if (field.type === 'number') {
      if (field.min !== undefined && typeof field.min !== 'number') add(`${p}/min`, 'must be a number')
      if (field.max !== undefined && typeof field.max !== 'number') add(`${p}/max`, 'must be a number')
      if (field.integer !== undefined && typeof field.integer !== 'boolean') add(`${p}/integer`, 'must be a boolean')
    }
    if (field.type === 'date') {
      for (const key of ['min', 'max'] as const) {
        if (field[key] !== undefined && (typeof field[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(field[key] as string))) add(`${p}/${key}`, 'must be a YYYY-MM-DD date')
      }
    }
    if (field.type === 'select' || field.type === 'multiselect') {
      const opts = field.options
      const valid = Array.isArray(opts)
        ? opts.length >= 1 && opts.every((o) => typeof o === 'string' && o.length > 0)
        : isObject(opts) && Object.keys(opts).length >= 1 && Object.values(opts).every((v) => typeof v === 'string' && v.length > 0)
      if (!valid) add(`${p}/options`, 'must be a non-empty array of labels or a { key: label } object')
      if (field.type === 'multiselect') {
        if (field.minSelected !== undefined && (!Number.isInteger(field.minSelected) || (field.minSelected as number) < 0)) add(`${p}/minSelected`, 'must be a non-negative integer')
        if (field.maxSelected !== undefined && (!Number.isInteger(field.maxSelected) || (field.maxSelected as number) < 1)) add(`${p}/maxSelected`, 'must be a positive integer')
      }
    }
  })
  if (step.stateKey !== undefined) checkId(step.stateKey, `${path}/stateKey`, add)
  if (step.flatten !== undefined && typeof step.flatten !== 'boolean') add(`${path}/flatten`, 'must be a boolean')
  if (step.mode !== undefined && !['auto', 'native', 'degraded'].includes(step.mode as string)) add(`${path}/mode`, 'must be auto, native or degraded')
  if (step.nativeId !== undefined && (typeof step.nativeId !== 'string' || step.nativeId.length === 0 || step.nativeId.length > 200)) add(`${path}/nativeId`, 'must be a string of 1-200 characters')
  if (step.timeout !== undefined) checkTimeout(step.timeout, `${path}/timeout`, add)
  if (step.retries !== undefined && (!Number.isInteger(step.retries) || (step.retries as number) < 0 || (step.retries as number) > 20)) add(`${path}/retries`, 'must be an integer between 0 and 20')
}

function checkHttp(step: Record<string, unknown>, path: string, add: Add): void {
  if (typeof step.method !== 'string' || !METHODS.has(step.method)) add(`${path}/method`, `must be one of ${[...METHODS].join(', ')}`)
  checkUrl(step.url, `${path}/url`, add, false)
  if (step.stateKey !== undefined) checkId(step.stateKey, `${path}/stateKey`, add)
  if (step.timeout !== undefined) checkTimeout(step.timeout, `${path}/timeout`, add)
  if (step.headers !== undefined) {
    if (!isObject(step.headers)) add(`${path}/headers`, 'must be an object of string values')
    else {
      if (Object.keys(step.headers).length > FLOW_DOCUMENT_LIMITS.maxHeaders) add(`${path}/headers`, `must have at most ${FLOW_DOCUMENT_LIMITS.maxHeaders} headers`)
      for (const [name, value] of Object.entries(step.headers)) {
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) add(`${path}/headers/${name}`, 'invalid header name')
        if (typeof value !== 'string' || value.length > 1000) add(`${path}/headers/${name}`, 'must be a string of at most 1000 characters')
        if (/^(host|content-length|connection|transfer-encoding)$/i.test(name)) add(`${path}/headers/${name}`, 'header is managed by the HTTP client')
      }
    }
  }
  if (step.body !== undefined) {
    let size: number
    try { size = Buffer.byteLength(JSON.stringify(step.body), 'utf8') } catch { add(`${path}/body`, 'must be JSON-serializable'); return }
    if (size > FLOW_DOCUMENT_LIMITS.maxHttpBodyBytes) add(`${path}/body`, `must serialize to at most ${FLOW_DOCUMENT_LIMITS.maxHttpBodyBytes} bytes`)
  }
}

function checkUrl(v: unknown, path: string, add: Add, media: boolean): void {
  if (typeof v !== 'string' || v.length === 0 || v.length > FLOW_DOCUMENT_LIMITS.maxUrlLength) {
    add(path, `must be a string of 1-${FLOW_DOCUMENT_LIMITS.maxUrlLength} characters`)
    return
  }
  let url: URL
  try { url = new URL(v) } catch { add(path, 'must be an absolute http(s) URL'); return }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') add(path, 'must use http or https')
  if (media && url.protocol !== 'https:' && url.protocol !== 'http:') add(path, 'must use http or https')
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

function checkTimeout(v: unknown, path: string, add: Add): void {
  if (checkDuration(v, path, add) && toMs(v as FlowDuration) > FLOW_DOCUMENT_LIMITS.maxTimeoutMs) {
    add(path, `must be at most ${FLOW_DOCUMENT_LIMITS.maxTimeoutMs} ms`)
  }
}

function checkExpression(v: unknown, path: string, add: Add): void {
  if (typeof v !== 'string') { add(path, 'must be an expression string'); return }
  try {
    parseExpression(v)
  } catch (error) {
    add(path, error instanceof ExpressionError ? error.message : 'invalid expression')
  }
}

/** Parse a duration into milliseconds; throws for an invalid value (document must be validated first). */
export function toMs(d: FlowDuration): number {
  if (typeof d === 'number') return d
  const m = DURATION_RE.exec(d)
  if (!m) throw new TypeError(`invalid duration: ${JSON.stringify(d)}`)
  return Math.round(parseFloat(m[1]) * UNITS[m[2]])
}

function extraKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, add: Add): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) add(`${path}/${key}`, 'unknown property')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
