/**
 * `bot-wa/no-v1-api` — flags the v1 / builderbot idioms that do not exist in
 * the @bot-wa v2 API: `.addAnswer()`, `.addAction()`, `{ capture: true }`,
 * `flowDynamic()`, `gotoFlow()` and `endFlow()`.
 */

import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { calleeName, propertyName } from '../utils.js'

/** v1 call name → v2 replacement shown in the message. */
const V1_CALLS: Record<string, string> = {
  addAnswer: "flow(...).say(text) / .ask(text, 'stateKey')",
  addAction: '.do(async (ctx, c) => { ... })',
  flowDynamic: 'ctx.reply(...) or a .say((ctx, c) => ...) step',
  gotoFlow: ".goto('flowName') or c.goto('flowName')",
  endFlow: 'return from the step, or c.end(message)',
}

export const noV1Api: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow v1 / builderbot API calls that do not exist in the @bot-wa v2 API',
      recommended: true,
    },
    schema: [],
    messages: {
      call: '`{{name}}` is v1 API and does not exist in @bot-wa v2. Use {{replacement}}.',
      capture: '`capture: true` is v1 API. Use `.ask(text, \'stateKey\')` in a flow or `await c.ask(text)` in a conversation.',
    },
  },
  create(context) {
    return {
      CallExpression(node: ESTree.CallExpression) {
        const name = calleeName(node)
        if (!name || !Object.prototype.hasOwnProperty.call(V1_CALLS, name)) return
        // `addAnswer` / `addAction` are methods; `flowDynamic` & co. are called bare or as members.
        if ((name === 'addAnswer' || name === 'addAction') && node.callee.type !== 'MemberExpression') return
        context.report({ node: node.callee, messageId: 'call', data: { name, replacement: V1_CALLS[name]! } })
      },
      Property(node: ESTree.Property) {
        if (node.computed || propertyName(node.key) !== 'capture') return
        if (node.value.type === 'Literal' && node.value.value === true) context.report({ node, messageId: 'capture' })
      },
    }
  },
}
