# @bot-wa/otel

OpenTelemetry for [`@bot-wa/core`](../core): a `BotTracer` that turns the bot's spans into OpenTelemetry spans, and a bridge from `bot.metrics()` to OpenTelemetry metrics.

> Paquete **privado** por ahora (no se publica en npm). Úsalo dentro del monorepo.

```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

`@opentelemetry/api` es una `peerDependency` opcional que se carga en diferido: si falta, `createOtelTracer()` rechaza con un mensaje que dice qué instalar.

## Trazas

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Bot } from '@bot-wa/core'
import { createOtelTracer, otelMetricsPlugin } from '@bot-wa/otel'

const sdk = new NodeSDK({ serviceName: 'mi-bot', traceExporter: new OTLPTraceExporter() })
sdk.start()

const bot = new Bot({
  provider,
  telemetry: { tracer: await createOtelTracer(), idKey: process.env.TRACE_ID_KEY },
})
bot.plug(otelMetricsPlugin())
```

Spans: `bot.inbound` → `bot.persist` / `bot.dispatch` → `bot.handler` → `bot.conversation.turn` → `bot.pace` → `bot.send`, más `chat {model}`, `execute_tool {name}` y `bot.ai.retrieve` de `@bot-wa/ai`. Sin cuerpos de mensaje ni datos personales; los ids van con HMAC por defecto.

- `createOtelTracer(opts?)`: carga `@opentelemetry/api` y devuelve el tracer.
- `otelTracer({ api, ... })`: igual, síncrono, con la API inyectada.
- `lazyOtelTracer(opts?)`: usable de inmediato (spans no-op hasta que la API carga); un fallo de carga sale por `ready`.
- `spanMetrics` (por defecto `true`): histogramas derivados de los spans (`botwa.inbound.duration`, `botwa.dispatch.duration`, `botwa.queue.wait`, `botwa.send.duration`, `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`), solo con atributos de baja cardinalidad.

## Métricas

`otelMetricsPlugin(opts?)` (o `registerOtelMetrics(bot, opts?)`) publica `bot.metrics()` como contadores y gauges observables: `botwa.messages.inbound`, `botwa.messages.outbound{result}`, `botwa.dropped{reason}`, `botwa.conversations.started|ended{outcome}|active`, `botwa.flow.conversations.*{flow}`, `botwa.triggered`, `botwa.errors`, `botwa.uptime`, y el histograma `botwa.conversation.duration{flow,outcome}`.

Guía completa (Jaeger, Grafana Tempo, muestreo, límites): `docs/es/guide/trazas.md` / `docs/guide/tracing.md`.
