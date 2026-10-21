/**
 * `botmesh/require-timeout-on-ask` — every wait for user input should have a
 * timeout, so an abandoned conversation does not stay open (and keep
 * capturing that user's messages) forever.
 *
 * - Flow DSL: `flow(...).ask(text, key, { timeout })`, or a `.timeout(...)`
 *   anywhere on the same chain (unless `allowFlowTimeout: false`). A flow's
 *   `.choose(...)` has no per-step options, so it needs the chain `.timeout()`.
 * - Conversations: `c.ask(text, { timeout })`, `c.waitText({ timeout })`,
 *   `c.waitMedia(types, { timeout })`, `c.choose(prompt, options, { timeout })`.
 *
 * When the options argument is not an object literal (a variable, a call) the
 * rule cannot see inside it and stays quiet.
 *
 * Options: `{ methods?: string[], allowFlowTimeout?: boolean }`. `methods`
 * defaults to `['ask']`; add `'waitText'`, `'waitMedia'`, `'choose'` and
 * `'waitAny'` for a stricter check.
 */

import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { calleeName, chainMethodNames, findProperty, isFlowChain } from '../utils.js'

interface Options {
  methods?: string[]
  allowFlowTimeout?: boolean
}

/** Index of the options argument of each conversation-control wait. */
const CONTROL_OPTS_INDEX: Record<string, number> = { ask: 1, waitText: 0, waitMedia: 1, choose: 2, waitAny: 0 }
/** Flow-DSL waits → index of their options argument (`null` = the step takes none). */
const FLOW_OPTS_INDEX: Record<string, number | null> = { ask: 2, choose: null }

export const requireTimeoutOnAsk: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require a timeout on ask()/wait*() so abandoned conversations end',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          methods: {
            type: 'array',
            items: { type: 'string', enum: ['ask', 'waitText', 'waitMedia', 'choose', 'waitAny'] },
            uniqueItems: true,
          },
          allowFlowTimeout: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing: "`{{method}}()` waits for the user without a timeout. Pass `{ timeout: '5m' }`{{flowHint}}.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const methods = new Set(options.methods ?? ['ask'])
    const allowFlowTimeout = options.allowFlowTimeout !== false

    /** True when the options argument sets a timeout, or cannot be inspected statically. */
    const optsHaveTimeout = (arg: ESTree.Node | undefined): boolean => {
      if (!arg) return false
      if (arg.type !== 'ObjectExpression') return true
      if (arg.properties.some((p) => p.type === 'SpreadElement')) return true
      return !!findProperty(arg, 'timeout')
    }

    return {
      CallExpression(node: ESTree.CallExpression) {
        if (node.callee.type !== 'MemberExpression') return
        const method = calleeName(node)
        if (!method || !methods.has(method)) return

        if (isFlowChain(node)) {
          if (!(method in FLOW_OPTS_INDEX)) return
          if (allowFlowTimeout && chainMethodNames(node).includes('timeout')) return
          const idx = FLOW_OPTS_INDEX[method]
          if (typeof idx === 'number' && optsHaveTimeout(node.arguments[idx])) return
          context.report({
            node: node.callee.property,
            messageId: 'missing',
            data: { method, flowHint: allowFlowTimeout ? " or add `.timeout('10m')` to the flow" : '' },
          })
          return
        }

        const idx = CONTROL_OPTS_INDEX[method]
        if (idx === undefined || optsHaveTimeout(node.arguments[idx])) return
        context.report({ node: node.callee.property, messageId: 'missing', data: { method, flowHint: '' } })
      },
    }
  },
}
