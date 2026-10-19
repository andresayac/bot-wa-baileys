/**
 * @bot-wa/otel — OpenTelemetry for @bot-wa/core.
 *
 * - {@link createOtelTracer} / {@link otelTracer} / {@link lazyOtelTracer}: a `BotTracer`
 *   for `new Bot({ telemetry: { tracer } })` that turns the bot's spans (inbound,
 *   dispatch, handlers, conversation turns, sends, `@bot-wa/ai` model and tool calls)
 *   into OpenTelemetry spans, plus latency/token histograms derived from them.
 * - {@link otelMetricsPlugin} / {@link registerOtelMetrics}: `bot.metrics()` as
 *   OpenTelemetry counters and gauges.
 *
 * `@opentelemetry/api` is an optional peer dependency loaded lazily: install it (and an
 * SDK) in the application. See the "Tracing" guide.
 */
export { createOtelTracer, otelTracer, lazyOtelTracer } from './tracer.js'
export type { OtelTracingOptions, LazyOtelTracer } from './tracer.js'
export { otelMetricsPlugin, registerOtelMetrics, bridgeMetrics } from './metrics.js'
export type { OtelMetricsOptions, MetricsSource } from './metrics.js'
export { loadOtelApi } from './load.js'
export type { OtelApi } from './load.js'
export { SpanMetrics, METRIC_SOURCE_KEYS } from './spanMetrics.js'
