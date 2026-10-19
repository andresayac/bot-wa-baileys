# Tracing (OpenTelemetry)

A bot does a lot of work for each message: access lists, persistence, the chat's queue, hooks, routing, a conversation step, an AI call with tools, the provider's send. Tracing shows that work as a tree of **spans** per message, so you can see where the time goes and where things fail, in Jaeger, Grafana Tempo or any OpenTelemetry backend.

Tracing is **opt-in**. Without `BotConfig.telemetry` the bot runs exactly the code it ran before: no spans, no extra awaits.

- `@bot-wa/core` has the tracing hooks: a minimal `BotTracer` interface, a no-op default and `bot.tracing`. No new dependency.
- `@bot-wa/otel` (private for now) adapts them to OpenTelemetry and also turns `bot.metrics()` into OpenTelemetry metrics.
- `@bot-wa/ai` adds model, tool and retrieval spans to the same trace.

::: tip No message content
Spans carry **kinds, stages, outcomes and ids**, never message bodies, captions, prompts, completions, tool arguments or results, `c.state` or error messages. Chat, user and message ids are hashed by default. See [Personal data](#personal-data).
:::

## Quick start

```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/sdk-metrics
```

```ts
// telemetry.ts — load it before the bot (e.g. `node --import ./telemetry.js bot.js`)
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

export const sdk = new NodeSDK({
  serviceName: 'sales-bot',
  traceExporter: new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: 'http://localhost:4318/v1/metrics' }),
  }),
})
sdk.start()
```

```ts
// bot.ts
import { Bot } from '@bot-wa/core'
import { createOtelTracer, otelMetricsPlugin } from '@bot-wa/otel'

const bot = new Bot({
  provider,
  telemetry: {
    tracer: await createOtelTracer(),
    // Same key on every replica so hashed ids correlate across processes and restarts.
    idKey: process.env.TRACE_ID_KEY,
  },
})
bot.plug(otelMetricsPlugin())   // bot.metrics() as OpenTelemetry metrics
bot.plug(aiPlugin({ /* … */ })) // AI spans join the same trace automatically

process.on('SIGTERM', async () => {
  await bot.stop()
  await sdk.shutdown()          // flushes the spans and metrics still buffered
})
```

`createOtelTracer()` loads `@opentelemetry/api` lazily and rejects with an install hint when it is missing. When the bot must be built synchronously, use `lazyOtelTracer()`: its spans are no-ops until the API is loaded, and a load failure is reported through its `ready` promise (never thrown into the bot).

## Local backends

### Jaeger

```bash
docker run --rm --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest
```

Point the exporters at `http://localhost:4318` and open `http://localhost:16686`. Jaeger stores traces only: send the metrics to a Prometheus or an OpenTelemetry Collector, or drop the metric reader while you try it.

### Grafana Tempo + Grafana

`docker-compose.yml`:

```yaml
services:
  tempo:
    image: grafana/tempo:latest
    command: ['-config.file=/etc/tempo.yaml']
    volumes: ['./tempo.yaml:/etc/tempo.yaml']
    ports: ['4318:4318', '3200:3200']
  grafana:
    image: grafana/grafana:latest
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: 'true'
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
    volumes: ['./grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml']
    ports: ['3000:3000']
```

`tempo.yaml`:

```yaml
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318
storage:
  trace:
    backend: local
    local: { path: /var/tempo/traces }
    wal: { path: /var/tempo/wal }
```

`grafana-datasources.yaml`:

```yaml
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    isDefault: true
```

`docker compose up`, then open Grafana at `http://localhost:3000` → Explore → Tempo and search by service name (`sales-bot`) or by span name (`bot.send`, `chat claude-…`). Tempo only takes traces: for the metrics, add a Prometheus with its OTLP receiver (`--web.enable-otlp-receiver`, OTLP path `/api/v1/otlp/v1/metrics`) or an OpenTelemetry Collector in front of both. Pin the image versions in production.

## What a message looks like

```
bot.inbound                      consumer · bot.event.kind=message · bot.inbound.outcome=dispatched
├─ bot.persist                   chat / contact / message writes
└─ bot.dispatch                  bot.queue.wait_ms · bot.dispatch.stage=matcher
   └─ bot.handler                bot.handler.stage=matcher · bot.matcher.kind=text · bot.flow.id=order
      └─ bot.conversation.turn   bot.conversation.reason=start · parked=true
         ├─ chat claude-…        gen_ai.* (model, tokens, finish reason)
         │  └─ (http span of the SDK call, from the SDK's own instrumentation)
         ├─ execute_tool lookup  bot.ai.tool.outcome=ok
         └─ bot.pace             delay + typing
            └─ bot.send          client · bot.send.outcome=ok
               └─ (http span of the provider call)
```

The user's answer arrives as another message: its own `bot.inbound` → `bot.dispatch` (stage `conversation`) with the **next** turn of the same conversation (`bot.conversation.id` is the same) as a child.

### Span catalogue

| Span | Kind | Where |
| --- | --- | --- |
| `bot.inbound` | consumer | A message, interaction or call event from the provider (connection, presence and status events have no span). Parent: the active OpenTelemetry context, e.g. the HTTP span of a webhook. |
| `bot.persist` | internal | Chat, contact and message writes of an inbound message (`spans.persist`). |
| `bot.dispatch` | internal | The message's job in the chat's FIFO queue, once its turn came. |
| `bot.handler` | internal | Each handler the dispatcher runs: command, matcher, catch-all, event (call) trigger. |
| `bot.conversation.turn` | internal | A stretch of a conversation between two waits (see below). |
| `bot.trigger` / `bot.broadcast` | internal | `bot.trigger()` / `bot.broadcast()`. |
| `bot.pace` | internal | A paced reply: delay + typing indicator + its send (`spans.pace`). |
| `bot.send` | client | Every send and edit through the outbound pipeline. The provider call runs inside it. |
| `bot.stream.update` | client | A `ctx.stream()` draft/edit — only with `spans.streamUpdates`; otherwise an event on the active span. |
| `chat {model}` | client | A model call from `@bot-wa/ai` (OpenTelemetry GenAI conventions). |
| `execute_tool {name}` | internal | A tool call of the AI tool loop. |
| `bot.ai.retrieve` | internal | RAG retrieval (`bot.ai.rag.chunks`). |
| `bot.task` | internal | One run of a scheduled task (`bot.schedule`/`every`/`delay`, plain or durable). Always a **root** span; the task's sends nest under it. See [Scheduled tasks](#scheduled-tasks). |

### Attributes

| Attribute | On | Values |
| --- | --- | --- |
| `bot.provider.id`, `bot.id` | inbound, send | Provider id, bot id of the store namespace. |
| `bot.event.kind`, `bot.message.type`, `bot.chat.kind` | inbound, dispatch | `message`/`interaction`/`call`; `text`, `image`…; `private`/`group`. |
| `bot.chat.id`, `bot.sender.id`, `bot.message.id` | inbound, send | Through the [ids policy](#personal-data). |
| `bot.inbound.outcome` | inbound | `dispatched`, `blocked`, `duplicate`, `group_filtered`, `stopped`, `from_me`, `handoff` (calls). |
| `bot.queue.wait_ms` | dispatch | Time waiting for the chat's turn (includes the cross-replica turn with coordination). |
| `bot.dispatch.stage` | dispatch | `aborted_by_hook`, `handoff`, `command`, `command_unknown`, `conversation`, `dormant`, `matcher`, `catch_all`, `unhandled`, `event`. |
| `bot.handler.stage`, `bot.matcher.kind` | handler | `command`/`matcher`/`catch_all`/`event`; `welcome`/`text`/`function`/`type`. |
| `bot.command.name` | handler | Only for a **registered** command (unknown command text is never recorded). |
| `bot.flow.id` | handler | The flow/conversation a matcher enters. |
| `bot.conversation.id`, `.name`, `.reason`, `.parked`, `.outcome`, `.goto` | turn | See below. |
| `bot.send.outcome`, `bot.content.kind`, `bot.send.origin`, `bot.send.edit` | send | `ok`, `failed`, `skipped`, `deduplicated` (durable outbox), `deferred`; `text`, `image`…; `ctx`/`api`. |
| `bot.task.id`, `.kind`, `.durable`, `.cron`, `.interval_ms`, `.time_zone` | task | Task id (through the [ids policy](#personal-data)), `cron`/`interval`/`once`, durable or not, its spec. |
| `bot.task.scheduled_at`, `.missed`, `.fencing_token`, `bot.scheduler.role`, `bot.scheduler.owner` | task (durable) | The slot (ISO 8601), whether it runs late, the claim's fencing token, `leader`/`follower`/`single`, the replica's scheduler owner. |
| `bot.link.reason` | span link | `resume`: the link of a conversation resumed from a checkpoint to the turn that wrote it. |
| `error.type` | any failed span | The error class name (`RateLimitedError`, `timeout`…). |

Every name is exported as `TRACE_ATTR` / `SPAN_NAMES` from `@bot-wa/core`.

### Conversation turns

A conversation can last days, so it is not one span. Each stretch of work between two waits is a `bot.conversation.turn`:

- the first turn starts under the handler (or `bot.trigger`) that entered it — `reason: start` or `dormant` (a persistent flow resumed from its checkpoint); a `c.goto()` target starts under the turn that ran the goto — `reason: goto`;
- parking on a wait ends the turn with `bot.conversation.parked = true`;
- a reply opens the next turn under the dispatch span of the message that answered — `reason: reply`;
- a wait timeout opens a **root** turn linked to the first one — `reason: timeout`, since no message caused it; a `c.idle()` callback that fires while the conversation is parked runs in a root turn too (`reason: idle`), which parks again when the callback only replied, or carries the outcome when it ended or redirected the conversation;
- an error thrown by the conversation (or by an idle callback) is recorded on the turn it happened in;
- a conversation resumed from a checkpoint written by **another replica or an earlier process** (a persistent flow after a restart, a flow forwarded by `coordination.handover`, a hand-over stub restarted with `fallback: 'restart'`) starts under the dispatch of the waking message and is **linked** to the turn that wrote the checkpoint — see [Across replicas and restarts](#across-replicas-and-restarts);
- the end of the conversation sets `bot.conversation.outcome` (`completed`, `ended`, `guarded`, `cancelled`, `timedOut`, `retriesExceeded`, `error`) on the open turn; a conversation aborted while parked (`/reset`, handoff, `stop()`) gets a short closing turn (`reason: end`).

Flow steps are `flow.step` events on the turn (`bot.flow.step.index`, `bot.flow.step.kind`).

### Across replicas and restarts

With telemetry on, every checkpoint a conversation writes (persistent flows, ephemeral checkpoints of `handover.flows: 'forward'`, hand-over stubs) also stores the **W3C trace context** of the turn that wrote it, in `FlowCheckpoint.trace` (`{ traceparent, tracestate? }`; stores keep it opaquely, like the rest of the checkpoint). The replica — or the restarted process — that resumes the conversation gives its first turn (`reason: dormant`, or `start` for a stub restarted by `fallback: 'restart'`) a **span link** to that context, marked `bot.link.reason = resume` and `isRemote`, with the `tracestate` restored.

**Link, not parent** (deliberate): the resumed turn's parent stays the `bot.dispatch` of the message that woke it, so that message's trace (inbound → dispatch → turn → sends) is whole; making the previous replica's span its parent would cut the waking message's trace in two, and a conversation parked for hours would stretch one trace across processes and exports that were flushed long ago. Your backend shows the link as "follows from" and lets you jump to the earlier trace.

Notes:

- Only W3C-shaped ids are carried (32/16 lowercase hex, which OpenTelemetry produces). A tracer with other ids stores nothing and the turn simply has no link. A malformed stored value is ignored.
- A custom `handover.fallback` function receives the context in `info.trace`, to link spans of its own.
- `formatTraceparent(spanContext)` and `parseTraceparent(traceparent, tracestate?)` are exported from `@bot-wa/core` for your own propagation.

### Scheduled tasks

Each run of a task registered with `bot.schedule()`, `bot.every()` or `bot.delay()` is a `bot.task` span: plain in-memory tasks per run, durable tasks per occurrence (one span per slot of a catch-up). The span is always a **root** span — a task has no causing message, even when it was registered inside a handler — and the handler's sends and AI calls nest under it. A throwing handler sets status error with `error.type`, as anywhere else.

Durable occurrences add the slot (`bot.task.scheduled_at`), `bot.task.missed`, the claim's `bot.task.fencing_token`, and leadership: `bot.scheduler.role` is `leader` (this replica holds the scheduler lease), `follower` (it stepped in for an occurrence the leader left overdue) or `single` (no lease configured), plus `bot.scheduler.owner` (`scheduler.owner`, a random id per process by default). Task ids go through the [ids policy](#personal-data) (hashed by default), since durable ids often embed a user or chat id. The bot's internal timers (per-chat `onIdle` watchers) are not task spans.

### AI spans

`aiPlugin` passes `bot.tracing` to its `AIClient`, so with telemetry on every model call is a `chat {model}` span (kind client) with `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.request.max_tokens`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` and `bot.ai.purpose` (`reply`, `ask`, `generate`, `memory`, `tool_step`). A timeout is status error with `error.type = timeout`; a refusal is `finish_reasons = [refusal]` with the status unset. Streams are one span from the first chunk to the end (`bot.ai.streamed`, `bot.ai.cancelled` when stopped early); Anthropic and Gemini report streamed token usage, OpenAI-compatible and Ollama do not.

Tool calls are `execute_tool {name}` spans with `gen_ai.tool.name`, `gen_ai.tool.call.id` and `bot.ai.tool.outcome` (`ok`, `error`, `timeout`, `invalid_args`, `unknown`, `duplicate`, `confirm.denied`, `confirm.replied`, `confirm.cancelled`). A tool waiting for the user's confirmation keeps its span open (with a `confirm.requested` event) until it is answered.

A standalone `AIClient` traces only when you pass `tracing` (e.g. `bot.tracing`) in its options.

## Your own spans

`bot.tracing` is the bot's tracing facade (a disabled no-op without telemetry). Spans you start inside a handler nest under the bot's:

```ts
bot.when('order', async (ctx) => {
  const order = await bot.tracing.trace('erp.lookup', { kind: 'client' }, () => erp.find(ctx.body))
  await ctx.reply(`Order ${order.id}`)
})
```

With `@bot-wa/otel`, bot spans are also the active OpenTelemetry context, so `tracer.startActiveSpan()` and the SDK's auto-instrumentations (http, undici, pg…) nest under them too. Plugins use `ctx.bot.tracing` the same way; `bot.tracing.idAttribute(id)` applies the ids policy to an id of your own.

## Metrics

`otelMetricsPlugin()` (or `await registerOtelMetrics(bot)`) reads `bot.metrics()` on every collection:

| Metric | Type | Attributes |
| --- | --- | --- |
| `botwa.messages.inbound` | counter | |
| `botwa.messages.outbound` | counter | `result` = `ok`/`failed` |
| `botwa.dropped` | counter | `reason` = `duplicate`/`blocked`/`handoff` |
| `botwa.conversations.started` / `.ended` | counter | `outcome` (ended) |
| `botwa.flow.conversations.started` / `.ended` | counter | `flow`, `outcome` (`perFlow`) |
| `botwa.triggered`, `botwa.errors` | counter | |
| `botwa.conversations.active`, `botwa.uptime` (s) | gauge | |
| `botwa.conversation.duration` (s) | histogram | `flow`, `outcome` |

Every point carries `bot.id` plus your `attributes`. `bot.resetMetrics()` makes the cumulative counters drop, which OpenTelemetry and Prometheus treat as a counter reset.

The tracer also derives histograms from finished spans (`spanMetrics`, on by default), recorded even for unsampled traces: `botwa.inbound.duration{bot.event.kind, bot.inbound.outcome, bot.provider.id}`, `botwa.dispatch.duration{bot.dispatch.stage}`, `botwa.queue.wait`, `botwa.send.duration{bot.provider.id, bot.send.outcome}`, `gen_ai.client.operation.duration` and `gen_ai.client.token.usage{gen_ai.token.type}`. No metric ever carries a chat, user or message id.

## Personal data

- **Never recorded**: message bodies, captions, prompts, completions, tool arguments and results, `c.state`, ask answers, unknown command text, raw provider payloads.
- **Error messages** may contain user text: only the error class and code are recorded unless you set `telemetry.errorMessages: true`.
- **Ids** follow `telemetry.ids`:
  - `'hash'` (default): HMAC-SHA256, base64url, 16 characters. The key is `telemetry.idKey`; without it a random key per process is used, so hashes do not correlate across replicas or restarts. Set the same secret everywhere to search a chat's traces.
  - `'raw'`: the id as the provider gives it — on WhatsApp that is a phone number, personal data.
  - `'omit'`: no ids at all.

## Configuration

```ts
new Bot({
  telemetry: {
    tracer,                          // BotTracer (required)
    ids: 'hash',                     // 'hash' | 'raw' | 'omit'
    idKey: process.env.TRACE_ID_KEY, // string | Uint8Array
    errorMessages: false,
    spans: { persist: true, pace: true, streamUpdates: false },
  },
})
```

| `@bot-wa/otel` option | Default | |
| --- | --- | --- |
| `tracerProvider` | global (`trace.getTracerProvider()`) | |
| `tracerName` | `'@bot-wa/otel'` | Instrumentation scope. |
| `spanMetrics` | `true` | `false`, or `{ meterProvider, prefix }`. |
| `otelMetricsPlugin({ meterProvider, prefix, attributes, perFlow, conversationDuration })` | global, `'botwa'`, `{}`, `true`, `true` | |

### Sampling

Sample at the root with a parent-based sampler (`new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.1) })` in the `NodeSDK` options): a message's spans share its decision. When a span is not recorded, the core skips its id hashing. The span-derived histograms are recorded anyway, so latency dashboards stay complete at any sampling rate.

## Other backends and tests

`BotTracer` is deliberately small: `startSpan(name, options)` returning a span with `setAttribute(s)`, `addEvent`, `recordException`, `setStatus`, `end`, `isRecording` and `spanContext`, plus an optional `withSpan(span, fn)` to make a span the backend's active context. Any tracing library can implement it. A tracer that throws never breaks the bot: the call falls back to a no-op span and a warning is logged at most once a minute.

In tests, `createRecordingTracer()` from `@bot-wa/core/testing` records every span in memory:

```ts
import { createRecordingTracer, createTestBot } from '@bot-wa/core/testing'

const rec = createRecordingTracer()
const { bot, chat } = await createTestBot({ telemetry: { tracer: rec.tracer, ids: 'raw' } })
bot.when('hi', (ctx) => ctx.reply('hello'))
await chat.send('hi')
expect(rec.parentOf(rec.find('bot.send')!)?.name).toBe('bot.pace')
```

## Limitations

- **Durable replays**: an inbound record replayed by the durability engine (after a crash or a retry) has no `bot.inbound` span; its `bot.dispatch` is a root span.
- **Multi-replica**: a conversation resumed on another replica (or after a restart) starts a new trace **linked** to the previous one, not a continuation of it (see [Across replicas and restarts](#across-replicas-and-restarts)). A conversation handed over before telemetry was enabled, or by a replica without it, has no link.
- **Third-party OpenTelemetry spans inside a resumed conversation** (code after `await c.ask()`) parent to OpenTelemetry's own context, which is still the first turn's; the bot's own spans parent correctly.
- Flushing is the SDK's job: call `sdk.shutdown()` after `bot.stop()`.
