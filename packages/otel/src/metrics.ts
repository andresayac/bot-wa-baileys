/**
 * Bridge from `bot.metrics()` to OpenTelemetry metrics (pull: no core change). One batch
 * observable callback reads the snapshot once per collection and reports it as
 * cumulative counters and gauges; `conversation:ended` events feed a duration histogram.
 *
 * `bot.resetMetrics()` zeroes the snapshot: the cumulative counters then drop, which
 * OpenTelemetry and Prometheus treat as a counter reset.
 */
import { definePlugin, type BotMetricsSnapshot, type ConversationCounters, type ConversationEndedEvent, type PluginContext, type PluginSpec } from '@botmesh/core'
import type { Attributes, MeterProvider, Observable } from '@opentelemetry/api'

import { loadOtelApi, type OtelApi } from './load.js'

/** Options of {@link registerOtelMetrics} / {@link otelMetricsPlugin}. */
export interface OtelMetricsOptions {
  /** The `@opentelemetry/api` module (inject it to register synchronously). */
  api?: OtelApi
  /** Default: the global one (`api.metrics.getMeterProvider()`, set by the SDK). */
  meterProvider?: MeterProvider
  /** Instrumentation scope name. Default `'@botmesh/otel'`. */
  meterName?: string
  /** Metric name prefix. Default `'botwa'`. */
  prefix?: string
  /** Constant attributes added to every data point (besides `bot.id`). Keep them low-cardinality. */
  attributes?: Record<string, string>
  /** Per-flow conversation counters (`{prefix}.flow.conversations.*`, attribute `flow`). Default `true`. */
  perFlow?: boolean
  /** `{prefix}.conversation.duration` histogram from `conversation:ended`. Default `true`. */
  conversationDuration?: boolean
}

/** The slice of a `Bot` the bridge reads. */
export interface MetricsSource {
  metrics(): BotMetricsSnapshot
  getNamespace(): { readonly botId: string }
  on(event: 'conversation:ended', listener: (event: ConversationEndedEvent) => void): unknown
  off(event: 'conversation:ended', listener: (event: ConversationEndedEvent) => void): unknown
}

/** `ConversationCounters` keys reported as `outcome` (the `metrics()` names). */
const OUTCOMES = ['completed', 'ended', 'guarded', 'cancelled', 'timedOut', 'retriesExceeded', 'errored'] as const satisfies ReadonlyArray<keyof ConversationCounters>

/** Register the bridge on a loaded API (synchronous). Returns the unregister function. */
export function bridgeMetrics(api: OtelApi, bot: MetricsSource, opts: OtelMetricsOptions = {}): () => void {
  const meter = (opts.meterProvider ?? api.metrics.getMeterProvider()).getMeter(opts.meterName ?? '@botmesh/otel')
  const p = opts.prefix ?? 'botwa'
  const base: Attributes = { 'bot.id': bot.getNamespace().botId, ...opts.attributes }
  const perFlow = opts.perFlow !== false

  const inbound = meter.createObservableCounter(`${p}.messages.inbound`, { unit: '{message}', description: 'Inbound messages/interactions accepted (after dedupe and access lists).' })
  const outbound = meter.createObservableCounter(`${p}.messages.outbound`, { unit: '{message}', description: 'Outbound sends, by result (ok | failed).' })
  const dropped = meter.createObservableCounter(`${p}.dropped`, { unit: '{message}', description: 'Inbound dropped, by reason (duplicate | blocked | handoff).' })
  const started = meter.createObservableCounter(`${p}.conversations.started`, { unit: '{conversation}', description: 'Conversations started.' })
  const ended = meter.createObservableCounter(`${p}.conversations.ended`, { unit: '{conversation}', description: 'Conversations ended, by outcome.' })
  const flowStarted = meter.createObservableCounter(`${p}.flow.conversations.started`, { unit: '{conversation}', description: 'Conversations started, by flow.' })
  const flowEnded = meter.createObservableCounter(`${p}.flow.conversations.ended`, { unit: '{conversation}', description: 'Conversations ended, by flow and outcome.' })
  const triggered = meter.createObservableCounter(`${p}.triggered`, { unit: '{conversation}', description: 'bot.trigger() calls that started a conversation.' })
  const errors = meter.createObservableCounter(`${p}.errors`, { unit: '{error}', description: "Errors reported on the bot's 'error' channel." })
  const active = meter.createObservableGauge(`${p}.conversations.active`, { unit: '{conversation}', description: 'Conversations alive right now.' })
  const uptime = meter.createObservableGauge(`${p}.uptime`, { unit: 's', description: 'Seconds since the last start() (0 while stopped).' })
  const observables: Observable[] = [inbound, outbound, dropped, started, ended, flowStarted, flowEnded, triggered, errors, active, uptime]

  const callback = (result: { observe(metric: Observable, value: number, attributes?: Attributes): void }): void => {
    const m = bot.metrics()
    result.observe(inbound, m.messages.in, base)
    result.observe(outbound, m.messages.out, { ...base, result: 'ok' })
    result.observe(outbound, m.messages.outFailed, { ...base, result: 'failed' })
    for (const reason of ['duplicate', 'blocked', 'handoff'] as const) result.observe(dropped, m.dropped[reason], { ...base, reason })
    result.observe(started, m.conversations.started, base)
    for (const outcome of OUTCOMES) result.observe(ended, m.conversations[outcome], { ...base, outcome })
    if (perFlow) {
      for (const [flow, c] of Object.entries(m.flows)) {
        result.observe(flowStarted, c.started, { ...base, flow })
        for (const outcome of OUTCOMES) if (c[outcome] > 0) result.observe(flowEnded, c[outcome], { ...base, flow, outcome })
      }
    }
    result.observe(triggered, m.triggered, base)
    result.observe(errors, m.errors, base)
    result.observe(active, m.conversations.active, base)
    result.observe(uptime, m.uptimeMs / 1000, base)
  }
  meter.addBatchObservableCallback(callback, observables)

  let onEnded: ((e: ConversationEndedEvent) => void) | undefined
  if (opts.conversationDuration !== false) {
    const duration = meter.createHistogram(`${p}.conversation.duration`, { unit: 's', description: 'Conversation duration, by flow and outcome.' })
    onEnded = (e) => { duration.record(Math.max(0, e.durationMs) / 1000, { ...base, flow: e.name, outcome: e.outcome }) }
    bot.on('conversation:ended', onEnded)
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    meter.removeBatchObservableCallback(callback, observables)
    if (onEnded) bot.off('conversation:ended', onEnded)
  }
}

/** Load `@opentelemetry/api` (unless injected) and register the bridge. Resolves with the unregister function. */
export async function registerOtelMetrics(bot: MetricsSource, opts: OtelMetricsOptions = {}): Promise<() => void> {
  const api = opts.api ?? (await loadOtelApi())
  return bridgeMetrics(api, bot, opts)
}

/**
 * The bridge as a plugin: `bot.plug(otelMetricsPlugin())`. `install` stays synchronous —
 * with `api` injected the bridge registers at once, otherwise when `@opentelemetry/api`
 * loads; a missing module is logged as an error (the bot keeps running). Unplugging
 * unregisters the callback and the listener.
 */
export function otelMetricsPlugin(opts: OtelMetricsOptions = {}): PluginSpec {
  return definePlugin({
    name: 'otel-metrics',
    version: '0.1.0',
    description: 'bot.metrics() as OpenTelemetry metrics',
    install(ctx: PluginContext) {
      let dispose: (() => void) | undefined
      let unplugged = false
      ctx.onDispose(() => { unplugged = true; dispose?.() })
      const bot = ctx.bot as unknown as MetricsSource
      if (opts.api) { dispose = bridgeMetrics(opts.api, bot, opts); return }
      void loadOtelApi().then(
        (api) => { if (!unplugged) dispose = bridgeMetrics(api, bot, opts) },
        (err: unknown) => { ctx.logger.error({ err }, 'otel metrics disabled: @opentelemetry/api could not be loaded') },
      )
    },
  })
}
