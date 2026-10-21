/**
 * The flow-document compiler now lives in `@bot-wa/flow-schema` (shared with the
 * deployment gate and the product packages). This module keeps the manager's imports
 * and its REST contract stable.
 */

export {
  FlowDocumentError,
  compileFlowDocument,
  isFlowDocument,
  validateFlowDocument,
} from '@bot-wa/flow-schema'
export type {
  FlowDocument,
  FlowDocumentIssue,
  FlowDocumentTrigger,
  FlowDuration,
  FlowStepDocument,
} from '@bot-wa/flow-schema'
