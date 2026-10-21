/**
 * Histograms derived from finished bot spans (`spanMetrics`): latency of inbound events,
 * dispatches, queue waits, sends and model calls, plus model token usage — the metrics a
 * dashboard needs even when traces are sampled.
 *
 * Only low-cardinality attributes are copied (kinds, stages, outcomes, provider and
 * model names). Chat, user and message ids never reach a metric.
 */
import { SPAN_NAMES, TRACE_ATTR, type TraceAttributeValue } from '@bot-wa/core'
import type { Attributes, Histogram, MeterProvider } from '@opentelemetry/api'

/** Span attributes {@link SpanMetrics} reads (everything else is ignored). */
export const METRIC_SOURCE_KEYS: ReadonlySet<string> = new Set<string>([
  TRACE_ATTR.eventKind, TRACE_ATTR.inboundOutcome, TRACE_ATTR.providerId, TRACE_ATTR.dispatchStage,
  TRACE_ATTR.queueWaitMs, TRACE_ATTR.sendOutcome, TRACE_ATTR.sendEdit, TRACE_ATTR.errorType,
  TRACE_ATTR.genAiOperation, TRACE_ATTR.genAiProvider, TRACE_ATTR.genAiRequestModel,
  TRACE_ATTR.genAiInputTokens, TRACE_ATTR.genAiOutputTokens,
  TRACE_ATTR.lifecycleStep, TRACE_ATTR.lifecyclePhase,
])

type Picked = Map<string, TraceAttributeValue>

function pick(attrs: Picked, keys: readonly string[]): Attributes {
  const out: Attributes = {}
  for (const k of keys) {
    const v = attrs.get(k)
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

export class SpanMetrics {
  private readonly inbound: Histogram
  private readonly dispatch: Histogram
  private readonly queueWait: Histogram
  private readonly send: Histogram
  private readonly lifecycle: Histogram
  private readonly genAiDuration: Histogram
  private readonly genAiTokens: Histogram

  constructor(meterProvider: MeterProvider, meterName: string, prefix: string) {
    const meter = meterProvider.getMeter(meterName)
    this.inbound = meter.createHistogram(`${prefix}.inbound.duration`, {
      unit: 's', description: 'Time to handle one inbound event (access lists, persistence, dispatch).',
    })
    this.dispatch = meter.createHistogram(`${prefix}.dispatch.duration`, {
      unit: 's', description: 'Time to route one message once its turn in the chat queue came.',
    })
    this.queueWait = meter.createHistogram(`${prefix}.queue.wait`, {
      unit: 's', description: "Time a message waited for its chat's FIFO turn (cross-replica turn included).",
    })
    this.send = meter.createHistogram(`${prefix}.send.duration`, {
      unit: 's', description: 'Time of one outbound send or edit (hooks, provider call, ledger).',
    })
    this.lifecycle = meter.createHistogram(`${prefix}.lifecycle.duration`, {
      unit: 's', description: 'Time of one lifecycle step (store, coordination, restore, durability, transport, jobs).',
    })
    this.genAiDuration = meter.createHistogram('gen_ai.client.operation.duration', {
      unit: 's', description: 'GenAI operation duration.',
    })
    this.genAiTokens = meter.createHistogram('gen_ai.client.token.usage', {
      unit: '{token}', description: 'Measures number of input and output tokens used.',
    })
  }

  /** A bot span ended after `durationMs`, with the {@link METRIC_SOURCE_KEYS} it carried. */
  record(name: string, durationMs: number, attrs: Picked): void {
    const seconds = Math.max(0, durationMs) / 1000
    if (name === SPAN_NAMES.inbound) {
      this.inbound.record(seconds, pick(attrs, [TRACE_ATTR.eventKind, TRACE_ATTR.inboundOutcome, TRACE_ATTR.providerId]))
    } else if (name === SPAN_NAMES.dispatch) {
      this.dispatch.record(seconds, pick(attrs, [TRACE_ATTR.dispatchStage, TRACE_ATTR.errorType]))
      const wait = attrs.get(TRACE_ATTR.queueWaitMs)
      if (typeof wait === 'number') this.queueWait.record(Math.max(0, wait) / 1000)
    } else if (name === SPAN_NAMES.send) {
      this.send.record(seconds, pick(attrs, [TRACE_ATTR.providerId, TRACE_ATTR.sendOutcome, TRACE_ATTR.sendEdit, TRACE_ATTR.errorType]))
    } else if (name === SPAN_NAMES.lifecycle) {
      this.lifecycle.record(seconds, pick(attrs, [TRACE_ATTR.lifecycleStep, TRACE_ATTR.lifecyclePhase, TRACE_ATTR.providerId, TRACE_ATTR.errorType]))
    } else if (attrs.get(TRACE_ATTR.genAiOperation) === 'chat') {
      const base = pick(attrs, [TRACE_ATTR.genAiOperation, TRACE_ATTR.genAiProvider, TRACE_ATTR.genAiRequestModel])
      this.genAiDuration.record(seconds, { ...base, ...pick(attrs, [TRACE_ATTR.errorType]) })
      const input = attrs.get(TRACE_ATTR.genAiInputTokens)
      const output = attrs.get(TRACE_ATTR.genAiOutputTokens)
      if (typeof input === 'number') this.genAiTokens.record(input, { ...base, 'gen_ai.token.type': 'input' })
      if (typeof output === 'number') this.genAiTokens.record(output, { ...base, 'gen_ai.token.type': 'output' })
    }
  }
}
