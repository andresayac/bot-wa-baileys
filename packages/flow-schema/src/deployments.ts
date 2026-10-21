/**
 * Pure draft/publish helpers for `@bot-wa/deployments`: a stable digest of a document
 * (the deployment artifact), a structural diff between two drafts and a gate that
 * validates + compiles the candidate before it is activated.
 */

import { createHash } from 'node:crypto'
import { DeploymentRegistry, type Deployment, type DeploymentCandidate, type DeploymentGate, type GateResult } from '@bot-wa/deployments'
import { compileFlowDocument } from './compile.js'
import { FlowDocumentError, validateFlowDocument, type FlowDocument, type FlowDocumentIssue } from './schema.js'

/** Canonical JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** `sha256:<hex>` of the canonical document: stable across key order, usable as an artifact. */
export function flowDigest(document: FlowDocument): string {
  return `sha256:${createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex')}`
}

/** A stable version label for `publishFlow` when none is given. */
export function flowVersionOf(document: FlowDocument): string {
  return `flow-${flowDigest(document).slice('sha256:'.length, 'sha256:'.length + 16)}`
}

/** The deployment artifact of a document: its JSON (validated first). */
export function flowArtifact(document: FlowDocument): string {
  const issues = validateFlowDocument(document)
  if (issues.length) throw new FlowDocumentError(issues)
  return JSON.stringify(document)
}

/** Parse and validate an artifact produced by {@link flowArtifact}. */
export function flowFromArtifact(artifact: string): FlowDocument {
  let parsed: unknown
  try { parsed = JSON.parse(artifact) } catch (error) {
    throw new FlowDocumentError([{ path: '', message: `artifact is not JSON: ${(error as Error).message}` }])
  }
  const issues = validateFlowDocument(parsed)
  if (issues.length) throw new FlowDocumentError(issues)
  return parsed as FlowDocument
}

/** One difference of a {@link diffFlowDocuments} result. */
export interface FlowDifference {
  /** JSON-pointer-like path (`/steps/2/text`). */
  path: string
  before?: unknown
  after?: unknown
}

/** Structural diff of two flow documents. */
export interface FlowDocumentDiff {
  /** `true` when anything differs. */
  changed: boolean
  /** Top-level fields that differ (`trigger`, `timeout`, `persistent`, `name`, `description`). */
  metadata: string[]
  /** Step indexes present only in `after`. */
  added: number[]
  /** Step indexes present only in `before`. */
  removed: number[]
  /** Per-index differences of the steps present in both. */
  changedSteps: Array<{ index: number; changes: FlowDifference[] }>
  /** Every difference, metadata first. */
  differences: FlowDifference[]
}

/** Compare two documents structurally (key order is irrelevant). */
export function diffFlowDocuments(before: FlowDocument, after: FlowDocument): FlowDocumentDiff {
  const differences: FlowDifference[] = []
  const metadata: string[] = []
  for (const key of ['id', 'name', 'description', 'trigger', 'timeout', 'persistent'] as const) {
    if (canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null)) {
      metadata.push(key)
      differences.push({ path: `/${key}`, before: before[key], after: after[key] })
    }
  }
  const added: number[] = []
  const removed: number[] = []
  const changedSteps: Array<{ index: number; changes: FlowDifference[] }> = []
  const count = Math.max(before.steps.length, after.steps.length)
  for (let index = 0; index < count; index++) {
    const a = before.steps[index]
    const b = after.steps[index]
    if (!a) { added.push(index); differences.push({ path: `/steps/${index}`, after: b }); continue }
    if (!b) { removed.push(index); differences.push({ path: `/steps/${index}`, before: a }); continue }
    if (canonicalJson(a) === canonicalJson(b)) continue
    const changes = diffPaths(a, b, `/steps/${index}`)
    changedSteps.push({ index, changes })
    differences.push(...changes)
  }
  return {
    changed: differences.length > 0,
    metadata,
    added,
    removed,
    changedSteps,
    differences: differences.slice(0, 200),
  }
}

function diffPaths(before: unknown, after: unknown, path: string): FlowDifference[] {
  if (canonicalJson(before) === canonicalJson(after)) return []
  if (typeof before !== 'object' || before === null || typeof after !== 'object' || after === null || Array.isArray(before) !== Array.isArray(after)) {
    return [{ path, before, after }]
  }
  const out: FlowDifference[] = []
  if (Array.isArray(before) && Array.isArray(after)) {
    const count = Math.max(before.length, after.length)
    for (let i = 0; i < count; i++) out.push(...diffPaths(before[i], after[i], `${path}/${i}`))
    return out
  }
  const a = before as Record<string, unknown>
  const b = after as Record<string, unknown>
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    out.push(...diffPaths(a[key], b[key], `${path}/${key}`))
  }
  return out
}

/** `true` when two documents are structurally identical. */
export function sameFlow(a: FlowDocument, b: FlowDocument): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** The problems of a document as gate details. */
export function flowIssuesOf(value: unknown): FlowDocumentIssue[] {
  return validateFlowDocument(value)
}

/**
 * A `DeploymentGate` that parses the candidate artifact, validates it and compiles it.
 * A valid document passes with a summary (step count); an invalid one fails with its
 * issues in `details` and the first message in `reason`.
 */
export function flowDocumentGate(options: { resolveSubflow?: (flowId: string) => FlowDocument | undefined } = {}): (candidate: DeploymentCandidate) => GateResult {
  return ({ artifact }): GateResult => {
    let document: FlowDocument
    try {
      document = flowFromArtifact(artifact)
    } catch (error) {
      const issues = error instanceof FlowDocumentError ? error.issues : [{ path: '', message: (error as Error).message }]
      return { ok: false, reason: issues[0]?.message ?? 'invalid flow document', details: { issues } }
    }
    try {
      compileFlowDocument(document, options)
    } catch (error) {
      const issues = error instanceof FlowDocumentError ? error.issues : [{ path: '', message: (error as Error).message }]
      return { ok: false, reason: issues[0]?.message ?? 'flow does not compile', details: { issues } }
    }
    return { ok: true, summary: `flow "${document.id}" has ${document.steps.length} step(s)` }
  }
}

/** Options of {@link publishFlow}. */
export interface PublishFlowOptions {
  /** Version label (default {@link flowVersionOf}). */
  version?: string
  /** Extra gate run after the document check (e.g. golden transcripts). */
  gate?: DeploymentGate
  /** Subflow resolver passed to the compiler. */
  resolveSubflow?: (flowId: string) => FlowDocument | undefined
}

/**
 * Publish a flow document through a {@link DeploymentRegistry}. The artifact is the
 * document JSON; the gate validates and compiles it (then runs `options.gate`, if any).
 * Publishing the same content twice with the default version is refused by the registry
 * (`DeploymentExistsError`), which is what makes it idempotent per draft.
 */
export async function publishFlow(
  registry: DeploymentRegistry,
  tenantId: string,
  botId: string,
  document: FlowDocument,
  options: PublishFlowOptions = {},
): Promise<Deployment> {
  const artifact = flowArtifact(document)
  const compileOptions = options.resolveSubflow ? { resolveSubflow: options.resolveSubflow } : {}
  const documentGate = flowDocumentGate(compileOptions)
  const gate: DeploymentGate = options.gate
    ? async (candidate) => {
        const first = documentGate(candidate)
        if (!first.ok) return first
        return options.gate!(candidate)
      }
    : documentGate
  return registry.publish(tenantId, botId, options.version ?? flowVersionOf(document), artifact, { gate })
}
