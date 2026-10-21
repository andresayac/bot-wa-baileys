/**
 * `botmesh/prefer-ctx-user-over-global-state` — per-user data belongs in
 * `ctx.user` (persistent, keyed by the provider-resolved sender, shared by
 * every replica through the store), not in a v1 `globalState` nor in a
 * module-level `Map`/object keyed by `ctx.from` / `ctx.sender`, which is lost
 * on restart, grows forever and breaks with several replicas.
 *
 * Options: `{ contextNames?: string[] }` — names of the handler context
 * parameter (default `['ctx']`).
 */

import type { Rule, Scope } from 'eslint'
import type * as ESTree from 'estree'

import { memberPropertyName } from '../utils.js'

interface Options {
  contextNames?: string[]
}

const ID_PROPS = new Set(['from', 'sender', 'senderId'])
const KEYED_METHODS = new Set(['get', 'set', 'has', 'delete'])

export const preferCtxUser: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Prefer ctx.user over globalState or module-level maps keyed by sender/chat id',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: { contextNames: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
        additionalProperties: false,
      },
    ],
    messages: {
      globalState:
        '`globalState` is v1 API. Keep per-user data in `ctx.user` (`await ctx.user.set(key, value)`) and per-conversation data in `c.state`.',
      moduleMap:
        '`{{name}}` is module-level state keyed by `{{key}}`: it is lost on restart and not shared between replicas. ' +
        "Use `ctx.user` (e.g. `await ctx.user.ns('feature').set(key, value)`).",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const ctxNames = new Set(options.contextNames ?? ['ctx'])
    const sourceCode = context.sourceCode

    /** `ctx.from` / `ctx.sender` / `ctx.senderId` → its text, else undefined. */
    const idKey = (node: ESTree.Node | undefined): string | undefined => {
      if (!node || node.type !== 'MemberExpression' || node.object.type !== 'Identifier') return undefined
      const prop = memberPropertyName(node)
      if (!prop || !ID_PROPS.has(prop) || !ctxNames.has(node.object.name)) return undefined
      return node.object.name + '.' + prop
    }

    /** Is the identifier bound at module/global scope (a top-level variable)? */
    const isModuleLevel = (id: ESTree.Identifier, at: ESTree.Node): boolean => {
      let scope: Scope.Scope | null = sourceCode.getScope(at)
      while (scope) {
        if (scope.set.get(id.name)) return scope.type === 'module' || scope.type === 'global'
        scope = scope.upper
      }
      return false
    }

    return {
      Identifier(node: ESTree.Identifier & Rule.NodeParentExtension) {
        if (node.name !== 'globalState') return
        const parent = node.parent
        // Skip `obj.globalState` member names and non-shorthand `{ globalState: x }` keys.
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return
        if (parent.type === 'Property' && parent.key === node && !parent.shorthand) return
        // A shorthand `{ globalState }` visits the same identifier as key and value: report once.
        if (parent.type === 'Property' && parent.shorthand && parent.value !== node) return
        context.report({ node, messageId: 'globalState' })
      },
      // users.get(ctx.from) / users.set(ctx.sender, …)
      CallExpression(node: ESTree.CallExpression) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return
        const method = memberPropertyName(callee)
        if (!method || !KEYED_METHODS.has(method)) return
        const key = idKey(node.arguments[0])
        if (!key || !isModuleLevel(callee.object, node)) return
        context.report({ node, messageId: 'moduleMap', data: { name: callee.object.name, key } })
      },
      // users[ctx.from] = … / users[ctx.from].count++
      MemberExpression(node: ESTree.MemberExpression) {
        if (!node.computed || node.object.type !== 'Identifier') return
        const key = idKey(node.property)
        if (!key || !isModuleLevel(node.object, node)) return
        context.report({ node, messageId: 'moduleMap', data: { name: node.object.name, key } })
      },
    }
  },
}
