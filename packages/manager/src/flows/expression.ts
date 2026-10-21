/**
 * The safe expression language now lives in `@bot-wa/flow-schema` (shared with the
 * flow store/compiler). This module keeps the manager's import path stable.
 */

export {
  EXPRESSION_LIMITS,
  ExpressionError,
  evaluateCondition,
  evaluateExpression,
  hasTemplate,
  parseExpression,
  renderTemplate,
  resolvePath,
} from '@bot-wa/flow-schema'
export type { ExpressionNode } from '@bot-wa/flow-schema'
