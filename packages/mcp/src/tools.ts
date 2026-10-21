/**
 * The MCP tool catalogue. Every tool is a pure function of its arguments — no network, no
 * bot, no `eval` — so an agent can validate, compile, inspect, migrate and diff code-free
 * JSON flow documents, and (only when a docs directory is configured) search the guides.
 *
 * Error convention: a document that fails validation is a **successful** call whose payload
 * says `valid: false` with the issues; `isError` marks a bad request (missing/invalid
 * arguments, an unmigratable version, a path outside the docs root), never "your flow is
 * wrong".
 */
import { describeFlows, lintFlows } from '@botmesh/core'
import {
  FLOW_DOCUMENT_LIMITS,
  FLOW_DOCUMENT_SCHEMA,
  FLOW_DOCUMENT_VERSION,
  FlowDocumentError,
  FlowMigrationError,
  compileFlowDocument,
  diffFlowDocuments,
  flowDigest,
  flowVersionOf,
  migrateFlowDocument,
  validateFlowDocument,
  type FlowDocument,
  type FlowDocumentIssue,
} from '@botmesh/flow-schema'

import { readDocPage, searchDocs } from './docs.js'

/** What a tool returns: text for the model, plus whether the *request* failed. */
export interface ToolOutput {
  text: string
  isError?: boolean
}

/** Ambient configuration of the tool set. */
export interface ToolContext {
  /** Absolute or relative docs tree; the docs tools exist only when this is set. */
  docsDir?: string
}

/** One tool, in the shape `tools/list` expects. */
export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> | ToolOutput
}

const DIRECTIONS = ['TD', 'TB', 'BT', 'LR', 'RL'] as const
type Direction = (typeof DIRECTIONS)[number]

/** A bad request (as opposed to an invalid flow document). */
class ToolInputError extends Error {}

const json = (value: unknown): string => JSON.stringify(value, null, 2)

const DOCUMENT_PROPERTY: Record<string, unknown> = {
  type: 'object',
  description: 'The flow document (JSON). It is validated against the versioned schema.',
  additionalProperties: true,
}

const DOCUMENT_ARGUMENT: Record<string, unknown> = {
  type: 'object',
  properties: { document: DOCUMENT_PROPERTY },
  required: ['document'],
  additionalProperties: false,
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function requireDocument(args: Record<string, unknown>, key = 'document'): unknown {
  const document = args[key]
  if (record(document) === undefined) throw new ToolInputError(`"${key}" must be a flow document object`)
  return document
}

function optionalSubflows(args: Record<string, unknown>): ((id: string) => FlowDocument | undefined) | undefined {
  const subflows = record(args.subflows)
  if (!subflows) return undefined
  return (id: string) => {
    const found = record(subflows[id])
    return found === undefined ? undefined : (found as unknown as FlowDocument)
  }
}

/** A short, stable description of a valid document. */
function summarize(document: FlowDocument): Record<string, unknown> {
  const kinds: Record<string, number> = {}
  for (const step of document.steps) kinds[step.kind] = (kinds[step.kind] ?? 0) + 1
  return {
    id: document.id,
    version: document.version,
    ...(document.name !== undefined ? { name: document.name } : {}),
    trigger: document.trigger,
    steps: document.steps.length,
    kinds,
    ...(document.timeout !== undefined ? { timeout: document.timeout } : {}),
    persistent: document.persistent === true,
  }
}

/** Step kinds declared by the schema itself, so the list can never drift from the validator. */
export function stepKindsOf(schema: unknown = FLOW_DOCUMENT_SCHEMA): string[] {
  const root = record(schema)
  const defs = record(root?.$defs)
  const step = record(defs?.step)
  const variants = Array.isArray(step?.oneOf) ? (step.oneOf as unknown[]) : []
  const kinds: string[] = []
  for (const variant of variants) {
    const ref = record(variant)?.$ref
    if (typeof ref !== 'string') continue
    const name = ref.slice(ref.lastIndexOf('/') + 1)
    if (name !== '') kinds.push(name)
  }
  return kinds
}

/**
 * A document that validates and lints clean, exercising say/ask/choose/condition/delay/media.
 * Kept in sync with the schema by the tests (it must always validate).
 */
export const EXAMPLE_FLOW_DOCUMENT = Object.freeze({
  version: 1,
  id: 'pedido',
  name: 'Tomar un pedido',
  description: 'Ejemplo canónico: pregunta, menú, condición, media y cierre.',
  trigger: ['pedido', 'menu'],
  timeout: '30m',
  steps: [
    { kind: 'say', text: '¡Hola! Vamos con tu pedido.' },
    { kind: 'ask', text: '¿Cómo te llamas?', stateKey: 'name', timeout: '60s' },
    {
      kind: 'choose',
      text: '¿Qué tamaño quieres, {{name}}?',
      stateKey: 'size',
      timeout: '60s',
      options: [
        { key: 's', label: 'Pequeño' },
        { key: 'l', label: 'Grande', steps: [{ kind: 'say', text: '¡Buena elección!' }] },
      ],
    },
    {
      kind: 'condition',
      if: "size == 'l'",
      then: [{ kind: 'say', text: 'Te cobramos el grande.' }],
      else: [{ kind: 'say', text: 'Te cobramos el pequeño.' }],
    },
    { kind: 'delay', duration: '1s' },
    { kind: 'media', type: 'image', source: { url: 'https://example.com/menu.png' }, caption: 'Menú del día' },
    { kind: 'say', text: 'Listo, {{name}}. Te avisamos cuando esté.' },
  ],
} satisfies FlowDocument)

const flowValidate: ToolDefinition = {
  name: 'flow_validate',
  title: 'Validate a BotWA flow document',
  description:
    'Validate a code-free JSON flow document against the versioned schema (draft 2020-12) and return every issue with its JSON Pointer path. '
    + 'A document that fails validation is NOT an error: the result carries "valid": false and the issues. '
    + 'Run this before compiling or publishing a flow. BotWA v2 only: the v1 API (.addAnswer, .addAction, { capture: true }, createBot/createFlow) does not exist.',
  inputSchema: DOCUMENT_ARGUMENT,
  handler(args) {
    const document = requireDocument(args)
    const issues = validateFlowDocument(document)
    const valid = issues.length === 0
    return { text: json({ valid, issues, ...(valid ? { summary: summarize(document as FlowDocument) } : {}) }) }
  },
}

const flowAnalyze: ToolDefinition = {
  name: 'flow_analyze',
  title: 'Compile, describe and lint a flow document',
  description:
    'One call, three answers: validates the document, then (when valid) compiles it to a CompiledFlow, renders the flow graph as Mermaid (or as JSON with format: "json") '
    + 'and returns the static lint diagnostics of the compiled flow (goto targets, unreachable steps, empty or duplicate choices, missing or non-expiring waits, form state collisions). '
    + 'Pass `subflows` (id → document) when the document uses a `subflow` step.',
  inputSchema: {
    type: 'object',
    properties: {
      document: DOCUMENT_PROPERTY,
      subflows: {
        type: 'object',
        description: 'Documents resolvable by a `subflow` step, keyed by flow id.',
        additionalProperties: true,
      },
      format: { enum: ['mermaid', 'json'], description: 'Graph format (default "mermaid").' },
      direction: { enum: [...DIRECTIONS], description: 'Mermaid layout direction (default "TD").' },
    },
    required: ['document'],
    additionalProperties: false,
  },
  handler(args) {
    const document = requireDocument(args)
    const issues = validateFlowDocument(document)
    if (issues.length) return { text: json({ valid: false, issues }) }
    const resolveSubflow = optionalSubflows(args)
    let compiled: ReturnType<typeof compileFlowDocument>
    try {
      compiled = compileFlowDocument(document, resolveSubflow ? { resolveSubflow } : {})
    } catch (error) {
      if (error instanceof FlowDocumentError) return { text: json({ valid: false, issues: error.issues }) }
      throw error
    }
    const format = args.format === 'json' ? 'json' : 'mermaid'
    const direction = DIRECTIONS.includes(args.direction as Direction) ? (args.direction as Direction) : undefined
    const graph = format === 'json'
      ? describeFlows([compiled], { format: 'json' })
      : describeFlows([compiled], direction ? { direction } : {})
    const diagnostics = lintFlows([compiled])
    return {
      text: json({
        valid: true,
        summary: summarize(document as FlowDocument),
        diagnostics,
        ...(format === 'json' ? { graph } : { mermaid: graph }),
      }),
    }
  },
}

const flowMigrate: ToolDefinition = {
  name: 'flow_migrate',
  title: 'Migrate a flow document to the current schema version',
  description:
    'Chain the known migrations (a document without `version` is read as 0) and return the upgraded document plus the applied steps. '
    + 'The result is still unvalidated: pass it to flow_validate. A version newer than this package, or a missing migration path, is an error.',
  inputSchema: {
    type: 'object',
    properties: {
      document: DOCUMENT_PROPERTY,
      target: { type: 'integer', minimum: 0, maximum: 1_000, description: `Target version (default ${FLOW_DOCUMENT_VERSION}).` },
    },
    required: ['document'],
    additionalProperties: false,
  },
  handler(args) {
    const document = requireDocument(args)
    const target = args.target === undefined ? undefined : args.target
    if (target !== undefined && (typeof target !== 'number' || !Number.isInteger(target) || target < 0)) {
      throw new ToolInputError('"target" must be a non-negative integer')
    }
    try {
      const migrated = migrateFlowDocument(document, undefined, target)
      return {
        text: json({
          document: migrated.document,
          from: migrated.from,
          to: migrated.document.version,
          applied: migrated.applied,
          issues: validateFlowDocument(migrated.document),
        }),
      }
    } catch (error) {
      if (error instanceof FlowMigrationError) return { text: error.message, isError: true }
      throw error
    }
  },
}

const flowDiff: ToolDefinition = {
  name: 'flow_diff',
  title: 'Diff two versions of a flow document',
  description:
    'Structural diff of two valid documents: changed metadata fields, added/removed step indexes, the changes of every step present in both, and the digest of each side. '
    + 'Use it to review what a deploy would change.',
  inputSchema: {
    type: 'object',
    properties: {
      left: { ...DOCUMENT_PROPERTY, description: 'The current (published) document.' },
      right: { ...DOCUMENT_PROPERTY, description: 'The candidate document.' },
    },
    required: ['left', 'right'],
    additionalProperties: false,
  },
  handler(args) {
    const left = requireDocument(args, 'left')
    const right = requireDocument(args, 'right')
    const issues = [...validateFlowDocument(left), ...validateFlowDocument(right)]
    if (issues.length) return { text: json({ valid: false, issues }) }
    const diff = diffFlowDocuments(left as FlowDocument, right as FlowDocument)
    return {
      text: json({
        valid: true,
        ...diff,
        before: flowDigest(left as FlowDocument),
        after: flowDigest(right as FlowDocument),
      }),
    }
  },
}

const flowDigestTool: ToolDefinition = {
  name: 'flow_digest',
  title: 'Digest of a flow document',
  description:
    'Content digest (sha256 over canonical JSON: key order and formatting never change it) and the stable version label used by publishFlow. '
    + 'Two documents with the same digest are the same flow.',
  inputSchema: DOCUMENT_ARGUMENT,
  handler(args) {
    const document = requireDocument(args)
    const issues = validateFlowDocument(document)
    if (issues.length) return { text: json({ valid: false, issues }) }
    const flow = document as FlowDocument
    return { text: json({ valid: true, digest: flowDigest(flow), version: flowVersionOf(flow) }) }
  },
}

const flowSchema: ToolDefinition = {
  name: 'flow_schema',
  title: 'The flow document JSON Schema',
  description:
    'Return the JSON Schema (draft 2020-12) of a flow document, the structural limits and the step kinds it accepts. '
    + 'Use it to build or repair a document; the descriptions of each property carry the grammar of texts ({{ path }} placeholders) and of safe expressions.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler() {
    return {
      text: json({
        version: FLOW_DOCUMENT_VERSION,
        stepKinds: stepKindsOf(),
        limits: FLOW_DOCUMENT_LIMITS,
        schema: FLOW_DOCUMENT_SCHEMA,
      }),
    }
  },
}

const flowExample: ToolDefinition = {
  name: 'flow_example',
  title: 'A canonical flow document',
  description:
    'A minimal but complete document (say, ask, choose with a nested branch, condition, delay, media, templated closing text) that validates and lints clean. '
    + 'Start from it instead of inventing the format.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler() {
    return { text: json({ document: EXAMPLE_FLOW_DOCUMENT, issues: validateFlowDocument(EXAMPLE_FLOW_DOCUMENT) }) }
  },
}

function docsTools(docsDir: string): ToolDefinition[] {
  return [
    {
      name: 'docs_search',
      title: 'Search the BotWA documentation',
      description:
        'Search the documentation of this checkout and return the best matching sections with their path, heading and a snippet. '
        + 'Bilingual: the English guides live under guide/ and the Spanish ones under es/guide/.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Words to look for (accent and case insensitive).' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum hits (default 8).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async handler(args) {
        const query = args.query
        if (typeof query !== 'string' || query.trim() === '') throw new ToolInputError('"query" must be a non-empty string')
        const limit = typeof args.limit === 'number' ? args.limit : 8
        const hits = await searchDocs(docsDir, query, limit)
        return { text: json({ query, count: hits.length, hits }) }
      },
    },
    {
      name: 'docs_page',
      title: 'Read a documentation page',
      description: 'Return the markdown of one page, by its path relative to the docs directory (e.g. "guide/flows.md").',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'Path relative to the docs directory; must end in .md.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async handler(args) {
        const path = args.path
        if (typeof path !== 'string' || path.trim() === '') throw new ToolInputError('"path" must be a non-empty string')
        try {
          const page = await readDocPage(docsDir, path)
          return { text: json(page) }
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error), isError: true }
        }
      },
    },
  ]
}

/**
 * Build the tool list. The docs tools only exist when a docs directory is configured, so
 * `tools/list` never advertises a tool that cannot work.
 */
export function createTools(context: ToolContext = {}): ToolDefinition[] {
  const tools = [flowValidate, flowAnalyze, flowMigrate, flowDiff, flowDigestTool, flowSchema, flowExample]
  return context.docsDir ? [...tools, ...docsTools(context.docsDir)] : tools
}

/** `validateFlowDocument` for callers that need it, re-exported to keep the tool API in one place. */
export { validateFlowDocument, type FlowDocumentIssue }
