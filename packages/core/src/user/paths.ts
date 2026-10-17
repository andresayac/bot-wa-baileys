/**
 * Dot-path, namespace and value helpers for `ctx.user` (internal).
 *
 * Paths are split on EVERY dot: `'address.city'` → `['address', 'city']`. The
 * first segment is the top-level key — the unit a store persists atomically.
 * Values are JSON data, so containers are plain objects and arrays only.
 */

import { UserDataError } from './errors.js'

/** Max length of a top-level key (the first path segment). */
export const MAX_USER_KEY_LENGTH = 255
/** Max length of a namespace name. */
export const MAX_USER_NAMESPACE_LENGTH = 128

/** Segments that could reach `Object.prototype` (prototype pollution). */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/

type JsonObject = Record<string, unknown>
type JsonContainer = JsonObject | unknown[]

const describe = (value: string): string => JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value)

/** Split and validate a dot path. Throws `UserDataError('INVALID_PATH')`. */
export function parsePath(path: unknown): [string, ...string[]] {
  if (typeof path !== 'string' || path.length === 0) {
    throw new UserDataError('INVALID_PATH', 'User data path must be a non-empty string')
  }
  const segments = path.split('.')
  for (const segment of segments) {
    if (segment === '') {
      throw new UserDataError('INVALID_PATH', `Invalid user data path ${describe(path)}: empty segment`)
    }
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new UserDataError('INVALID_PATH', `Invalid user data path ${describe(path)}: segment "${segment}" is not allowed`)
    }
    if (CONTROL_CHARS.test(segment)) {
      throw new UserDataError('INVALID_PATH', `Invalid user data path ${describe(path)}: control characters are not allowed`)
    }
  }
  if (segments[0]!.length > MAX_USER_KEY_LENGTH) {
    throw new UserDataError('INVALID_PATH', `Invalid user data path ${describe(path)}: top-level key exceeds ${MAX_USER_KEY_LENGTH} characters`)
  }
  return segments as [string, ...string[]]
}

/** Validate a namespace name. Throws `UserDataError('INVALID_NAMESPACE')`. */
export function assertNamespace(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new UserDataError('INVALID_NAMESPACE', 'User data namespace must be a non-empty string')
  }
  if (name.length > MAX_USER_NAMESPACE_LENGTH) {
    throw new UserDataError('INVALID_NAMESPACE', `User data namespace exceeds ${MAX_USER_NAMESPACE_LENGTH} characters`)
  }
  if (CONTROL_CHARS.test(name)) {
    throw new UserDataError('INVALID_NAMESPACE', `Invalid user data namespace ${describe(name)}: control characters are not allowed`)
  }
}

/** Validate a subject id. Throws `UserDataError('INVALID_USER')`. */
export function assertUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new UserDataError('INVALID_USER', 'User data requires a non-empty subject id (ctx.sender)')
  }
}

/**
 * Deep-copy a value through JSON — the representation every store persists.
 * `Date` becomes an ISO string, `undefined` object members are dropped.
 * Throws `UserDataError('INVALID_VALUE')` for BigInt, functions, symbols and cycles.
 */
export function toJsonValue(value: unknown): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (cause) {
    throw new UserDataError('INVALID_VALUE', 'User data values must be JSON-serialisable (no BigInt or circular structures)', { cause })
  }
  if (text === undefined) {
    throw new UserDataError('INVALID_VALUE', `User data values must be JSON-serialisable (got ${typeof value})`)
  }
  return JSON.parse(text) as unknown
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContainer(value: unknown): value is JsonContainer {
  return typeof value === 'object' && value !== null
}

/** Read the value at `segments` below `root` (own properties / array indices only). */
export function getAt(root: unknown, segments: readonly string[]): unknown {
  let node = root
  for (const segment of segments) {
    if (Array.isArray(node)) {
      if (!ARRAY_INDEX.test(segment)) return undefined
      node = node[Number(segment)]
    } else if (isObject(node)) {
      if (!Object.hasOwn(node, segment)) return undefined
      node = node[segment]
    } else {
      return undefined
    }
  }
  return node
}

/**
 * Write `value` at `segments` (non-empty) below `root`, mutating and returning
 * the root container. A missing or primitive intermediate is replaced by a
 * plain object; arrays are addressed by index and may only grow by appending
 * (`index <= length`) so no holes appear.
 */
export function setAt(root: unknown, segments: readonly string[], value: unknown): JsonContainer {
  const top: JsonContainer = isContainer(root) ? root : {}
  let node: JsonContainer = top
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    const last = i === segments.length - 1
    if (Array.isArray(node)) {
      if (!ARRAY_INDEX.test(segment) || Number(segment) > node.length) {
        throw new UserDataError('INVALID_PATH', `Cannot write array element "${segment}": use an existing index or append at ${node.length}`)
      }
      const index = Number(segment)
      if (last) {
        node[index] = value
      } else {
        const child = node[index]
        const next: JsonContainer = isContainer(child) ? child : {}
        node[index] = next
        node = next
      }
    } else {
      if (last) {
        node[segment] = value
      } else {
        const child = Object.hasOwn(node, segment) ? node[segment] : undefined
        const next: JsonContainer = isContainer(child) ? child : {}
        node[segment] = next
        node = next
      }
    }
  }
  return top
}

/**
 * Remove the value at `segments` (non-empty) below `root`, in place. Array
 * elements are spliced out (later elements shift down). Returns whether
 * anything was removed.
 */
export function unsetAt(root: unknown, segments: readonly string[]): boolean {
  const parent = getAt(root, segments.slice(0, -1))
  const last = segments[segments.length - 1]!
  if (Array.isArray(parent)) {
    if (!ARRAY_INDEX.test(last) || Number(last) >= parent.length) return false
    parent.splice(Number(last), 1)
    return true
  }
  if (isObject(parent) && Object.hasOwn(parent, last)) {
    delete parent[last]
    return true
  }
  return false
}
