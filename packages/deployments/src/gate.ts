/**
 * Publish gates for {@link DeploymentRegistry.publish}: a check that must pass
 * before a version becomes active. {@link goldenTranscriptGate} replays golden
 * transcripts against the candidate bot and passes only when every one of them
 * replays without diffs. Every run (pass or fail) is persisted by the registry as a
 * `GateRun`, so its `details` must be JSON-safe (`toJsonValue` makes them so).
 */

import type { JsonValue } from '@botmesh/core'
import {
  replayTranscript,
  type ReplayBotFactory,
  type ReplayOptions,
  type Transcript,
  type TranscriptDiff,
} from '@botmesh/core/testing'

/** The version being published, as the gate sees it. */
export interface DeploymentCandidate {
  tenantId: string
  botId: string
  version: string
  /** Opaque reference to the deployable artifact. */
  artifact: string
}

/** Outcome of a gate. */
export interface GateResult {
  ok: boolean
  /** Why the gate failed (used as the error message). */
  reason?: string
  /** One-line summary kept on the deployment when the gate passes. */
  summary?: string
  /** Gate-specific data (e.g. replay results), exposed on {@link DeploymentGateError.result} and persisted as JSON in the gate run. */
  details?: unknown
}

/** A publish gate. A bare boolean means `{ ok }`. Throwing counts as a failure. */
export type DeploymentGate = (candidate: DeploymentCandidate) => GateResult | boolean | Promise<GateResult | boolean>

/** Rejection of a gated publish: the version was not stored nor activated. */
export class DeploymentGateError extends Error {
  readonly candidate: DeploymentCandidate
  readonly result: GateResult
  /** Id of the persisted gate run (see `DeploymentRegistry.gateRuns`). */
  readonly runId: string | undefined

  constructor(candidate: DeploymentCandidate, result: GateResult, options?: { cause?: unknown; runId?: string }) {
    super(
      `publish gate rejected ${candidate.botId}@${candidate.version}: ${result.reason ?? 'gate failed'}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    )
    this.name = 'DeploymentGateError'
    this.candidate = candidate
    this.result = result
    this.runId = options?.runId
  }
}

/** @internal */
export function normalizeGateResult(value: GateResult | boolean): GateResult {
  if (typeof value === 'boolean') return { ok: value }
  if (typeof value !== 'object' || value === null || typeof value.ok !== 'boolean') {
    return { ok: false, reason: 'gate returned an invalid result' }
  }
  return value
}

/**
 * The JSON projection of any value (`JSON.stringify` → `JSON.parse`): functions, symbols
 * and `undefined` properties are dropped, `toJSON()` is honoured; cycles and bigints
 * make it `undefined`. Used to persist gate `details` without trusting their shape.
 */
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  try {
    const text = JSON.stringify(value)
    return text === undefined ? undefined : (JSON.parse(text) as JsonValue)
  } catch {
    return undefined
  }
}

/** Options for {@link goldenTranscriptGate}. */
export interface GoldenTranscriptGateOptions {
  /** Golden transcripts, or a loader receiving the candidate (e.g. read the files of that version). */
  transcripts: Transcript[] | ((candidate: DeploymentCandidate) => Transcript[] | Promise<Transcript[]>)
  /** Build the candidate's bot factory (`(provider) => Bot`, not started). */
  createBot: (candidate: DeploymentCandidate) => ReplayBotFactory | Promise<ReplayBotFactory>
  /** Tolerances passed to `replayTranscript`. */
  replay?: ReplayOptions
  /**
   * Pass when there is nothing to check (default `false`): no transcripts, or a
   * transcript without inbound turns or without expected replies would otherwise
   * replay as a vacuous pass, so they block the publish.
   */
  allowEmpty?: boolean
}

/** `details` of a {@link goldenTranscriptGate} result (JSON-safe: persisted in the gate run). */
export interface GoldenTranscriptGateDetails {
  results: Array<{ name: string; ok: boolean; diffs: TranscriptDiff[]; report: string }>
}

/**
 * Gate that replays golden transcripts against the candidate bot. Transcripts
 * run one after another, each against a fresh bot; the gate passes only if all
 * of them match.
 *
 * @example
 * ```ts
 * const gate = goldenTranscriptGate({
 *   transcripts: [parseTranscript(readFileSync('golden/checkout.json', 'utf8'))],
 *   createBot: (candidate) => loadFactory(candidate.artifact),
 *   replay: { masks: [REPLAY_MASKS.isoDate] },
 * })
 * await registry.publish('acme', 'support', '1.4.0', 'sha256:...', { gate })
 * ```
 */
export function goldenTranscriptGate(options: GoldenTranscriptGateOptions): DeploymentGate {
  return async (candidate) => {
    const transcripts = typeof options.transcripts === 'function' ? await options.transcripts(candidate) : options.transcripts
    if (transcripts.length === 0) {
      return options.allowEmpty
        ? { ok: true, summary: 'no golden transcripts (allowed)', details: { results: [] } satisfies GoldenTranscriptGateDetails }
        : { ok: false, reason: 'no golden transcripts to replay', details: { results: [] } satisfies GoldenTranscriptGateDetails }
    }

    if (!options.allowEmpty) {
      const vacuous = transcripts
        .map((transcript, index) => ({ transcript, index }))
        .filter(({ transcript }) => !transcript.turns.some((turn) => turn.dir === 'in') || !transcript.turns.some((turn) => turn.dir === 'out'))
      if (vacuous.length > 0) {
        const names = vacuous.map(({ transcript, index }) => transcript.name ?? `#${index}`).join(', ')
        return { ok: false, reason: `golden transcript(s) with nothing to check (no inbound turns or no expected replies): ${names}`, details: { results: [] } satisfies GoldenTranscriptGateDetails }
      }
    }

    const factory = await options.createBot(candidate)
    const results: GoldenTranscriptGateDetails['results'] = []
    for (const [index, transcript] of transcripts.entries()) {
      const result = await replayTranscript(transcript, factory, options.replay)
      results.push({ name: transcript.name ?? `#${index}`, ok: result.ok, diffs: result.diffs, report: result.report() })
    }

    const failed = results.filter((result) => !result.ok)
    const details: GoldenTranscriptGateDetails = { results }
    if (failed.length === 0) return { ok: true, summary: `${results.length}/${results.length} golden transcript(s) passed`, details }
    const reports = failed.map((result) => result.report)
    return { ok: false, reason: `${failed.length}/${results.length} golden transcript(s) failed\n${reports.join('\n')}`, details }
  }
}
