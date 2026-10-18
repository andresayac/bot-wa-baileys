import type { AITool, AIToolDefinition, AIToolSet, JSONSchema, SafeParseSchema } from './types.js'

const EMPTY_OBJECT_SCHEMA: JSONSchema = { type: 'object', properties: {} }

/** True when `s` is a `safeParse`-compatible validator (zod & co) rather than a JSON Schema. */
export function isSafeParseSchema(s: unknown): s is SafeParseSchema {
  return typeof s === 'object' && s !== null && typeof (s as { safeParse?: unknown }).safeParse === 'function'
}

/** Model-facing JSON Schema of a tool's arguments (always an object schema). */
export function parametersOf(tool: AITool<unknown>): JSONSchema {
  let schema: JSONSchema | undefined = tool.jsonSchema
  if (!schema && tool.schema) {
    if (isSafeParseSchema(tool.schema)) {
      const toJson = (tool.schema as { toJSONSchema?: unknown }).toJSONSchema
      if (typeof toJson === 'function') {
        const out: unknown = toJson.call(tool.schema)
        if (out && typeof out === 'object') schema = out as JSONSchema
      }
    } else {
      schema = tool.schema
    }
  }
  if (!schema) return { ...EMPTY_OBJECT_SCHEMA }
  const { $schema: _drop, ...rest } = schema
  return rest.type === undefined ? { type: 'object', ...rest } : rest
}

/** Provider-neutral definitions for every tool of the set. */
export function toolDefinitions(tools: AIToolSet): AIToolDefinition[] {
  return Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, parameters: parametersOf(tool) }))
}

export type ArgsValidation = { ok: true; data: unknown } | { ok: false; error: string }

/** Validate raw model arguments against the tool schema. */
export function validateArgs(tool: AITool<unknown>, raw: unknown): ArgsValidation {
  const args = raw === undefined || raw === null ? {} : raw
  const schema = tool.schema
  if (!schema) return { ok: true, data: args }
  if (isSafeParseSchema(schema)) {
    const r = schema.safeParse(args)
    return r.success ? { ok: true, data: r.data } : { ok: false, error: describeError(r.error) }
  }
  const errors: string[] = []
  checkJson(schema, args, '$', errors)
  return errors.length === 0 ? { ok: true, data: args } : { ok: false, error: errors.join('; ') }
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const issues = (err as { issues?: unknown }).issues
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.map((i: unknown) => {
        const issue = i as { path?: unknown; message?: unknown }
        const path = Array.isArray(issue.path) && issue.path.length ? `${issue.path.join('.')}: ` : ''
        return `${path}${String(issue.message ?? 'invalid')}`
      }).join('; ')
    }
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string') return msg
  }
  return String(err)
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function matchesType(expected: unknown, v: unknown): boolean {
  const actual = typeOf(v)
  const one = (t: unknown) => t === actual || (t === 'number' && actual === 'integer')
  return Array.isArray(expected) ? expected.some(one) : one(expected)
}

/** Minimal JSON Schema subset: type, enum, const, required, properties, additionalProperties:false, items, minimum/maximum (and exclusive), minLength/maxLength, minItems/maxItems. */
function checkJson(schema: JSONSchema, v: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined && !matchesType(schema.type, v)) {
    errors.push(`${path}: expected ${Array.isArray(schema.type) ? schema.type.join('|') : String(schema.type)}, got ${typeOf(v)}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === v)) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  }
  if ('const' in schema && schema.const !== v) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`)
  if (typeof v === 'number') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && v > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && v <= schema.exclusiveMinimum) errors.push(`${path}: must be > ${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === 'number' && v >= schema.exclusiveMaximum) errors.push(`${path}: must be < ${schema.exclusiveMaximum}`)
  }
  if (typeof v === 'string') {
    if (typeof schema.minLength === 'number' && v.length < schema.minLength) errors.push(`${path}: must have at least ${schema.minLength} characters`)
    if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) errors.push(`${path}: must have at most ${schema.maxLength} characters`)
  }
  if (Array.isArray(v)) {
    if (typeof schema.minItems === 'number' && v.length < schema.minItems) errors.push(`${path}: must have at least ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) errors.push(`${path}: must have at most ${schema.maxItems} items`)
  }
  if (typeOf(v) === 'object') {
    const obj = v as Record<string, unknown>
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) if (typeof k === 'string' && !(k in obj)) errors.push(`${path}.${k}: is required`)
    }
    const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties as Record<string, JSONSchema> : undefined
    if (props) {
      for (const [k, sub] of Object.entries(props)) {
        if (k in obj && obj[k] !== undefined && sub && typeof sub === 'object') checkJson(sub, obj[k], `${path}.${k}`, errors)
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!props || !(k in props)) errors.push(`${path}.${k}: is not allowed`)
    }
  }
  if (Array.isArray(v) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    v.forEach((item, i) => checkJson(schema.items as JSONSchema, item, `${path}[${i}]`, errors))
  }
}
