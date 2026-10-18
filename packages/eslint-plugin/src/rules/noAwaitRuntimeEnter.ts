/**
 * `bot-wa/no-await-runtime-enter` — `ConversationRuntime.enter()` resolves when
 * the conversation ENDS, so awaiting it inside a handler blocks that chat's
 * FIFO queue (the user's next message, the one the conversation waits for,
 * never gets dispatched). Launch it fire-and-forget instead:
 * `void runtime.enter(...).catch(...)`.
 */

import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { memberPropertyName, tailName } from '../utils.js'

interface Options {
  /** Regex (source) the receiver name must match. Default: names ending in "runtime" (case-insensitive). */
  receiverPattern?: string
}

export const noAwaitRuntimeEnter: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow awaiting ConversationRuntime.enter() (it blocks the chat queue until the conversation ends)',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: { receiverPattern: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      awaited:
        '`{{receiver}}.enter()` resolves only when the conversation ends; awaiting it blocks this chat\'s queue. ' +
        'Launch it fire-and-forget: `void {{receiver}}.enter(...).catch(...)`.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const receiverRe = new RegExp(options.receiverPattern ?? 'runtime$', 'i')

    const check = (expr: ESTree.Node, reportNode: ESTree.Node) => {
      if (expr.type !== 'CallExpression' || expr.callee.type !== 'MemberExpression') return
      if (memberPropertyName(expr.callee) !== 'enter') return
      const receiver = tailName(expr.callee.object)
      if (!receiver || !receiverRe.test(receiver)) return
      context.report({ node: reportNode, messageId: 'awaited', data: { receiver } })
    }

    return {
      AwaitExpression(node: ESTree.AwaitExpression) {
        check(node.argument, node)
      },
      // Returning the promise from a handler makes the dispatcher await it just the same.
      ReturnStatement(node: ESTree.ReturnStatement) {
        if (node.argument) check(node.argument, node)
      },
      ArrowFunctionExpression(node: ESTree.ArrowFunctionExpression) {
        if (node.body.type !== 'BlockStatement') check(node.body, node.body)
      },
      // `await runtime.enter(...).catch(...)` (or .then/.finally) still waits for the whole conversation.
      'AwaitExpression > CallExpression > MemberExpression.callee'(node: ESTree.MemberExpression) {
        const name = memberPropertyName(node)
        if (name === 'then' || name === 'catch' || name === 'finally') check(node.object, node.object)
      },
    }
  },
}
