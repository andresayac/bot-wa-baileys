/**
 * Safe expression language for JSON flow documents (`condition.if`, `ask.validate`).
 *
 * A tiny recursive-descent parser: no `eval`, no `Function`, no property access
 * beyond plain own-property paths, no regexes (ReDoS), no loops. Expressions are
 * parsed once at compile time (syntax errors surface as validation issues) and
 * evaluated against a read-only scope (`c.state` + `$body`/`$from`/`$sender`/
 * `$isGroup`/`$answer`).
 *
 * Grammar:
 * ```
 * expr    := or
 * or      := and ('||' and)*
 * and     := cmp ('&&' cmp)*
 * cmp     := add (('=='|'!='|'<'|'<='|'>'|'>=') add)?
 * add     := unary (('+'|'-') unary)*
 * unary   := ('!'|'-') unary | primary
 * primary := number | string | true | false | null
 *          | ident '(' [expr (',' expr)*] ')'      // whitelisted function
 *          | ident ('.' ident)*                     // variable path
 *          | '(' expr ')'
 * ```
 * Functions: `len`, `lower`, `upper`, `trim`, `number`, `string`, `contains`,
 * `startsWith`, `endsWith`, `empty`, `oneOf`.
 */

/** Hard limits that keep evaluation cheap and bounded. */
export const EXPRESSION_LIMITS = Object.freeze({ maxLength: 1000, maxDepth: 32, maxTokens: 256 })

/** A syntax error in a flow expression. */
export class ExpressionError extends Error {
  constructor(message: string, readonly position?: number) {
    super(message)
    this.name = 'ExpressionError'
  }
}

/** Parsed expression AST (opaque to callers; evaluate it with {@link evaluateExpression}). */
export type ExpressionNode =
  | { t: 'lit'; v: string | number | boolean | null }
  | { t: 'path'; p: readonly string[] }
  | { t: 'not' | 'neg'; a: ExpressionNode }
  | { t: 'bin'; op: BinaryOp; a: ExpressionNode; b: ExpressionNode }
  | { t: 'call'; fn: FunctionName; args: ExpressionNode[] }

type BinaryOp = '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-'

const FUNCTIONS = {
  len: (x: unknown) => (typeof x === 'string' || Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x).length : 0),
  lower: (x: unknown) => str(x).toLowerCase(),
  upper: (x: unknown) => str(x).toUpperCase(),
  trim: (x: unknown) => str(x).trim(),
  number: (x: unknown) => toNumber(x) ?? null,
  string: (x: unknown) => str(x),
  contains: (a: unknown, b: unknown) => (Array.isArray(a) ? a.some((v) => equals(v, b)) : str(a).includes(str(b))),
  startsWith: (a: unknown, b: unknown) => str(a).startsWith(str(b)),
  endsWith: (a: unknown, b: unknown) => str(a).endsWith(str(b)),
  empty: (x: unknown) => x === undefined || x === null || (typeof x === 'string' && x.trim() === '') || (Array.isArray(x) && x.length === 0),
  oneOf: (x: unknown, ...options: unknown[]) => options.some((o) => equals(x, o)),
} satisfies Record<string, (...args: unknown[]) => unknown>

type FunctionName = keyof typeof FUNCTIONS

const ARITY: Record<FunctionName, [min: number, max: number]> = {
  len: [1, 1], lower: [1, 1], upper: [1, 1], trim: [1, 1], number: [1, 1], string: [1, 1], empty: [1, 1],
  contains: [2, 2], startsWith: [2, 2], endsWith: [2, 2], oneOf: [2, 32],
}

/** Path segments that could reach the prototype chain are rejected at parse time. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

type Token =
  | { k: 'num'; v: number; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'id'; v: string; pos: number }
  | { k: 'op'; v: string; pos: number }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue }
    if (out.length >= EXPRESSION_LIMITS.maxTokens) throw new ExpressionError('expression has too many tokens', i)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!
      out.push({ k: 'num', v: Number(m[0]), pos: i })
      i += m[0].length
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      let v = ''
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e
          j += 2
        } else {
          v += src[j++]
        }
      }
      if (j >= src.length) throw new ExpressionError('unterminated string', i)
      out.push({ k: 'str', v, pos: i })
      i = j + 1
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!
      out.push({ k: 'id', v: m[0], pos: i })
      i += m[0].length
      continue
    }
    const two = src.slice(i, i + 2)
    if (['||', '&&', '==', '!=', '<=', '>='].includes(two)) {
      out.push({ k: 'op', v: two, pos: i })
      i += 2
      continue
    }
    if ('<>!+-().,'.includes(ch)) {
      out.push({ k: 'op', v: ch, pos: i })
      i++
      continue
    }
    throw new ExpressionError(`unexpected character "${ch}"`, i)
  }
  return out
}

/** Parse `source` into an AST. Throws {@link ExpressionError} on any syntax or limit violation. */
export function parseExpression(source: string): ExpressionNode {
  if (typeof source !== 'string' || source.trim() === '') throw new ExpressionError('expression must be a non-empty string')
  if (source.length > EXPRESSION_LIMITS.maxLength) throw new ExpressionError(`expression longer than ${EXPRESSION_LIMITS.maxLength} characters`)
  const tokens = tokenize(source)
  let pos = 0
  let depth = 0
  const peek = () => tokens[pos]
  const isOp = (v: string) => peek()?.k === 'op' && peek()!.v === v
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ExpressionError(`expected "${v}"`, peek()?.pos ?? source.length)
    pos++
  }
  const enter = () => { if (++depth > EXPRESSION_LIMITS.maxDepth) throw new ExpressionError('expression nested too deeply') }

  const binary = (ops: readonly string[], next: () => ExpressionNode, single = false): ExpressionNode => {
    let left = next()
    for (let tok = peek(); tok?.k === 'op' && ops.includes(tok.v); tok = peek()) {
      pos++
      const op = tok.v as BinaryOp
      left = { t: 'bin', op, a: left, b: next() }
      if (single) break
    }
    return left
  }
  const or = (): ExpressionNode => binary(['||'], and)
  const and = (): ExpressionNode => binary(['&&'], cmp)
  const cmp = (): ExpressionNode => binary(['==', '!=', '<', '<=', '>', '>='], add, true)
  const add = (): ExpressionNode => binary(['+', '-'], unary)
  const unary = (): ExpressionNode => {
    if (isOp('!') || isOp('-')) {
      const op = tokens[pos++].v
      enter()
      const a = unary()
      depth--
      return { t: op === '!' ? 'not' : 'neg', a }
    }
    return primary()
  }
  const primary = (): ExpressionNode => {
    const tok = peek()
    if (!tok) throw new ExpressionError('unexpected end of expression', source.length)
    if (tok.k === 'num') { pos++; return { t: 'lit', v: tok.v } }
    if (tok.k === 'str') { pos++; return { t: 'lit', v: tok.v } }
    if (tok.k === 'op' && tok.v === '(') {
      pos++
      enter()
      const inner = or()
      depth--
      expectOp(')')
      return inner
    }
    if (tok.k === 'id') {
      pos++
      if (tok.v === 'true') return { t: 'lit', v: true }
      if (tok.v === 'false') return { t: 'lit', v: false }
      if (tok.v === 'null') return { t: 'lit', v: null }
      if (isOp('(')) {
        if (!Object.hasOwn(FUNCTIONS, tok.v)) throw new ExpressionError(`unknown function "${tok.v}"`, tok.pos)
        const fn = tok.v as FunctionName
        pos++
        enter()
        const args: ExpressionNode[] = []
        if (!isOp(')')) {
          args.push(or())
          while (isOp(',')) { pos++; args.push(or()) }
        }
        depth--
        expectOp(')')
        const [min, max] = ARITY[fn]
        if (args.length < min || args.length > max) throw new ExpressionError(`${fn}() takes ${min === max ? min : `${min}-${max}`} argument(s)`, tok.pos)
        return { t: 'call', fn, args }
      }
      const path = [tok.v]
      while (isOp('.')) {
        pos++
        const seg = peek()
        if (seg?.k !== 'id') throw new ExpressionError('expected a property name after "."', seg?.pos ?? source.length)
        path.push(seg.v)
        pos++
      }
      for (const seg of path) if (FORBIDDEN_SEGMENTS.has(seg)) throw new ExpressionError(`forbidden property "${seg}"`, tok.pos)
      return { t: 'path', p: path }
    }
    throw new ExpressionError(`unexpected "${tok.v}"`, tok.pos)
  }

  const ast = or()
  if (pos < tokens.length) throw new ExpressionError(`unexpected "${tokens[pos].v}"`, tokens[pos].pos)
  return ast
}

/** Evaluate a parsed expression against `scope`. Never throws for missing variables (they are `undefined`). */
export function evaluateExpression(node: ExpressionNode, scope: Readonly<Record<string, unknown>>): unknown {
  switch (node.t) {
    case 'lit': return node.v
    case 'path': return resolvePath(scope, node.p)
    case 'not': return !truthy(evaluateExpression(node.a, scope))
    case 'neg': return -(toNumber(evaluateExpression(node.a, scope)) ?? Number.NaN)
    case 'call': return (FUNCTIONS[node.fn] as (...args: unknown[]) => unknown)(...node.args.map((a) => evaluateExpression(a, scope)))
    case 'bin': {
      if (node.op === '||') return truthy(evaluateExpression(node.a, scope)) || truthy(evaluateExpression(node.b, scope))
      if (node.op === '&&') return truthy(evaluateExpression(node.a, scope)) && truthy(evaluateExpression(node.b, scope))
      const a = evaluateExpression(node.a, scope)
      const b = evaluateExpression(node.b, scope)
      switch (node.op) {
        case '==': return equals(a, b)
        case '!=': return !equals(a, b)
        case '+': {
          const na = toNumber(a)
          const nb = toNumber(b)
          return typeof a === 'number' && typeof b === 'number' ? a + b : na !== undefined && nb !== undefined && (typeof a === 'number' || typeof b === 'number') ? na + nb : str(a) + str(b)
        }
        case '-': return (toNumber(a) ?? Number.NaN) - (toNumber(b) ?? Number.NaN)
        default: return compare(node.op, a, b)
      }
    }
  }
}

/** Parse + evaluate in one call, coerced to a boolean (`condition.if`). */
export function evaluateCondition(node: ExpressionNode, scope: Readonly<Record<string, unknown>>): boolean {
  return truthy(evaluateExpression(node, scope))
}

/** Resolve a dotted path over plain own properties only. */
export function resolvePath(scope: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let cur: unknown = scope
  for (const seg of path) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return undefined
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function truthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && v !== 0 && v !== '' && !(typeof v === 'number' && Number.isNaN(v))
}

function str(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return '' }
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(',', '.'))
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** `==`: strict, except a number compared with a numeric string compares numerically (answers are strings). */
function equals(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    const na = toNumber(a)
    const nb = toNumber(b)
    if (na !== undefined && nb !== undefined) return na === nb
  }
  if (a === undefined) return b === undefined || b === null
  if (a === null) return b === undefined || b === null
  return a === b
}

function compare(op: '<' | '<=' | '>' | '>=', a: unknown, b: unknown): boolean {
  const na = toNumber(a)
  const nb = toNumber(b)
  let x: number | string
  let y: number | string
  if (na !== undefined && nb !== undefined) { x = na; y = nb } else { x = str(a); y = str(b) }
  switch (op) {
    case '<': return x < y
    case '<=': return x <= y
    case '>': return x > y
    case '>=': return x >= y
  }
}

/** Render `{{ path }}` placeholders from `scope` (missing → empty string). Only paths, never expressions. */
export function renderTemplate(template: string, scope: Readonly<Record<string, unknown>>): string {
  return template.replace(TEMPLATE_RE, (_m, path: string) => str(resolvePath(scope, path.split('.'))))
}

/** Whether `text` contains at least one `{{ path }}` placeholder. */
export function hasTemplate(text: string): boolean {
  TEMPLATE_RE.lastIndex = 0
  const found = TEMPLATE_RE.test(text)
  TEMPLATE_RE.lastIndex = 0
  return found
}

const TEMPLATE_RE = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\}\}/g
