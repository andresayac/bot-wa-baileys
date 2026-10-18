/**
 * `bot-wa/no-empty-trigger` — an empty trigger (`''`, `'   '`, `[]`, `['']`,
 * `{ pattern: '' }`) never matches what you expect: the default match is
 * normalized equality, and an empty `contains` pattern captures every message.
 * Checked in `flow(...)` / `addKeyword(...)`, `bot.when(...)` and the
 * `trigger` option of `bot.conversation(name, fn, { trigger })`.
 */

import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { FLOW_FACTORIES, calleeName, findProperty } from '../utils.js'

/** Why a trigger expression is empty, or undefined when it is not (or cannot be known statically). */
function emptyReason(node: ESTree.Node | undefined): string | undefined {
  if (!node) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value.trim() === '' ? 'an empty string' : undefined
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.every((q) => (q.value.cooked ?? q.value.raw).trim() === '') ? 'an empty string' : undefined
  }
  if (node.type === 'ArrayExpression') {
    if (node.elements.length === 0) return 'an empty array'
    const allEmpty = node.elements.every((el) => el !== null && el.type !== 'SpreadElement' && emptyReason(el) === 'an empty string')
    return allEmpty ? 'an array of empty strings' : undefined
  }
  if (node.type === 'ObjectExpression') {
    const pattern = findProperty(node, 'pattern')
    return pattern ? emptyReason(pattern.value) : undefined
  }
  return undefined
}

export const noEmptyTrigger: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow empty triggers in flow(), addKeyword(), bot.when() and conversation triggers',
      recommended: true,
    },
    schema: [],
    messages: {
      empty: 'This trigger is {{reason}}: it never matches a real message (or, with `contains`, matches every message). Give it a keyword, a RegExp or a predicate.',
    },
  },
  create(context) {
    const report = (node: ESTree.Node | undefined) => {
      const reason = emptyReason(node)
      if (node && reason) context.report({ node, messageId: 'empty', data: { reason } })
    }
    return {
      CallExpression(node: ESTree.CallExpression) {
        const name = calleeName(node)
        if (node.callee.type === 'Identifier' && name && FLOW_FACTORIES.has(name)) return report(node.arguments[0])
        if (node.callee.type !== 'MemberExpression') return
        if (name === 'when') return report(node.arguments[0])
        if (name === 'conversation') {
          const opts = node.arguments[2]
          if (opts && opts.type === 'ObjectExpression') report(findProperty(opts, 'trigger')?.value)
        }
      },
    }
  },
}
