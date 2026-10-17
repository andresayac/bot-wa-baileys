/**
 * Transcript replay — feed the inbound turns of a golden transcript to a bot
 * built around an in-memory {@link MockProvider} and diff what it sends back
 * against the recorded outbound turns.
 *
 * Replies are grouped by the inbound turn that precedes them ("steps"). After
 * each inbound turn the replay waits until the bot has sent at least as many
 * messages as expected and then stays quiet for `settleMs` (or `stepTimeoutMs`
 * runs out), so missing AND unexpected extra replies are both detected.
 *
 * @example
 * ```ts
 * const golden = parseTranscript(readFileSync('tests/golden/checkout.json', 'utf8'))
 * const result = await replayTranscript(golden, (provider) => createBot(provider))
 * expect(result.diffs).toEqual([])
 * ```
 */

import type { Bot } from '../../core/Bot.js'
import type { IProvider } from '../../core/provider.js'
import { MockProvider } from '../MockProvider.js'
import { createTranscript, isRecord, type JsonValue, type Transcript, type TranscriptInbound, type TranscriptOutbound, type TranscriptTurn } from './format.js'
import { RecordingProvider } from './record.js'

/** Builds the bot under test around the given provider (same shape as `defineBot` factories). Must not start it. */
export type ReplayBotFactory = (provider: IProvider) => Bot | Promise<Bot>

/** A text mask: every match is replaced by `replace` (default `'<*>'`) on both sides before comparing. */
export type ReplayMask = RegExp | { pattern: RegExp; replace?: string }

/** Ready-made masks for volatile values inside replies. */
export const REPLAY_MASKS = {
  /** ISO-8601 dates / date-times. */
  isoDate: /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
  /** Clock times (`09:30`, `9:30:15`). */
  time: /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /** UUIDs. */
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /** Any run of digits. */
  number: /\d+/g,
} as const satisfies Record<string, RegExp>

/** Options for {@link replayTranscript}. */
export interface ReplayOptions {
  /** Quiet period that ends a step once the expected replies arrived (default 30 ms). */
  settleMs?: number
  /** Max time to wait for a step's replies (default 2000 ms). */
  stepTimeoutMs?: number
  /**
   * Reply ordering: `'per-chat'` (default) compares each chat's replies in order
   * but tolerates interleaving between chats; `'strict'` compares the global order.
   */
  order?: 'strict' | 'per-chat'
  /**
   * Timestamp tolerance. `'ignore'` (default) skips timing. `{ toleranceMs }`
   * flags a reply whose delay after its triggering inbound turn differs from the
   * recorded delay by more than `toleranceMs`.
   */
  timestamps?: 'ignore' | { toleranceMs: number }
  /** Compare message ids of outbound turns (default `false`: ids are volatile). */
  compareIds?: boolean
  /**
   * Compare the full `content` when the expected turn has one (default `true`).
   * `false` compares only `kind` + `text`.
   */
  compareContent?: boolean
  /** Dot paths inside `content` to ignore (e.g. `'media'`, `'target.id'`). */
  ignoreContentFields?: string[]
  /** Masks applied to every string on both sides before comparing. */
  masks?: ReplayMask[]
  /** Collapse runs of whitespace and trim (default `true`). */
  normalizeWhitespace?: boolean
  /** Custom text normalizer, applied after masks. */
  normalizeText?: (text: string) => string
  /** Clock for actual `t` offsets (default `Date.now`). */
  now?: () => number
}

/** One difference between the expected and the actual conversation. */
export interface TranscriptDiff {
  kind: 'missing' | 'unexpected' | 'mismatch' | 'timing'
  /** Index of the inbound turn the replies belong to (`-1` = before the first inbound turn). */
  step: number
  /** Text of that inbound turn. */
  trigger?: string
  chatId: string
  /** Position of the reply within its step (and chat, when `order` is `'per-chat'`). */
  position: number
  expected?: TranscriptOutbound
  actual?: TranscriptOutbound
  /** First field that differs (`'kind'`, `'text'`, `'content.buttons.0.text'`, `'t'`, `'id'`). */
  field?: string
  message: string
}

/** Outcome of {@link replayTranscript}. */
export interface ReplayResult {
  ok: boolean
  diffs: TranscriptDiff[]
  expected: Transcript
  /** The conversation the bot actually produced (same inbound turns, actual replies). */
  actual: Transcript
  /** Human-readable diff report (`'✓ transcript matches'` when ok). */
  report(): string
}

/** Thrown by {@link assertTranscript} when a replay does not match. */
export class TranscriptMismatchError extends Error {
  readonly result: ReplayResult
  constructor(result: ReplayResult) {
    super(result.report())
    this.name = 'TranscriptMismatchError'
    this.result = result
  }
}

interface Step {
  index: number
  inbound?: TranscriptInbound
  expected: TranscriptOutbound[]
}

/**
 * Replay `transcript` against the bot returned by `createBot` and diff the
 * replies. The bot is started before the first turn and stopped at the end.
 */
export async function replayTranscript(transcript: Transcript, createBot: ReplayBotFactory, options: ReplayOptions = {}): Promise<ReplayResult> {
  const settleMs = options.settleMs ?? 30
  const stepTimeoutMs = options.stepTimeoutMs ?? 2000
  const mock = new MockProvider()
  const recorder = new RecordingProvider(mock, { now: options.now })
  const bot = await createBot(recorder)

  const steps = toSteps(transcript.turns)
  const actualTurns: TranscriptTurn[] = []
  const diffs: TranscriptDiff[] = []

  try {
    await bot.start()
    let seen = 0
    for (const step of steps) {
      let inboundT: number | undefined
      if (step.inbound) {
        // Late replies to the previous step land in this one (and show up as unexpected).
        const recorded = recorder.size()
        emit(mock, step.inbound)
        const inbound = recorder.snapshot(recorded).find((turn) => turn.dir === 'in')
        inboundT = inbound?.t
      }
      const { outs, end } = await collect(recorder, seen, step.expected.length, settleMs, stepTimeoutMs)
      seen = end
      if (step.inbound) actualTurns.push({ ...step.inbound, ...(inboundT !== undefined ? { t: inboundT } : {}) })
      actualTurns.push(...outs)
      diffs.push(...compareStep(step, outs, inboundT, options))
    }
  } finally {
    await bot.stop().catch(() => undefined)
  }

  const actual = createTranscript(actualTurns, { source: 'replay', ...(transcript.name ? { name: transcript.name } : {}) })
  const result: ReplayResult = {
    ok: diffs.length === 0,
    diffs,
    expected: transcript,
    actual,
    report: () => formatReplayReport(transcript, diffs),
  }
  return result
}

/** {@link replayTranscript}, throwing a {@link TranscriptMismatchError} on any diff. */
export async function assertTranscript(transcript: Transcript, createBot: ReplayBotFactory, options: ReplayOptions = {}): Promise<ReplayResult> {
  const result = await replayTranscript(transcript, createBot, options)
  if (!result.ok) throw new TranscriptMismatchError(result)
  return result
}

/** Render diffs as a readable report. */
export function formatReplayReport(transcript: Transcript, diffs: TranscriptDiff[]): string {
  const title = transcript.name ? `transcript "${transcript.name}"` : 'transcript'
  if (diffs.length === 0) return `✓ ${title} matches`
  const lines = [`✗ ${title}: ${diffs.length} difference(s)`]
  for (const diff of diffs) {
    const where = diff.step < 0 ? 'before first message' : `after #${diff.step} ${JSON.stringify(diff.trigger ?? '')}`
    lines.push(`  [${diff.kind}] ${where} → ${diff.chatId} reply ${diff.position}: ${diff.message}`)
    if (diff.expected) lines.push(`    - expected ${diff.expected.kind}: ${JSON.stringify(diff.expected.text)}`)
    if (diff.actual) lines.push(`    + actual   ${diff.actual.kind}: ${JSON.stringify(diff.actual.text)}`)
  }
  return lines.join('\n')
}

function toSteps(turns: TranscriptTurn[]): Step[] {
  const steps: Step[] = [{ index: -1, expected: [] }]
  let inboundIndex = -1
  turns.forEach((turn) => {
    if (turn.dir === 'in') {
      inboundIndex++
      steps.push({ index: inboundIndex, inbound: turn, expected: [] })
    } else {
      steps[steps.length - 1].expected.push(turn)
    }
  })
  return steps
}

function emit(mock: MockProvider, turn: TranscriptInbound): void {
  const opts = {
    from: turn.chatId,
    sender: turn.senderId,
    isGroup: turn.isGroup ?? false,
    ...(turn.id ? { id: turn.id } : {}),
    ...(turn.displayName ? { pushName: turn.displayName } : {}),
  }
  if (turn.event === 'interaction') mock.interaction(turn.text, opts)
  else mock.incoming(turn.text, { ...opts, type: turn.type as never })
}

async function collect(
  recorder: RecordingProvider,
  from: number,
  expected: number,
  settleMs: number,
  timeoutMs: number,
): Promise<{ outs: TranscriptOutbound[]; end: number }> {
  const outsSince = (): TranscriptOutbound[] =>
    recorder.snapshot(from).filter((turn): turn is TranscriptOutbound => turn.dir === 'out')
  const deadline = Date.now() + timeoutMs
  let count = -1
  let quietSince = Date.now()
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const current = outsSince().length
    if (current !== count) { count = current; quietSince = Date.now() }
    const now = Date.now()
    if (count >= expected && now - quietSince >= settleMs) break
    if (now >= deadline) break
  }
  const end = recorder.size()
  return { outs: recorder.snapshot(from, end).filter((turn): turn is TranscriptOutbound => turn.dir === 'out'), end }
}

function compareStep(step: Step, actual: TranscriptOutbound[], inboundT: number | undefined, options: ReplayOptions): TranscriptDiff[] {
  const groups = options.order === 'strict'
    ? [{ expected: step.expected, actual }]
    : [...new Set([...step.expected, ...actual].map((turn) => turn.chatId))].map((chatId) => ({
        expected: step.expected.filter((turn) => turn.chatId === chatId),
        actual: actual.filter((turn) => turn.chatId === chatId),
      }))

  const diffs: TranscriptDiff[] = []
  const base = { step: step.index, ...(step.inbound ? { trigger: step.inbound.text } : {}) }
  for (const group of groups) {
    const length = Math.max(group.expected.length, group.actual.length)
    for (let position = 0; position < length; position++) {
      const exp = group.expected[position]
      const act = group.actual[position]
      if (exp && !act) {
        diffs.push({ ...base, kind: 'missing', chatId: exp.chatId, position, expected: exp, message: 'expected reply was not sent' })
        continue
      }
      if (act && !exp) {
        diffs.push({ ...base, kind: 'unexpected', chatId: act.chatId, position, actual: act, message: 'bot sent an extra reply' })
        continue
      }
      const mismatch = compareTurn(exp!, act!, options)
      if (mismatch) {
        diffs.push({ ...base, kind: 'mismatch', chatId: exp!.chatId, position, expected: exp, actual: act, field: mismatch.field, message: mismatch.message })
        continue
      }
      const timing = compareTiming(step, exp!, act!, inboundT, options)
      if (timing) diffs.push({ ...base, kind: 'timing', chatId: exp!.chatId, position, expected: exp, actual: act, field: 't', message: timing })
    }
  }
  return diffs
}

function compareTurn(expected: TranscriptOutbound, actual: TranscriptOutbound, options: ReplayOptions): { field: string; message: string } | undefined {
  if (options.order === 'strict' && expected.chatId !== actual.chatId) {
    return { field: 'chatId', message: `chat ${JSON.stringify(expected.chatId)} ≠ ${JSON.stringify(actual.chatId)}` }
  }
  if (expected.kind !== actual.kind) return { field: 'kind', message: `kind ${expected.kind} ≠ ${actual.kind}` }
  const norm = normalizer(options)
  if (norm(expected.text) !== norm(actual.text)) {
    return { field: 'text', message: `text ${JSON.stringify(expected.text)} ≠ ${JSON.stringify(actual.text)}` }
  }
  if (options.compareIds && expected.id !== undefined && expected.id !== actual.id) {
    return { field: 'id', message: `id ${JSON.stringify(expected.id)} ≠ ${JSON.stringify(actual.id)}` }
  }
  if (options.compareContent !== false && expected.content !== undefined && actual.content !== undefined) {
    const ignored = new Set(options.ignoreContentFields ?? [])
    const path = firstDifference(expected.content, actual.content, '', ignored, norm)
    if (path !== undefined) return { field: `content${path ? `.${path}` : ''}`, message: `content differs at ${path || '<root>'}` }
  }
  return undefined
}

function compareTiming(step: Step, expected: TranscriptOutbound, actual: TranscriptOutbound, inboundT: number | undefined, options: ReplayOptions): string | undefined {
  const timestamps = options.timestamps ?? 'ignore'
  if (timestamps === 'ignore') return undefined
  const expectedBase = step.inbound?.t ?? 0
  const actualBase = inboundT ?? 0
  if (expected.t === undefined || actual.t === undefined) return undefined
  const expectedDelay = expected.t - expectedBase
  const actualDelay = actual.t - actualBase
  if (Math.abs(expectedDelay - actualDelay) <= timestamps.toleranceMs) return undefined
  return `reply delay ${actualDelay}ms differs from recorded ${expectedDelay}ms by more than ${timestamps.toleranceMs}ms`
}

function normalizer(options: ReplayOptions): (text: string) => string {
  const masks = (options.masks ?? []).map((mask) => {
    const pattern = mask instanceof RegExp ? mask : mask.pattern
    const replace = mask instanceof RegExp ? '<*>' : mask.replace ?? '<*>'
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    return { pattern: new RegExp(pattern.source, flags), replace }
  })
  return (text) => {
    let out = text
    for (const mask of masks) out = out.replace(mask.pattern, mask.replace)
    if (options.normalizeWhitespace !== false) out = out.replace(/\s+/g, ' ').trim()
    if (options.normalizeText) out = options.normalizeText(out)
    return out
  }
}

function firstDifference(a: JsonValue, b: JsonValue, path: string, ignored: Set<string>, norm: (text: string) => string): string | undefined {
  if (ignored.has(path)) return undefined
  if (typeof a === 'string' && typeof b === 'string') return norm(a) === norm(b) ? undefined : path
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return path
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const child = join(path, String(i))
      if (ignored.has(child)) continue
      if (i >= a.length || i >= b.length) return child
      const diff = firstDifference(a[i], b[i], child, ignored, norm)
      if (diff !== undefined) return diff
    }
    return undefined
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return path
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    for (const key of keys) {
      const child = join(path, key)
      if (ignored.has(child)) continue
      if (!(key in a) || !(key in b)) return child
      const diff = firstDifference(a[key] as JsonValue, b[key] as JsonValue, child, ignored, norm)
      if (diff !== undefined) return diff
    }
    return undefined
  }
  return a === b ? undefined : path
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}
