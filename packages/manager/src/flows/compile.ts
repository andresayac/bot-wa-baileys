/**
 * The flow-document compiler now lives in `@botmesh/flow-schema` (shared with the
 * deployment gate and the product packages). This module keeps the manager's imports
 * and its REST contract stable.
 */

export {
  FlowDocumentError,
  compileFlowDocument,
  isFlowDocument,
  validateFlowDocument,
} from '@botmesh/flow-schema'
export type {
  FlowDocument,
  FlowDocumentIssue,
  FlowDocumentTrigger,
  FlowDuration,
  FlowStepDocument,
} from '@botmesh/flow-schema'
