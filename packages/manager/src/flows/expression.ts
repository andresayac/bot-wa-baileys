/**
 * The safe expression language now lives in `@botmesh/flow-schema` (shared with the
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
} from '@botmesh/flow-schema'
export type { ExpressionNode } from '@botmesh/flow-schema'
