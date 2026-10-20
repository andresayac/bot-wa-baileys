/**
 * `bot-wa/no-async-plugin-install` — `Plugin.install()` must be synchronous.
 * `Bot.plug()` does not await it: the bot runs before an async `install` has
 * finished and its rejection only reaches the `'error'` event (nothing is
 * rolled back). TypeScript rejects an async `install` at compile time
 * (`PluginSpec.install` returns `void | SyncInstallError`); this rule covers
 * JavaScript and `as any` escapes. Do async setup lazily (on first use) and
 * report configuration errors from a non-fatal warmup.
 *
 * Checked: the object passed to `definePlugin(...)`, any object literal with
 * both a `name` and an `install` member, and classes with an `install`
 * method that declare a `name` field or `implements Plugin`.
 */

import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { findProperty, isAsyncFunction, propertyName } from '../utils.js'

type ClassLike = ESTree.ClassDeclaration | ESTree.ClassExpression

/** `implements Plugin` (typescript-eslint adds `implements` to class nodes). */
function implementsPlugin(cls: ClassLike): boolean {
  const impl = (cls as unknown as { implements?: Array<{ expression?: ESTree.Node }> }).implements
  return Array.isArray(impl) && impl.some((h) => h.expression?.type === 'Identifier' && h.expression.name === 'Plugin')
}

export const noAsyncPluginInstall: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require Plugin.install() to be synchronous (Bot.plug() does not await it)',
      recommended: true,
    },
    schema: [],
    messages: {
      async:
        'Plugin `install()` must be synchronous and return nothing: `bot.plug()` does not await it, so the bot runs ' +
        'before an async install has finished and its rejection only reaches the error event. ' +
        'Do async setup lazily on first use (see LazyProvider in @bot-wa/ai).',
    },
  },
  create(context) {
    const checkObject = (obj: ESTree.ObjectExpression, requireName: boolean) => {
      const install = findProperty(obj, 'install')
      if (!install) return
      if (requireName && !findProperty(obj, 'name')) return
      if (isAsyncFunction(install.value)) context.report({ node: install, messageId: 'async' })
    }

    const checkClass = (cls: ClassLike) => {
      const members = cls.body.body
      const hasName = members.some(
        (m) => (m.type === 'PropertyDefinition' || m.type === 'MethodDefinition') && !m.computed && propertyName(m.key) === 'name',
      )
      if (!hasName && !implementsPlugin(cls)) return
      for (const m of members) {
        if (m.type === 'MethodDefinition' && !m.computed && !m.static && propertyName(m.key) === 'install' && m.value.async) {
          context.report({ node: m, messageId: 'async' })
        }
      }
    }

    return {
      CallExpression(node: ESTree.CallExpression) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'definePlugin') return
        const arg = node.arguments[0]
        if (arg && arg.type === 'ObjectExpression') checkObject(arg, false)
      },
      ObjectExpression(node: ESTree.ObjectExpression & Rule.NodeParentExtension) {
        // definePlugin({...}) is handled above (without requiring `name`).
        const parent = node.parent
        if (parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'definePlugin') return
        checkObject(node, true)
      },
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    }
  },
}
