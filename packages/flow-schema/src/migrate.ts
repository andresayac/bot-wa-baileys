/**
 * Version migrations of flow documents. Each migration upgrades one format version to
 * the next; {@link migrateFlowDocument} chains them until the current version and reports
 * what it applied, so an old stored draft can still be validated, compiled and compared.
 */

import { FLOW_DOCUMENT_VERSION, type FlowDocument } from './schema.js'

/** One `from → to` migration. It receives a shallow copy and returns a new document. */
export interface FlowMigration {
  from: number
  to: number
  migrate(document: Record<string, unknown>): Record<string, unknown>
}

/** Thrown when no migration path exists, or the document is newer than this package. */
export class FlowMigrationError extends Error {
  constructor(message: string, readonly from?: number) {
    super(message)
    this.name = 'FlowMigrationError'
  }
}

/**
 * Built-in migrations. Version 1 is the first versioned format; a pre-versioned document
 * (no `version`, or `version: 0`) is the same shape without the field, so it only needs
 * the stamp (and the schema id when absent).
 */
export const FLOW_MIGRATIONS: readonly FlowMigration[] = [
  {
    from: 0,
    to: 1,
    migrate(document) {
      return { version: 1, ...document }
    },
  },
]

/** Result of {@link migrateFlowDocument}. */
export interface MigrationResult {
  /** The migrated document (still unvalidated: run `validateFlowDocument` on it). */
  document: FlowDocument
  /** Version the input was at (0 when it had no `version`). */
  from: number
  /** The `from → to` steps applied, in order. */
  applied: Array<{ from: number; to: number }>
}

/** `true` when `input` carries a numeric `version` (or none, read as 0). */
function versionOf(input: Record<string, unknown>): number {
  const version = input.version
  if (version === undefined) return 0
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new FlowMigrationError('flow document version must be a non-negative integer')
  }
  return version as number
}

/**
 * Migrate an untrusted document to {@link FLOW_DOCUMENT_VERSION}.
 * @throws {FlowMigrationError} for an invalid version, a version newer than this package,
 *   or a missing migration path.
 */
export function migrateFlowDocument(
  input: unknown,
  migrations: readonly FlowMigration[] = FLOW_MIGRATIONS,
  target: number = FLOW_DOCUMENT_VERSION,
): MigrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new FlowMigrationError('flow document must be an object')
  }
  if (!Number.isInteger(target) || target < 0) throw new FlowMigrationError('target version must be a non-negative integer')
  let document = { ...(input as Record<string, unknown>) }
  const from = versionOf(document)
  if (from > target) {
    throw new FlowMigrationError(`flow document version ${from} is newer than the supported ${target}`, from)
  }
  const applied: Array<{ from: number; to: number }> = []
  let version = from
  while (version < target) {
    const migration = migrations.find((candidate) => candidate.from === version)
    if (!migration) throw new FlowMigrationError(`no migration from flow document version ${version}`, version)
    document = { ...migration.migrate(document), version: migration.to }
    applied.push({ from: migration.from, to: migration.to })
    version = migration.to
  }
  return { document: document as unknown as FlowDocument, from, applied }
}
