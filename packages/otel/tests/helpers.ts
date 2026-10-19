import * as api from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { MeterProvider, MetricReader, type DataPoint, type MetricData } from '@opentelemetry/sdk-metrics'

export { api }

/** An OTel tracer provider exporting to memory, with the AsyncLocalStorage context manager enabled. */
export function memoryTracing() {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const contextManager = new AsyncLocalStorageContextManager().enable()
  api.context.setGlobalContextManager(contextManager)
  const spans = (): ReadableSpan[] => exporter.getFinishedSpans()
  const byName = (name: string): ReadableSpan | undefined => spans().find((s) => s.name === name)
  const parentOf = (s: ReadableSpan): ReadableSpan | undefined => spans().find((p) => p.spanContext().spanId === s.parentSpanContext?.spanId)
  const close = async (): Promise<void> => {
    await provider.shutdown()
    api.context.disable()
  }
  return { exporter, provider, spans, byName, parentOf, close }
}

/** A pull reader for tests: `collect()` on demand. */
class TestReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

export function memoryMetrics() {
  const reader = new TestReader()
  const meterProvider = new MeterProvider({ readers: [reader] })
  const collect = async (): Promise<MetricData[]> => {
    const { resourceMetrics } = await reader.collect()
    return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics)
  }
  /** Data points of metric `name` (empty when absent). */
  const points = async (name: string): Promise<Array<DataPoint<unknown>>> =>
    ((await collect()).find((m) => m.descriptor.name === name)?.dataPoints ?? []) as Array<DataPoint<unknown>>
  return { reader, meterProvider, collect, points }
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
