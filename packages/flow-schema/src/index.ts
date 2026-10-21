/**
 * @bot-wa/flow-schema — versioned, code-free JSON flows for BotWA.
 *
 * - **Validation**: {@link validateFlowDocument} / {@link isFlowDocument} and the
 *   JSON Schema itself ({@link FLOW_DOCUMENT_SCHEMA}, draft 2020-12), with precise
 *   JSON-pointer issues and structural limits.
 * - **Safe expressions**: {@link parseExpression} / {@link evaluateExpression} /
 *   {@link renderTemplate}. No `eval`, no `Function`, no regexes, no property access
 *   beyond plain own-property paths.
 * - **Compilation**: {@link compileFlowDocument} turns a document into a core
 *   `CompiledFlow` (`say`, `ask`, `choose`, `delay`, `goto`, `end`, `condition`, `media`,
 *   `form`, `guard`, `subflow`, `http`, `handoff` and an `ai` step with tools by id).
 * - **Reverse export**: {@link exportFlowDocument} turns an introspectable
 *   `CompiledFlow` back into JSON (exact for flows compiled from a document).
 * - **Migrations**: {@link migrateFlowDocument} chains version upgrades.
 * - **Deployments**: {@link flowDigest}, {@link diffFlowDocuments},
 *   {@link flowDocumentGate} and {@link publishFlow} (the optional integration with
 *   `@bot-wa/deployments`).
 *
 * Private package: not published to npm.
 *
 * @example
 * ```ts
 * import { compileFlowDocument, validateFlowDocument } from '@bot-wa/flow-schema'
 *
 * const document = {
 *   version: 1 as const, id: 'encuesta', trigger: 'encuesta',
 *   steps: [
 *     { kind: 'ask' as const, text: '¿Tu nombre?', stateKey: 'name' },
 *     { kind: 'say' as const, text: 'Gracias {{name}}' },
 *   ],
 * }
 * if (validateFlowDocument(document).length === 0) bot.registerFlow(compileFlowDocument(document))
 * ```
 */

export {
  FLOW_DOCUMENT_VERSION,
  FLOW_DOCUMENT_SCHEMA_ID,
  FLOW_DOCUMENT_SCHEMA,
  FLOW_DOCUMENT_LIMITS,
  FLOW_ID_PATTERN,
  FlowDocumentError,
  isFlowDocument,
  toMs,
  validateFlowDocument,
} from './schema.js'
export type {
  FlowDocument,
  FlowDocumentIssue,
  FlowDocumentTrigger,
  FlowDuration,
  FlowFormDocument,
  FlowFormFieldDocument,
  FlowMediaDocumentKind,
  FlowMediaDocumentSource,
  FlowStepDocument,
} from './schema.js'

export {
  EXPRESSION_LIMITS,
  ExpressionError,
  evaluateCondition,
  evaluateExpression,
  hasTemplate,
  parseExpression,
  renderTemplate,
  resolvePath,
} from './expression.js'
export type { ExpressionNode } from './expression.js'

export { FLOW_DOCUMENT_SOURCE, FLOW_STEP_SOURCE, compileFlowDocument, flowDocumentSource, flowScope, flowStepSource } from './compile.js'
export type { CompileFlowOptions } from './compile.js'

export { FlowExportError, exportFlowDocument } from './introspect.js'

export { FLOW_MIGRATIONS, FlowMigrationError, migrateFlowDocument } from './migrate.js'
export type { FlowMigration, MigrationResult } from './migrate.js'

export {
  canonicalJson,
  diffFlowDocuments,
  flowArtifact,
  flowDigest,
  flowDocumentGate,
  flowFromArtifact,
  flowIssuesOf,
  flowVersionOf,
  publishFlow,
  sameFlow,
} from './deployments.js'
export type { FlowDifference, FlowDocumentDiff, PublishFlowOptions } from './deployments.js'
