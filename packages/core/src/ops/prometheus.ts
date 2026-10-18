/**
 * Prometheus text exposition (format 0.0.4) for a {@link BotMetricsSnapshot}.
 * Dependency-free: serve the string from any HTTP handler with
 * `Content-Type: text/plain; version=0.0.4`.
 */

import type { BotMetricsSnapshot, ConversationCounters } from './metrics.js'

export interface PrometheusOptions {
  /** Metric name prefix (default `'botwa_'`). Must match `[a-zA-Z_:][a-zA-Z0-9_:]*`. */
  prefix?: string
  /** Constant labels added to every sample, e.g. `{ bot: 'ventas' }`. */
  labels?: Record<string, string>
}

/** Content-Type to serve {@link toPrometheus} output with. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

const OUTCOMES: Array<[keyof ConversationCounters, string]> = [
  ['completed', 'completed'],
  ['ended', 'ended'],
  ['guarded', 'guarded'],
  ['cancelled', 'cancelled'],
  ['timedOut', 'timed_out'],
  ['retriesExceeded', 'retries_exceeded'],
  ['errored', 'error'],
]

/**
 * Render `snapshot` as Prometheus text.
 *
 * @example
 * ```ts
 * import { toPrometheus, PROMETHEUS_CONTENT_TYPE } from '@bot-wa/core'
 * http.createServer((req, res) => {
 *   res.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE)
 *   res.end(toPrometheus(bot.metrics(), { labels: { bot: 'ventas' } }))
 * }).listen(9464)
 * ```
 */
export function toPrometheus(snapshot: BotMetricsSnapshot, options: PrometheusOptions = {}): string {
  const prefix = options.prefix ?? 'botwa_'
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(prefix)) throw new TypeError(`Invalid Prometheus metric prefix: "${prefix}"`)
  const constLabels = Object.entries(options.labels ?? {})
  for (const [name] of constLabels) assertLabelName(name)

  const out: string[] = []
  const family = (name: string, type: 'counter' | 'gauge', help: string, samples: Array<[Record<string, string>, number]>) => {
    const full = prefix + name
    out.push(`# HELP ${full} ${help}`, `# TYPE ${full} ${type}`)
    for (const [labels, value] of samples) out.push(`${full}${renderLabels([...constLabels, ...Object.entries(labels)])} ${formatValue(value)}`)
  }

  family('uptime_seconds', 'gauge', 'Seconds since the bot was started.', [[{}, snapshot.uptimeMs / 1000]])
  family('conversations_active', 'gauge', 'Conversations currently alive.', [[{}, snapshot.conversations.active]])
  family('conversations_started_total', 'counter', 'Conversations started.', [[{}, snapshot.conversations.started]])
  family('conversations_ended_total', 'counter', 'Conversations ended, by outcome.',
    OUTCOMES.map(([field, outcome]) => [{ outcome }, snapshot.conversations[field]]))
  family('conversation_duration_avg_seconds', 'gauge', 'Mean duration of ended conversations.',
    [[{}, snapshot.conversations.avgDurationMs / 1000]])

  const flows = Object.entries(snapshot.flows)
  family('flow_started_total', 'counter', 'Conversations started, per flow.', flows.map(([flow, c]) => [{ flow }, c.started]))
  family('flow_ended_total', 'counter', 'Conversations ended, per flow and outcome.',
    flows.flatMap(([flow, c]) => OUTCOMES.map(([field, outcome]): [Record<string, string>, number] => [{ flow, outcome }, c[field]])))
  family('flow_duration_avg_seconds', 'gauge', 'Mean duration of ended conversations, per flow.',
    flows.map(([flow, c]) => [{ flow }, c.avgDurationMs / 1000]))

  family('messages_in_total', 'counter', 'Inbound messages accepted.', [[{}, snapshot.messages.in]])
  family('messages_out_total', 'counter', 'Outbound sends, by result.',
    [[{ result: 'sent' }, snapshot.messages.out], [{ result: 'failed' }, snapshot.messages.outFailed]])
  family('inbound_dropped_total', 'counter', 'Inbound events dropped, by reason.', [
    [{ reason: 'duplicate' }, snapshot.dropped.duplicate],
    [{ reason: 'blocked' }, snapshot.dropped.blocked],
    [{ reason: 'handoff' }, snapshot.dropped.handoff],
  ])
  family('triggers_total', 'counter', 'Conversations started through bot.trigger().', [[{}, snapshot.triggered]])
  family('errors_total', 'counter', 'Errors reported to the bot error channel.', [[{}, snapshot.errors]])
  return out.join('\n') + '\n'
}

function assertLabelName(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name.startsWith('__')) throw new TypeError(`Invalid Prometheus label name: "${name}"`)
}

function renderLabels(labels: Array<[string, string]>): string {
  if (labels.length === 0) return ''
  return `{${labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`
}

function escapeLabelValue(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function formatValue(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return '+Inf'
  if (n === -Infinity) return '-Inf'
  return String(n)
}
