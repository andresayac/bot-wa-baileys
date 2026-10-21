/**
 * Lazy loading of `@opentelemetry/api` (an optional peer dependency): nothing imports it
 * at the top level, so `@botmesh/otel` can be installed without OpenTelemetry and fails
 * with a clear message only when it is actually used.
 */
import type * as OtelApiModule from '@opentelemetry/api'

/** The `@opentelemetry/api` module (inject it with `api` to skip the lazy import). */
export type OtelApi = typeof OtelApiModule

const INSTALL_HINT =
  '@botmesh/otel needs @opentelemetry/api: pnpm add @opentelemetry/api ' +
  '(plus an SDK, e.g. @opentelemetry/sdk-node and an exporter such as @opentelemetry/exporter-trace-otlp-http)'

/** Import `@opentelemetry/api`; rejects with an install hint when it is missing. `load` is a test seam. */
export async function loadOtelApi(load: () => Promise<unknown> = () => import('@opentelemetry/api')): Promise<OtelApi> {
  let mod: unknown
  try {
    mod = await load()
  } catch (error) {
    throw new Error(INSTALL_HINT, { cause: error })
  }
  const api = (mod as { trace?: unknown; default?: unknown })
  const resolved = (api.trace ? api : api.default) as Partial<OtelApi> | undefined
  if (!resolved?.trace || !resolved.context || !resolved.metrics) throw new Error(INSTALL_HINT)
  return resolved as OtelApi
}
