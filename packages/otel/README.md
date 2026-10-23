# @botmesh/otel

OpenTelemetry for [`@botmesh/core`](../core): a `BotTracer` that turns the bot's spans into OpenTelemetry spans, and a bridge from `bot.metrics()` to OpenTelemetry metrics.

> **Private package** for now (not published to npm). Use it inside the monorepo.

```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

`@opentelemetry/api` is an optional `peerDependency` loaded lazily: if it is missing, `createOtelTracer()` rejects with a message saying what to install.

## Tracing

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Bot } from '@botmesh/core'
import { createOtelTracer, otelMetricsPlugin } from '@botmesh/otel'

const sdk = new NodeSDK({ serviceName: 'mi-bot', traceExporter: new OTLPTraceExporter() })
sdk.start()

const bot = new Bot({
  provider,
  telemetry: { tracer: await createOtelTracer(), idKey: process.env.TRACE_ID_KEY },
})
bot.plug(otelMetricsPlugin())
```

Spans: `bot.inbound` → `bot.persist` / `bot.dispatch` → `bot.handler` → `bot.conversation.turn` → `bot.pace` → `bot.send`, plus `chat {model}`, `execute_tool {name}` and `bot.ai.retrieve` from `@botmesh/ai`. No message bodies or personal data; ids are HMAC-hashed by default.

- `createOtelTracer(opts?)`: loads `@opentelemetry/api` and returns the tracer.
- `otelTracer({ api, ... })`: same, synchronous, with the API injected.
- `lazyOtelTracer(opts?)`: usable immediately (no-op spans until the API loads); a load failure surfaces through `ready`.
- `spanMetrics` (`true` by default): histograms derived from spans (`botwa.inbound.duration`, `botwa.dispatch.duration`, `botwa.queue.wait`, `botwa.send.duration`, `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`), low-cardinality attributes only.

## Metrics

`otelMetricsPlugin(opts?)` (or `registerOtelMetrics(bot, opts?)`) publishes `bot.metrics()` as counters and observable gauges: `botwa.messages.inbound`, `botwa.messages.outbound{result}`, `botwa.dropped{reason}`, `botwa.conversations.started|ended{outcome}|active`, `botwa.flow.conversations.*{flow}`, `botwa.triggered`, `botwa.errors`, `botwa.uptime`, and the `botwa.conversation.duration{flow,outcome}` histogram.

Full guide (Jaeger, Grafana Tempo, sampling, limits): `docs/es/guide/trazas.md` / `docs/guide/tracing.md`.
