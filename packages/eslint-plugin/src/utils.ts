/**
 * AST helpers shared by the rules. Everything is syntactic (no type
 * information), so the rules work on plain JS and on TS parsed by
 * typescript-eslint alike.
 */

import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

/** An ESTree node with the `parent` link ESLint adds. */
export type NodeWithParent = ESTree.Node & { parent?: NodeWithParent }

/** Name of a non-computed property key / member property (`a.b` → `b`, `{ b: 1 }` → `b`, `{ 'b': 1 }` → `b`). */
export function propertyName(node: ESTree.Node | null | undefined): string | undefined {
  if (!node) return undefined
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  return undefined
}

/** Name of a member property when the member access is not computed (or computed with a string literal). */
export function memberPropertyName(node: ESTree.MemberExpression): string | undefined {
  if (!node.computed) return propertyName(node.property)
  return node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : undefined
}

/** Called name of a call: `foo()` → `foo`, `a.b.foo()` → `foo`. */
export function calleeName(call: ESTree.CallExpression): string | undefined {
  const callee = call.callee
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression') return memberPropertyName(callee)
  return undefined
}

/** Rightmost identifier name of an expression: `runtime` → `runtime`, `this.bot.runtime` → `runtime`. */
export function tailName(node: ESTree.Node): string | undefined {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') return memberPropertyName(node)
  if (node.type === 'ThisExpression') return 'this'
  return undefined
}

/** Find a (non-computed) property of an object literal by key name. */
export function findProperty(obj: ESTree.ObjectExpression, name: string): ESTree.Property | undefined {
  for (const prop of obj.properties) {
    if (prop.type === 'Property' && !prop.computed && propertyName(prop.key) === name) return prop
  }
  return undefined
}

/**
 * Innermost call of a method chain: for `flow('x').say('a').ask('b', 'k')`
 * given the `.ask(...)` call, returns the `flow('x')` call.
 */
export function chainRoot(call: ESTree.CallExpression): ESTree.CallExpression {
  let current = call
  for (;;) {
    const callee = current.callee
    if (callee.type === 'MemberExpression' && callee.object.type === 'CallExpression') current = callee.object
    else return current
  }
}

/** Outermost call of the chain that contains `call` (walks up through `.method(...)` links). */
export function chainTop(call: ESTree.CallExpression): ESTree.CallExpression {
  let current = call as ESTree.CallExpression & { parent?: NodeWithParent }
  for (;;) {
    const parent = current.parent
    if (parent && parent.type === 'MemberExpression' && parent.object === current) {
      const grand = (parent as NodeWithParent).parent
      if (grand && grand.type === 'CallExpression' && grand.callee === parent) {
        current = grand as ESTree.CallExpression & { parent?: NodeWithParent }
        continue
      }
    }
    return current
  }
}

/** Method names of every link of the chain that `call` belongs to (root call name included). */
export function chainMethodNames(call: ESTree.CallExpression): string[] {
  const names: string[] = []
  let current: ESTree.Node = chainTop(call)
  while (current.type === 'CallExpression') {
    const name = calleeName(current)
    if (name) names.push(name)
    const callee: ESTree.Node = current.callee
    if (callee.type === 'MemberExpression') current = callee.object
    else break
  }
  return names
}

/** Names that start a flow-DSL chain. */
export const FLOW_FACTORIES = new Set(['flow', 'addKeyword'])

/** True when `call` is a link of a `flow(...)` / `addKeyword(...)` chain. */
export function isFlowChain(call: ESTree.CallExpression): boolean {
  const root = chainRoot(call)
  return root.callee.type === 'Identifier' && FLOW_FACTORIES.has(root.callee.name)
}

/** Is `fn` an async function expression / arrow? */
export function isAsyncFunction(node: ESTree.Node | null | undefined): boolean {
  return !!node && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && node.async === true
}

/** Narrow a rule listener node to the ESTree type with its parent link. */
export type Listener<T extends ESTree.Node> = (node: T & Rule.NodeParentExtension) => void
