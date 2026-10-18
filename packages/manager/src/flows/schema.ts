/**
 * Versioned JSON Schema (draft 2020-12) of a JSON flow document — see
 * {@link FlowDocument}. Served by the REST API at `GET /v1/flows/schema` and
 * referenced from the OpenAPI document. {@link validateFlowDocument} enforces
 * the same rules (plus expression syntax) without a schema-validator dependency.
 */

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
})

/** Identifier pattern for flow ids, state keys, option keys and goto targets. */
export const FLOW_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'

const durationOf = (maxMs: number) => ({
  description: `Milliseconds, or a duration string such as "500ms", "30s", "5m", "1h" (at most ${maxMs} ms).`,
  oneOf: [
    { type: 'integer', minimum: 0, maximum: maxMs },
    { type: 'string', pattern: '^\\s*\\d+(\\.\\d+)?\\s*(ms|s|m|h)\\s*$' },
  ],
})
const duration = durationOf(FLOW_DOCUMENT_LIMITS.maxTimeoutMs)
const text = { type: 'string', minLength: 1, maxLength: FLOW_DOCUMENT_LIMITS.maxTextLength, description: 'Message text; supports {{ path }} placeholders over c.state and $body/$from/$sender/$isGroup.' }
const expression = { type: 'string', minLength: 1, maxLength: 1000, description: 'Safe expression (see the flow guide): literals, state paths, == != < <= > >= && || ! + -, and len/lower/upper/trim/number/string/contains/startsWith/endsWith/empty/oneOf.' }
const identifier = { type: 'string', pattern: FLOW_ID_PATTERN }
const steps = { type: 'array', items: { $ref: '#/$defs/step' }, maxItems: FLOW_DOCUMENT_LIMITS.maxSteps }

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
        { $ref: '#/$defs/goto' }, { $ref: '#/$defs/end' }, { $ref: '#/$defs/condition' },
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
  },
})
